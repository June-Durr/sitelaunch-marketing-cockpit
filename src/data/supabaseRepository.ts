/**
 * Supabase adapter. Selected automatically when VITE_SUPABASE_URL and
 * VITE_SUPABASE_ANON_KEY are set. Assumes supabase/migrations/0001_init.sql has
 * been applied; owner_id defaults to auth.uid() and RLS scopes every read.
 */

import type { Dataset } from '../types/domain';
import type {
  AnalyticsProvider, AnalyticsStatus, CalendarDisconnectOutcome, CalendarOAuthStart,
  CaptureInput, CaptureOutcome, CompletionInput, CompletionOutcome,
  ConversationInput, ConversationOutcome, DraftOutcome, UndoOutcome, UndoStatus,
  CalendarStatus, CalendarSyncOutcome,
  ImportReport, LeadMirrorAction, LeadMirrorOutcome, LeadMirrorStatus, NewRow,
  ReconcileMode, Repository, RowPatch, SyncMode, SyncTriggerOutcome, TableMap,
  TableName,
} from './repository';
import { IMPORT_ORDER } from './repository';
import type {
  Ga4DailyTraffic, IntegrationConnection, SearchConsoleDaily, SyncRun,
} from '../types/integrations';
import { functionsBaseUrl, getSupabase } from './supabaseClient';
import type { ExtractedFact, MessageDraft } from '../types/assistant';
import type { AiUsageSummary, AssistantAnswer, AssistantRequest } from '../assistant/wire';

/** Table name -> its array in the in-memory Dataset. */
const TABLE_TO_COLLECTION: Record<TableName, keyof Dataset> = {
  accounts: 'accounts',
  content_items: 'contentItems',
  performance_snapshots: 'snapshots',
  traffic_snapshots: 'traffic',
  leads: 'leads',
  tasks: 'tasks',
  recommendations: 'recommendations',
  activity_events: 'activityEvents',
};

/** PostgREST takes one request per call, so long tables go up in batches. */
const IMPORT_BATCH_SIZE = 200;

/**
 * Every column holding another row's id, per table.
 *
 * These are what an id rewrite has to follow. Miss one and the row still imports,
 * but the link it carried is quietly broken, which is worse than a failed import
 * because nothing announces it.
 */
const REFERENCE_FIELDS: Record<TableName, string[]> = {
  accounts: [],
  content_items: ['account_id', 'cross_post_group_id'],
  performance_snapshots: ['content_item_id'],
  traffic_snapshots: ['content_item_id'],
  leads: ['content_item_id'],
  tasks: ['content_item_id', 'lead_id'],
  recommendations: [],
  activity_events: ['content_item_id', 'lead_id', 'task_id'],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function newUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Only reached on a runtime without the Web Crypto API. Version 4 shape.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Old id -> new id, for every id in the dataset that Postgres would refuse.
 *
 * Browser-local mode accepts any string as an id, and the seed records use
 * readable ones like "acc-instagram-0001". Every id column in the database is a
 * uuid, so those have to be rewritten. The rewrite is done once, up front, for
 * the whole dataset, so an id and every reference to it always change together.
 * Ids that are already uuids are left exactly as they are.
 */
export function buildIdMap(data: Dataset): Map<string, string> {
  const map = new Map<string, string>();
  const consider = (value: unknown) => {
    if (typeof value !== 'string' || value === '' || UUID_RE.test(value)) return;
    if (!map.has(value)) map.set(value, newUuid());
  };

  for (const table of IMPORT_ORDER) {
    const rows = (data[TABLE_TO_COLLECTION[table]] ?? []) as unknown as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      consider(row.id);
      // Group ids are uuids in the database but name no row, so they are collected
      // here rather than from any table's primary key.
      for (const field of REFERENCE_FIELDS[table]) consider(row[field]);
    }
  }
  return map;
}

/**
 * owner_id is never sent. The column defaults to auth.uid() and the row level
 * security policy checks it on the way in, so letting the database fill it is
 * both simpler and the only version that cannot write a row under the wrong
 * account. A backup that somehow carries the field has it stripped here.
 */
export function forImport(
  table: TableName,
  row: Record<string, unknown>,
  idMap: Map<string, string>,
): Record<string, unknown> {
  const { owner_id: _ignored, ...rest } = row;
  const id = rest.id;
  if (typeof id === 'string' && idMap.has(id)) rest.id = idMap.get(id);
  for (const field of REFERENCE_FIELDS[table]) {
    const value = rest[field];
    if (typeof value === 'string' && idMap.has(value)) rest[field] = idMap.get(value);
  }
  return rest;
}

