/**
 * The database side of the lead mirror: reading what is there, and applying a plan.
 *
 * Runs under the service role, which bypasses row level security. That is the only
 * way a function with no user session can write at all, and it is also why every
 * read here filters on owner_id explicitly and every write sets it. With the
 * service role there is no auth.uid(), so a query that forgot the owner would
 * quietly reconcile somebody else's pipeline into this one.
 *
 * WHAT THIS FILE WILL NOT DO
 *
 * There is no delete. Not for leads, not for activities, not for tasks. A row
 * missing from the spreadsheet is not evidence that the row is wrong, and the
 * reconciliation is explicitly required to preserve everything in Supabase that
 * the Sheet does not mention. The only way to remove something is by hand.
 *
 * Updates are patches built from a plan, and the plan only ever contains fields
 * the Sheet actually had a value for, so a blank cell cannot blank a column. See
 * leadChanges in server/integrations/leadMirror.ts.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  dayToTimestamp, EXISTING_LEAD_COLUMNS, MIRROR_SOURCE, type ExistingActivity,
  type ExistingLead, type ReconciliationPlan,
} from '../../../server/integrations/leadMirror.ts';
import type {
  ExportLead, ExportTouch, KeyAssignment,
} from '../../../server/integrations/leadMirrorExport.ts';
import type { SyncStatus } from '../../../server/integrations/types.ts';

/** Small enough to retry cheaply, large enough that 21 rows is one request. */
const CHUNK = 200;

function chunked<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ reading --- */

/**
 * Every lead this owner has, with every column the Sheet owns.
 *
 * All leads, not just the ones carrying a mirror key: matching on email or on
 * contact and organization has to be able to see a lead typed in by hand or
 * created by a future AI tool call, or the reconciliation would create a second
 * copy of somebody who is already there.
 *
 * And every comparable column, not just the four matching uses. A column left out
 * of this select reads as absent to leadChanges, absent differs from every value,
 * and the run would report an update for every lead on every attempt forever. The
 * column list lives next to the type in leadMirror.ts so the two cannot drift.
 */
export async function fetchExistingLeads(
  client: SupabaseClient,
  ownerId: string,
): Promise<ExistingLead[]> {
  const { data, error } = await client
    .from('leads')
    .select(EXISTING_LEAD_COLUMNS.join(', '))
    .eq('owner_id', ownerId);

  if (error) throw new Error(`leads read failed: ${error.message}`);
  return (data ?? []) as unknown as ExistingLead[];
}

/** The external keys of activities this integration has already imported. */
export async function fetchMirrorActivities(
  client: SupabaseClient,
  ownerId: string,
): Promise<ExistingActivity[]> {
  const { data, error } = await client
    .from('activity_events')
    .select('external_source, external_id')
    .eq('owner_id', ownerId)
    .eq('external_source', MIRROR_SOURCE);

  if (error) throw new Error(`activity_events read failed: ${error.message}`);
  return (data ?? []) as ExistingActivity[];
}

/* ------------------------------------------------------------------ writing --- */

export interface ApplyResult {
  leadsCreated: number;
  leadsUpdated: number;
  touchesCreated: number;
  /** Lead key to the id it ended up with, including the ones just created. */
  idByKey: Map<string, string>;
}

/**
 * Apply a plan: insert the new leads, patch the matched ones, insert the touches.
 *
 * Leads go first and in full, because a touch cannot be linked until its lead has
 * an id. A touch whose lead was not created or matched is skipped rather than
 * inserted with a null lead_id: an entry in a relationship history with nobody
 * attached to it is worse than a missing entry, because it looks like a record.
 *
 * Inserting the touches uses ignoreDuplicates against the unique external-key
 * index from migration 0007. That is the belt to the plan's braces: the plan
 * already knows which touches exist, and if it were ever wrong the database would
 * still refuse to write a second copy.
 */