export function createSupabaseRepository(): Repository {
  const db = getSupabase();

  async function selectAll<K extends TableName>(
    table: K,
    orderBy: { column: string; ascending: boolean },
  ): Promise<TableMap[K][]> {
    const { data, error } = await db
      .from(table)
      .select('*')
      .order(orderBy.column, { ascending: orderBy.ascending, nullsFirst: false });
    if (error) throw new Error(`${table}: ${error.message}`);
    return (data ?? []) as TableMap[K][];
  }

  return {
    mode: 'supabase',

    async loadAll(): Promise<Dataset> {
      const [
        accounts, contentItems, snapshots, traffic, leads, tasks, recommendations,
        activityEvents,
      ] = await Promise.all([
        selectAll('accounts', { column: 'created_at', ascending: true }),
        selectAll('content_items', { column: 'published_at', ascending: false }),
        selectAll('performance_snapshots', { column: 'captured_at', ascending: false }),
        selectAll('traffic_snapshots', { column: 'range_start', ascending: false }),
        selectAll('leads', { column: 'created_at', ascending: false }),
        selectAll('tasks', { column: 'due_date', ascending: true }),
        selectAll('recommendations', { column: 'generated_at', ascending: false }),
        selectAll('activity_events', { column: 'occurred_at', ascending: false }),
      ]);
      return {
        accounts, contentItems, snapshots, traffic, leads, tasks, recommendations,
        activityEvents,
      };
    },

    async insert<K extends TableName>(table: K, row: NewRow<K>) {
      const { data, error } = await db.from(table).insert(row).select().single();
      if (error) throw new Error(`${table}: ${error.message}`);
      return data as TableMap[K];
    },

    async insertMany<K extends TableName>(table: K, rows: NewRow<K>[]) {
      if (rows.length === 0) return [];
      const { data, error } = await db.from(table).insert(rows).select();
      if (error) throw new Error(`${table}: ${error.message}`);
      return (data ?? []) as TableMap[K][];
    },

    async update<K extends TableName>(table: K, id: string, patch: RowPatch<K>) {
      const { data, error } = await db
        .from(table)
        // The generic patch type cannot narrow to one table's row shape here; the
        // Repository interface has already constrained the keys to that table.
        .update(patch as Record<string, unknown>)
        .eq('id', id)
        .select()
        .single();
      if (error) throw new Error(`${table}: ${error.message}`);
      return data as TableMap[K];
    },

    async remove<K extends TableName>(table: K, id: string) {
      const { error } = await db.from(table).delete().eq('id', id);
      if (error) throw new Error(`${table}: ${error.message}`);
    },

    countAll,

    async importDataset(data: Dataset): Promise<ImportReport> {
      const inserted = Object.fromEntries(
        IMPORT_ORDER.map((t) => [t, 0]),
      ) as Record<TableName, number>;

      // Refuse before writing anything if the account already holds data. This is
      // the guarantee that makes the import safe to run: an import that cannot
      // start cannot half-finish.
      const existing = await countAll();
      const blockedBy = IMPORT_ORDER.filter((t) => existing[t] > 0).map((table) => ({
        table,
        existing: existing[table],
      }));
      if (blockedBy.length > 0) {
        return { inserted, blockedBy, failure: null, rolledBack: null, remappedIds: 0 };
      }

      // Rewrite any id Postgres would refuse, once, for the whole dataset.
      const idMap = buildIdMap(data);

      // Ids of what this import wrote, so a failure can be undone precisely.
      const written: { table: TableName; ids: string[] }[] = [];

      for (const table of IMPORT_ORDER) {
        const rows = (data[TABLE_TO_COLLECTION[table]] ?? []) as unknown as Record<
          string,
          unknown
        >[];
        if (rows.length === 0) continue;

        const ids: string[] = [];
        try {
          for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
            const batch = rows
              .slice(i, i + IMPORT_BATCH_SIZE)
              .map((row) => forImport(table, row, idMap));
            const { data: created, error } = await db.from(table).insert(batch).select('id');
            if (error) throw new Error(error.message);
            for (const row of created ?? []) ids.push((row as { id: string }).id);
            inserted[table] = ids.length;
          }
          written.push({ table, ids });
        } catch (err) {
          // Partway through. Put the database back to the empty state it was in,
          // newest table first so children go before the parents they point at.
          written.push({ table, ids });
          const rolledBack = await undo(written);
          return {
            inserted,
            blockedBy: [],
            failure: {
              table,
              message: err instanceof Error ? err.message : String(err),
            },
            rolledBack,
            remappedIds: idMap.size,
          };
        }
      }

      return {
        inserted,
        blockedBy: [],
        failure: null,
        rolledBack: null,
        remappedIds: idMap.size,
      };
    },

    /**
     * What the automatic sync has been doing.
     *
     * Row level security limits every one of these to this account, and none of
     * these tables has a token column, so there is nothing here the browser
     * should not see. A table that has not been created yet is reported as empty
     * rather than as an error, so a project that has not applied migration 0005
     * still loads the rest of the screen.
     */
    async loadAnalytics(): Promise<AnalyticsStatus> {
      const [connections, runs, ga4, searchConsole] = await Promise.all([
        selectOptional<IntegrationConnection>(
          'integration_connections', 'provider', true, 50,
        ),
        selectOptional<SyncRun>('sync_runs', 'started_at', false, 50),
        selectOptional<Ga4DailyTraffic>('ga4_daily_traffic', 'date', false, 2000),
        selectOptional<SearchConsoleDaily>('search_console_daily', 'date', false, 2000),
      ]);
      return { connections, runs, ga4, searchConsole };
    },

    /**
     * The lead mirror's own connection row and its last few runs.
     *
     * Read only, and scoped to this provider so the panel does not pay for the
     * analytics tables it never shows. A project that has not applied migration
     * 0007 yet reports as empty rather than as an error, so the Data screen still
     * loads.
     */
    async loadLeadMirror(): Promise<LeadMirrorStatus> {
      const [connections, runs] = await Promise.all([
        selectOptionalWhere<IntegrationConnection>(
          'integration_connections', 'provider', 'google_sheets', 'updated_at', false, 1,
        ),
        selectOptionalWhere<SyncRun>(
          'sync_runs', 'provider', 'google_sheets', 'started_at', false, 20,
        ),
      ]);
      return { connection: connections[0] ?? null, runs };
    },

    /**
     * The follow-up calendar's own connection row and its last few runs.
     *
     * Scoped to this provider, so the panel does not pay for tables it never
     * shows. A project without migration 0005 applied reports as empty rather
     * than as an error.
     */
    async loadCalendar(): Promise<CalendarStatus> {
      const [connections, runs] = await Promise.all([
        selectOptionalWhere<IntegrationConnection>(
          'integration_connections', 'provider', 'google_calendar', 'updated_at', false, 1,
        ),
        selectOptionalWhere<SyncRun>(
          'sync_runs', 'provider', 'google_calendar', 'started_at', false, 20,
        ),
      ]);
      return { connection: connections[0] ?? null, runs };
    },

    /**
     * Ask the server to put the open follow-ups on the calendar.
     *
     * Sends this browser's session and nothing else. This person's Google
     * authorization lives behind the server's Vault helpers, so pressing this
     * button never puts a token in a browser.
     */
    async triggerCalendarSync(): Promise<CalendarSyncOutcome> {
      const empty = (status: string, error: string): CalendarSyncOutcome => ({
        ok: false, status, created: null, updated: null, failed: null, tasks: null,
        stoppedEarly: null, error,
      });

      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) return empty('not_signed_in', 'Sign in first.');

      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/sync-calendar`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'export' }),
        });
      } catch {
        return empty(
          'unreachable',
          'Could not reach the calendar function. It may not be deployed yet.',
        );
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      const asNumber = (value: unknown) => (typeof value === 'number' ? value : null);
      return {
        ok: response.ok,
        status:
          typeof body.status === 'string'
            ? body.status
            : response.ok
              ? 'unknown'
              : `http_${response.status}`,
        created: asNumber(body.created),
        updated: asNumber(body.updated),
        failed: asNumber(body.failed),
        tasks: asNumber(body.tasks),
        stoppedEarly:
          body.stoppedEarly === 'limit' || body.stoppedEarly === 'repeated_failure'
            ? body.stoppedEarly
            : null,
        error: typeof body.error === 'string' ? body.error : null,
      };
    },

    /**
     * Finish a task in one write, however many times the button is pressed.
     *
     * Everything the completion changes happens inside complete_task_operation,
     * in one transaction. The browser used to do this in four statements, and
     * each one could succeed while the next failed; the failure that produces is
     * not an error message, it is a lead whose follow-up date moved with no
     * activity to explain why.
     *
     * The cadence rule is still decided by the caller and passed in.
     * Duplicating it in SQL would mean two implementations to keep in agreement.
     */
    async completeTaskDurably(input: CompletionInput): Promise<CompletionOutcome> {
      const empty = (error: string): CompletionOutcome => ({
        ok: false, activityId: null, reused: false, taskReopened: false,
        nextDueDate: null, occurredAt: null, error,
      });

      const { data, error } = await db.rpc('complete_task_operation', {
        p_task_id: input.taskId,
        p_token: input.token,
        p_occurred_at: input.occurredAt,
        p_channel: input.channel ?? null,
        p_approved_message: input.approvedMessage ?? null,
        p_outcome: input.outcome ?? null,
        p_activity_type: 'follow_up_sent',
        p_title: null,
        p_next_due_date: input.nextDueDate ?? null,
        p_next_title: input.nextTitle ?? null,
        p_next_notes: input.nextNotes ?? null,
        p_reopen_task: input.reopenTask,
        p_calendar_history: true,
      });

      if (error) return empty(error.message);

      const body = (data ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        activityId: typeof body.activity_id === 'string' ? body.activity_id : null,
        reused: body.reused === true,
        taskReopened: body.task_reopened === true,
        // The date that was really written, so a confirmation quotes the record
        // rather than what the caller hoped for.
        nextDueDate: typeof body.next_due_date === 'string' ? body.next_due_date : null,
        occurredAt: typeof body.occurred_at === 'string' ? body.occurred_at : input.occurredAt,
        error: null,
      };
    },

    /** Reverse the last operation on a task, or say why it will not. */
    async undoTaskOperation(taskId: string): Promise<UndoOutcome> {
      return callUndo(db, 'undo_task_operation', taskId);
    },

    async skipTaskDurably(taskId: string): Promise<UndoOutcome> {
      return callUndo(db, 'skip_task_operation', taskId);
    },

    async softDeleteTask(taskId: string): Promise<UndoOutcome> {
      return callUndo(db, 'soft_delete_task', taskId);
    },

    /**
     * Ask the worker to drain this person's queue now.
     *
     * Sends their own session, so the worker claims their jobs and nobody
     * else's. A failure here is not reported as a failure of the save: the
     * work is already committed and the scheduled sweep is the backstop.
     */
    async drainSyncJobs(): Promise<{ ran: boolean; succeeded: number; failed: number }> {
      const idle = { ran: false, succeeded: 0, failed: 0 };
      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) return idle;

      try {
        const response = await fetch(`${functionsBaseUrl()}/run-sync-jobs`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: '{}',
        });
        if (!response.ok) return idle;
        const body = (await response.json()) as Record<string, unknown>;
        return {
          ran: body.status === 'ran',
          succeeded: typeof body.succeeded === 'number' ? body.succeeded : 0,
          failed: typeof body.failed === 'number' ? body.failed : 0,
        };
      } catch {
        return idle;
      }
    },

    /** What is in the bin. Read through a function, because the policy hides them. */
    async loadRecentlyDeleted(): Promise<TableMap['tasks'][]> {
      const { data, error } = await db.rpc('recently_deleted_tasks');
      if (error) return [];
      return (data ?? []) as TableMap['tasks'][];
    },

    /**
     * Is a sync still outstanding for this owner?
     *
     * Read from the queue rather than guessed, so "Saved; calendar syncing" and
     * "Calendar synced" are two different statements of fact rather than one
     * hopeful message.
     */
    async loadSyncPending(): Promise<{ calendar: boolean; leadMirror: boolean }> {
      const { data, error } = await db
        .from('sync_jobs')
        .select('kind')
        .is('completed_at', null);
      if (error) return { calendar: false, leadMirror: false };
      const kinds = new Set(((data ?? []) as { kind: string }[]).map((r) => r.kind));
      return { calendar: kinds.has('calendar'), leadMirror: kinds.has('lead_mirror') };
    },

    /**
     * Begin connecting this person's own Google account.
     *
     * The browser gets back a URL to Google and nothing else. It does not build
     * that URL, because it carries a state the server has to have recorded first,
     * and a state the server never issued is one it must refuse. It does not hold
     * the OAuth client secret either, which is why the exchange happens in a
     * function and not here.
     */
    async startCalendarOAuth(): Promise<CalendarOAuthStart> {
      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) {
        return { status: 'not_signed_in', authorizeUrl: null, error: 'Sign in first.' };
      }

      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/calendar-oauth`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'start' }),
        });
      } catch {
        return {
          status: 'unreachable',
          authorizeUrl: null,
          error: 'Could not reach the connection function. It may not be deployed yet.',
        };
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      /**
       * Only an address on Google's own consent host is accepted.
       *
       * The server builds it, so this should never matter. It is checked anyway
       * because this value is about to become a navigation, and a navigation
       * taken from a response is worth one line of paranoia.
       */
      const raw = typeof body.authorizeUrl === 'string' ? body.authorizeUrl : null;
      let authorizeUrl: string | null = null;
      if (raw) {
        try {
          const parsed = new URL(raw);
          if (parsed.protocol === 'https:' && parsed.hostname === 'accounts.google.com') {
            authorizeUrl = parsed.toString();
          }
        } catch {
          authorizeUrl = null;
        }
      }

      return {
        status:
          typeof body.status === 'string'
            ? body.status
            : response.ok
              ? 'unknown'
              : `http_${response.status}`,
        authorizeUrl: response.ok ? authorizeUrl : null,
        error: typeof body.error === 'string' ? body.error : null,
      };
    },

    /**
     * Forget this person's Google authorization.
     *
     * Server side, because the token being revoked is one this browser has never
     * been allowed to see. Nothing is removed from the calendar: events already
     * in somebody's week stay there, and the response says so plainly rather than
     * letting the screen imply otherwise.
     */
    async disconnectCalendar(): Promise<CalendarDisconnectOutcome> {
      const fail = (status: string, error: string): CalendarDisconnectOutcome => ({
        ok: false, status, revokedAtGoogle: false, eventsRemoved: false, error,
      });

      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) return fail('not_signed_in', 'Sign in first.');

      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/calendar-oauth`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'disconnect' }),
        });
      } catch {
        return fail(
          'unreachable',
          'Could not reach the connection function. It may not be deployed yet.',
        );
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      return {
        ok: response.ok,
        status:
          typeof body.status === 'string'
            ? body.status
            : response.ok
              ? 'unknown'
              : `http_${response.status}`,
        revokedAtGoogle: body.revokedAtGoogle === true,
        eventsRemoved: body.eventsRemoved === true,
        error: typeof body.error === 'string' ? body.error : null,
      };
    },

    /**
     * Ask the server to reconcile the Sheet in, or to rewrite it from here.
     *
     * Sends this browser's session and nothing else. The Google credential and
     * the spreadsheet id live in the function's own secrets, so a person pressing
     * the button never holds either and this request cannot carry them.
     */
    async triggerLeadMirror(
      action: LeadMirrorAction,
      options: {
        mode?: ReconcileMode;
        expect?: { leadRows: number; touchRows: number };
      } = {},
    ): Promise<LeadMirrorOutcome> {
      const empty = (status: string, error: string): LeadMirrorOutcome => ({
        ok: false,
        status,
        counts: null,
        ambiguous: [],
        rejected: [],
        warnings: [],
        gateReasons: [],
        applied: null,
        leadRows: null,
        touchRows: null,
        error,
      });

      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) return empty('not_signed_in', 'Sign in first.');

      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/sync-lead-mirror`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.expect ? { expect: options.expect } : {}),
          }),
        });
      } catch {
        return empty(
          'unreachable',
          'Could not reach the lead mirror function. It may not be deployed yet.',
        );
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      const gate = body.gate as { reasons?: string[] } | undefined;
      const asNumber = (value: unknown) => (typeof value === 'number' ? value : null);

      return {
        ok: response.ok,
        status:
          typeof body.status === 'string'
            ? body.status
            : response.ok
              ? 'unknown'
              : `http_${response.status}`,
        counts: (body.counts as Record<string, number> | undefined) ?? null,
        ambiguous: Array.isArray(body.ambiguous)
          ? (body.ambiguous as LeadMirrorOutcome['ambiguous'])
          : [],
        rejected: Array.isArray(body.rejected)
          ? (body.rejected as LeadMirrorOutcome['rejected'])
          : [],
        warnings: Array.isArray(body.warnings) ? (body.warnings as string[]) : [],
        gateReasons: Array.isArray(gate?.reasons) ? (gate.reasons as string[]) : [],
        applied: (body.applied as LeadMirrorOutcome['applied']) ?? null,
        leadRows: asNumber(body.leadRows),
        touchRows: asNumber(body.touchRows),
        error: typeof body.error === 'string' ? body.error : null,
      };
    },

    /**
     * Ask the server to sync now.
     *
     * Sends this browser's session and nothing else. The Google credential lives
     * in the function's own secrets, so a person pressing this button never holds
     * it and the network request cannot carry it.
     */
    async triggerSync(
      provider: AnalyticsProvider,
      mode: SyncMode,
    ): Promise<SyncTriggerOutcome> {
      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) {
        return { ok: false, status: 'not_signed_in', rowsWritten: null, error: 'Sign in first.' };
      }

      const name = provider === 'ga4' ? 'sync-ga4' : 'sync-search-console';
      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/${name}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
      } catch {
        // A function that has not been deployed yet fails here, and saying so is
        // more use than a raw network error.
        return {
          ok: false,
          status: 'unreachable',
          rowsWritten: null,
          error: 'Could not reach the sync function. It may not be deployed yet.',
        };
      }

      let body: { status?: string; rowsWritten?: number; error?: string } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        body = {};
      }

      return {
        ok: response.ok,
        status: body.status ?? (response.ok ? 'unknown' : `http_${response.status}`),
        rowsWritten: typeof body.rowsWritten === 'number' ? body.rowsWritten : null,
        error: body.error ?? null,
      };
    },

    /* ----------------------------------------------------- the assistant --- */

    /**
     * Ask the assistant one question.
     *
     * Sends this browser's session, what was typed, and the records it is
     * already showing. The model key lives in the function's own secrets, so a
     * person using this never holds it and this request cannot carry it.
     *
     * Nothing is written here. What comes back is a proposal, and every write
     * below is a separate call the person has to ask for.
     */
    async askAssistant(input: AssistantRequest): Promise<AssistantAnswer> {
      const nothing = (
        status: AssistantAnswer['status'], error: string | null,
      ): AssistantAnswer => ({
        status, proposal: null, model: null, costMicros: null, priced: false, error,
      });

      const { data: session } = await db.auth.getSession();
      const token = session.session?.access_token;
      if (!token) return nothing('not_signed_in', 'Sign in first.');

      let response: Response;
      try {
        response = await fetch(`${functionsBaseUrl()}/assistant`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
      } catch {
        return nothing(
          'unreachable',
          'Could not reach the assistant. The function may not be deployed yet.',
        );
      }

      let body: Record<string, unknown> = {};
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      const known: AssistantAnswer['status'][] = [
        'ok', 'refused', 'failed', 'no_model_key', 'no_credit', 'not_signed_in',
        'not_configured', 'bad_request', 'unreachable', 'unavailable',
        'daily_cap', 'rate_limited', 'duplicate',
      ];
      const reported = typeof body.status === 'string' ? body.status : '';
      const status = (known as string[]).includes(reported)
        ? (reported as AssistantAnswer['status'])
        : 'failed';

      return {
        status,
        // Trusted as a shape, not as a fact: the server has already dropped
        // everything it would not stand behind.
        proposal: (body.proposal ?? null) as AssistantAnswer['proposal'],
        model: typeof body.model === 'string' ? body.model : null,
        costMicros: typeof body.costMicros === 'number' ? body.costMicros : null,
        priced: body.priced === true,
        error: typeof body.error === 'string' ? body.error : null,
      };
    },

    /** Save a contact, the meeting when the day is known, and the facts. One write. */
    async captureContact(input: CaptureInput): Promise<CaptureOutcome> {
      const { data, error } = await db.rpc('capture_contact', {
        p_token: input.token,
        p_name: input.name,
        p_organization: input.organization,
        p_role: input.role,
        p_channel: input.channel,
        p_handle: input.handle,
        p_met_on: input.metOn,
        p_location: input.location,
        p_interest: input.interest,
        p_summary: input.summary,
        p_next_action: input.nextAction,
        p_next_due_date: input.nextDueDate,
        p_facts: input.facts,
      });

      if (error) {
        return {
          ok: false, leadId: null, reused: false, recordedMeeting: false,
          factsWritten: 0, factsSkipped: 0, nextDueDate: null, error: error.message,
        };
      }

      const body = (data ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        leadId: typeof body.lead_id === 'string' ? body.lead_id : null,
        reused: body.reused === true,
        recordedMeeting: body.recorded_meeting === true,
        factsWritten: typeof body.facts_written === 'number' ? body.facts_written : 0,
        factsSkipped: typeof body.facts_skipped === 'number' ? body.facts_skipped : 0,
        nextDueDate: typeof body.next_due_date === 'string' ? body.next_due_date : null,
        error: null,
      };
    },

    /** Record contact that already happened, and move everything that follows. */
    async recordConversation(input: ConversationInput): Promise<ConversationOutcome> {
      const { data, error } = await db.rpc('record_conversation', {
        p_lead_id: input.leadId,
        p_token: input.token,
        p_occurred_on: input.occurredOn,
        p_summary: input.summary,
        p_channel: input.channel ?? null,
        p_activity_type: input.activityType ?? 'conversation',
        p_approved_message: input.approvedMessage ?? null,
        p_outcome: input.outcome ?? null,
        p_next_due_date: input.nextDueDate ?? null,
        p_next_action: input.nextAction ?? null,
        p_evidence: input.evidence ?? 'User report',
      });

      if (error) {
        return {
          ok: false, activityId: null, reused: false, leadId: null,
          occurredOn: null, nextDueDate: null, error: error.message,
        };
      }

      const body = (data ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        activityId: typeof body.activity_id === 'string' ? body.activity_id : null,
        reused: body.reused === true,
        leadId: typeof body.lead_id === 'string' ? body.lead_id : input.leadId,
        occurredOn: typeof body.occurred_on === 'string' ? body.occurred_on : input.occurredOn,
        nextDueDate: typeof body.next_due_date === 'string' ? body.next_due_date : null,
        error: null,
      };
    },

    async saveDraft(
      leadId: string, channel: string | null, body: string,
    ): Promise<DraftOutcome> {
      const { data, error } = await db.rpc('save_message_draft', {
        p_lead_id: leadId, p_channel: channel, p_body: body,
      });
      return readDraftOutcome(data, error?.message ?? null);
    },

    /** Note that a draft was copied. Deliberately not a send, and it says so. */
    async markDraftCopied(draftId: string): Promise<DraftOutcome> {
      const { data, error } = await db.rpc('mark_draft_copied', { p_draft_id: draftId });
      return readDraftOutcome(data, error?.message ?? null);
    },

    /** The one path that produces a sent draft, because somebody said so. */
    async markDraftSent(
      draftId: string, token: string, sentOn: string, finalBody?: string | null,
    ): Promise<DraftOutcome> {
      const { data, error } = await db.rpc('mark_draft_sent', {
        p_draft_id: draftId,
        p_token: token,
        p_sent_on: sentOn,
        p_final_body: finalBody ?? null,
      });
      return readDraftOutcome(data, error?.message ?? null);
    },

    async loadDrafts(leadId: string): Promise<MessageDraft[]> {
      const { data, error } = await db
        .from('message_drafts')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false });
      if (error) return [];
      return (data ?? []) as MessageDraft[];
    },

    async loadFacts(leadId: string): Promise<ExtractedFact[]> {
      const { data, error } = await db
        .from('extracted_facts')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false });
      if (error) return [];
      return (data ?? []) as ExtractedFact[];
    },

    /**
     * What the assistant has cost, read from the rows the server wrote.
     *
     * Summed here rather than in SQL because it is a handful of rows and a view
     * would be another migration to keep in step.
     *
     * A null cost is counted as not known rather than added in as zero. Those
     * two are not the same thing and the difference runs the wrong way: a
     * request that failed after the model had worked was billed and reported
     * nothing, so treating it as free understates the bill. The count comes
     * back separately and the screen says the total is a floor.
     */
    async loadAiUsage(days = 30): Promise<AiUsageSummary> {
      const since = new Date(Date.now() - days * 86_400_000).toISOString();
      const empty: AiUsageSummary = {
        requests: 0, costMicros: 0, unknownCost: 0, failures: 0, since: since.slice(0, 10),
      };

      const { data, error } = await db
        .from('ai_usage')
        .select('cost_micros, error, created_at')
        .gte('created_at', since);
      if (error) return empty;

      const rows = (data ?? []) as { cost_micros: number | null; error: string | null }[];
      let costMicros = 0;
      let unknownCost = 0;
      let failures = 0;
      for (const row of rows) {
        if (typeof row.cost_micros === 'number') costMicros += row.cost_micros;
        else unknownCost += 1;
        if ((row.error ?? '') !== '') failures += 1;
      }
      return {
        requests: rows.length, costMicros, unknownCost, failures, since: since.slice(0, 10),
      };
    },
  };

  /**
   * Select from a table that may not exist yet.
   *
   * Migration 0005 is separate from 0001, so a project can be perfectly healthy
   * and still have no integration tables. Treating that as empty rather than as a
   * failure keeps the Data screen usable instead of blanking it over a feature
   * that has not been set up.
   */
  async function selectOptional<T>(
    table: string,
    orderBy: string,
    ascending: boolean,
    limit: number,
  ): Promise<T[]> {
    const { data, error } = await db
      .from(table)
      .select('*')
      .order(orderBy, { ascending, nullsFirst: false })
      .limit(limit);

    if (error) {
      // 42P01 is "relation does not exist". Anything else is a real problem.
      if (error.code === '42P01') return [];
      throw new Error(`${table}: ${error.message}`);
    }
    return (data ?? []) as T[];
  }

  /** selectOptional, narrowed to one column's value. Same tolerance of a missing table. */
  async function selectOptionalWhere<T>(
    table: string,
    column: string,
    value: string,
    orderBy: string,
    ascending: boolean,
    limit: number,
  ): Promise<T[]> {
    const { data, error } = await db
      .from(table)
      .select('*')
      .eq(column, value)
      .order(orderBy, { ascending, nullsFirst: false })
      .limit(limit);

    if (error) {
      // 42P01 is "relation does not exist"; 22P02 is an enum value this database
      // does not have yet, which is what an unapplied migration 0007 looks like.
      if (error.code === '42P01' || error.code === '22P02') return [];
      throw new Error(`${table}: ${error.message}`);
    }
    return (data ?? []) as T[];
  }

  /** Rows this account can see in each table. */
  async function countAll(): Promise<Record<TableName, number>> {
    const entries = await Promise.all(
      IMPORT_ORDER.map(async (table) => {
        // head:true asks for the count and no rows, so this stays cheap. The count
        // is what row level security lets this account see, which is exactly the
        // question being asked.
        const { count, error } = await db
          .from(table)
          .select('id', { count: 'exact', head: true });
        if (error) throw new Error(`${table}: ${error.message}`);
        return [table, count ?? 0] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<TableName, number>;
  }

  /** Delete exactly what an aborted import wrote, children before parents. */
  async function undo(
    written: { table: TableName; ids: string[] }[],
  ): Promise<{ ok: boolean; message: string | null }> {
    const problems: string[] = [];
    for (const { table, ids } of [...written].reverse()) {
      for (let i = 0; i < ids.length; i += IMPORT_BATCH_SIZE) {
        const batch = ids.slice(i, i + IMPORT_BATCH_SIZE);
        if (batch.length === 0) continue;
        const { error } = await db.from(table).delete().in('id', batch);
        if (error) problems.push(`${table}: ${error.message}`);
      }
    }
    return problems.length === 0
      ? { ok: true, message: null }
      : { ok: false, message: problems.join('; ') };
  }
}

/**
 * One shape for the three functions that return an undo-style answer.
 *
 * They all report a status rather than throwing, because "there was nothing to
 * undo" and "somebody edited this since" are answers a screen shows a person,
 * not errors a caller should have to catch.
 */
/**
 * One shape for the three draft operations.
 *
 * `sent` is read from the database's own answer rather than inferred from the
 * status string, because this is the exact place a copy would quietly become a
 * send. mark_draft_copied returns sent:false explicitly for the same reason.
 */
function readDraftOutcome(data: unknown, error: string | null): DraftOutcome {
  if (error !== null) {
    return {
      ok: false, draftId: null, status: 'failed', sent: false,
      activityId: null, sentOn: null, error,
    };
  }
  const body = (data ?? {}) as Record<string, unknown>;
  const reported = typeof body.status === 'string' ? body.status : 'failed';
  const status = (['draft', 'copied', 'sent', 'not_found'] as string[]).includes(reported)
    ? (reported as DraftOutcome['status'])
    : 'failed';
  return {
    ok: status !== 'failed' && status !== 'not_found',
    draftId: typeof body.draft_id === 'string' ? body.draft_id : null,
    status,
    sent: status === 'sent',
    activityId: typeof body.activity_id === 'string' ? body.activity_id : null,
    sentOn: typeof body.sent_on === 'string' ? body.sent_on : null,
    error: null,
  };
}

async function callUndo(
  client: ReturnType<typeof getSupabase>,
  fn: string,
  taskId: string,
): Promise<UndoOutcome> {
  const { data, error } = await client.rpc(fn, { p_task_id: taskId });
  if (error) {
    return { status: 'failed', operation: null, reasons: [], error: error.message };
  }
  const body = (data ?? {}) as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : 'failed';
  return {
    status: status as UndoStatus,
    operation: typeof body.operation === 'string' ? body.operation : null,
    reasons: Array.isArray(body.reasons) ? (body.reasons as string[]) : [],
    error: null,
  };
}