export async function applyPlan(
  client: SupabaseClient,
  ownerId: string,
  plan: ReconciliationPlan,
): Promise<ApplyResult> {
  const idByKey = new Map<string, string>();

  for (const entry of plan.leads) {
    if (entry.action === 'ambiguous') continue;
    if (entry.leadId !== null) idByKey.set(entry.row.leadKey, entry.leadId);
  }

  /* --- new leads ------------------------------------------------------- */

  const toCreate = plan.leads.filter((entry) => entry.action === 'create');
  let leadsCreated = 0;

  for (const batch of chunked(toCreate)) {
    const payload = batch.map((entry) => ({
      owner_id: ownerId,
      external_source: MIRROR_SOURCE,
      external_key: entry.row.leadKey,
      ...entry.fields,
      is_seed: false,
    }));

    const { data, error } = await client
      .from('leads')
      .insert(payload)
      .select('id, external_key');

    if (error) throw new Error(`leads insert failed: ${error.message}`);

    for (const row of (data ?? []) as { id: string; external_key: string | null }[]) {
      if (row.external_key !== null) idByKey.set(row.external_key, row.id);
      leadsCreated += 1;
    }
  }

  /* --- matched leads --------------------------------------------------- */

  const toUpdate = plan.leads.filter((entry) => entry.action === 'update');
  let leadsUpdated = 0;

  for (const entry of toUpdate) {
    // Only the fields the plan said would change, so a column the Sheet left
    // blank is never written at all.
    const patch: Record<string, unknown> = {};
    for (const change of entry.changes) patch[change.field] = change.to;
    // Claiming the key is what makes the next run cheap.
    patch.external_source = MIRROR_SOURCE;
    patch.external_key = entry.row.leadKey;

    const { error } = await client
      .from('leads')
      .update(patch)
      .eq('id', entry.leadId as string)
      .eq('owner_id', ownerId);

    if (error) throw new Error(`leads update failed: ${error.message}`);
    leadsUpdated += 1;
    idByKey.set(entry.row.leadKey, entry.leadId as string);
  }

  /* --- touches --------------------------------------------------------- */

  const toInsert = plan.touches
    .filter((touch) => touch.action === 'create')
    .filter((touch) => idByKey.has(touch.row.leadKey));

  let touchesCreated = 0;

  for (const batch of chunked(toInsert)) {
    const payload = batch.map((touch) => ({
      owner_id: ownerId,
      occurred_at: dayToTimestamp(touch.row.occurredOn),
      activity_type: touch.row.activityType,
      // The sheet's own wording, so nothing a person wrote is lost to a mapping.
      title: touch.row.activityLabel,
      details: touch.row.details,
      source: 'import',
      external_source: MIRROR_SOURCE,
      external_id: touch.row.externalId,
      channel: touch.row.channel,
      evidence_source: touch.row.evidenceSource,
      lead_id: idByKey.get(touch.row.leadKey) as string,
      content_item_id: null,
      task_id: null,
      is_seed: false,
    }));

    const { data, error } = await client
      .from('activity_events')
      .upsert(payload, {
        // The index from migration 0007. ignoreDuplicates, because a touch that
        // is already there is already correct and must not be rewritten.
        onConflict: 'owner_id,external_source,external_id',
        ignoreDuplicates: true,
      })
      .select('id');

    if (error) throw new Error(`activity_events insert failed: ${error.message}`);
    touchesCreated += (data ?? []).length;
  }

  return { leadsCreated, leadsUpdated, touchesCreated, idByKey };
}

/* ------------------------------------------------------------- the export --- */

interface FollowUpStateRow {
  lead_id: string;
  owner_id: string;
  effective_last_touch_on: string | null;
  days_since_touch: number | null;
  follow_up_status: string;
}

/**
 * Every lead plus its derived follow-up state, as at a given day.
 *
 * The derivation comes from lead_follow_up_state in the database rather than being
 * recomputed here, so the spreadsheet cannot disagree with the Pipeline screen
 * about how long somebody has been waiting. The date is a parameter all the way
 * down, which is what makes the whole path testable.
 */
export async function fetchExportLeads(
  client: SupabaseClient,
  ownerId: string,
  asOf: string,
): Promise<ExportLead[]> {
  const { data: leadRows, error: leadError } = await client
    .from('leads')
    .select(
      'id, external_key, prospect_name, organization, relationship, stage, current_status,' +
        ' source, first_contact_at, next_action, next_action_date, follow_up_mode,' +
        ' preferred_channel, email, phone, proposed_value, notes, record_confidence',
    )
    .eq('owner_id', ownerId);

  if (leadError) throw new Error(`leads read failed: ${leadError.message}`);

  const { data: stateRows, error: stateError } = await client
    .rpc('lead_follow_up_state', { as_of: asOf })
    // The service role bypasses row level security, so the owner filter is the
    // only thing keeping this to one person's pipeline.
    .eq('owner_id', ownerId);

  if (stateError) throw new Error(`lead_follow_up_state read failed: ${stateError.message}`);

  const stateById = new Map<string, FollowUpStateRow>();
  for (const row of (stateRows ?? []) as FollowUpStateRow[]) {
    stateById.set(row.lead_id, row);
  }

  return (leadRows ?? []).map((lead) => {
    const base = lead as Record<string, unknown>;
    const state = stateById.get(base.id as string);
    return {
      ...(base as unknown as Omit<
        ExportLead,
        'effective_last_touch_on' | 'days_since_touch' | 'follow_up_status'
      >),
      effective_last_touch_on: state?.effective_last_touch_on ?? null,
      days_since_touch: state?.days_since_touch ?? null,
      // A lead with no state row should be impossible: the function is a left
      // join over leads. If it ever happens, say nothing rather than guess.
      follow_up_status: state?.follow_up_status ?? '',
    };
  });
}

/** Every lead-linked activity, for the Touch History tab. */
export async function fetchExportTouches(
  client: SupabaseClient,
  ownerId: string,
): Promise<ExportTouch[]> {
  const { data, error } = await client
    .from('activity_events')
    .select('lead_id, occurred_at, title, channel, details, evidence_source, activity_type')
    .eq('owner_id', ownerId)
    .not('lead_id', 'is', null);

  if (error) throw new Error(`activity_events read failed: ${error.message}`);
  return (data ?? []) as ExportTouch[];
}

/**
 * Write back the mirror keys the export had to invent.
 *
 * A lead created in the Cockpit has no Sheet key, and the mirror needs one for its
 * Lead ID column. Persisting it is what makes the key stable: without this, every
 * export would recompute it, and a lead renamed in the Cockpit would silently get
 * a new Lead ID and lose the link to its own touch history on the next import.
 *
 * Additive only. It fills a column that was null and never overwrites a key that
 * already exists.
 */
export async function persistAssignedKeys(
  client: SupabaseClient,
  ownerId: string,
  assignments: readonly KeyAssignment[],
): Promise<number> {
  let written = 0;

  for (const assignment of assignments) {
    const { error } = await client
      .from('leads')
      .update({ external_source: MIRROR_SOURCE, external_key: assignment.externalKey })
      .eq('id', assignment.leadId)
      .eq('owner_id', ownerId)
      .is('external_key', null);

    if (error) throw new Error(`leads key assignment failed: ${error.message}`);
    written += 1;
  }

  return written;
}

/* -------------------------------------------------------------- run records --- */

export interface MirrorRunRecord {
  ownerId: string;
  connectionId: string | null;
  idempotencyKey: string;
  startedAt: string;
  completedAt: string | null;
  status: SyncStatus;
  rowsRead: number | null;
  rowsWritten: number | null;
  errorSummary: string | null;
  details: Record<string, unknown>;
}

/**
 * Record an attempt, successful or not.
 *
 * Keyed so that a re-run of the same logical operation on the same day updates its
 * row rather than growing the table. What a run did is as much part of the record
 * as that it happened: the counts land in details, already sanitized, because the
 * signed-in owner can read this column.
 */
export async function saveMirrorRun(
  client: SupabaseClient,
  run: MirrorRunRecord,
): Promise<void> {
  const { error } = await client.from('sync_runs').upsert(
    {
      owner_id: run.ownerId,
      connection_id: run.connectionId,
      provider: 'google_sheets',
      started_at: run.startedAt,
      completed_at: run.completedAt,
      status: run.status,
      rows_read: run.rowsRead,
      rows_written: run.rowsWritten,
      error_summary: run.errorSummary,
      idempotency_key: run.idempotencyKey,
      details: run.details,
    },
    { onConflict: 'owner_id,idempotency_key', ignoreDuplicates: false },
  );

  if (error) throw new Error(`sync_runs upsert failed: ${error.message}`);
}
