/**
 * Turning the database back into the spreadsheet.
 *
 * Pure, like leadMirror.ts. In goes the current state of the leads and their
 * touches; out come two rectangles of cell values and the ranges to put them in.
 * Nothing here fetches or writes, so the ordering and the formatting can be
 * proven in a test rather than inspected by eye in a live sheet.
 *
 * THE DIRECTION IS ONE WAY
 *
 * Supabase is authoritative. This builds a mirror of it. Nothing in this file
 * reads the sheet, compares against it, or preserves anything a person typed into
 * the data region, because a sheet edit is not a source of truth and quietly
 * keeping one would make it into one.
 *
 * WHAT IS NOT WRITTEN
 *
 * No row id, no owner id, no connection id, no spreadsheet id, no token, no
 * service account address. The Lead ID column carries the mirror's own readable
 * key and never a uuid: a uuid in a shared spreadsheet is an internal identifier
 * leaving the building for no benefit to the person reading it.
 *
 * WHAT IS LEFT ALONE
 *
 * Rows 1 to 5 of both tabs: the title, the introductory note, the blank spacer
 * and the header. The export addresses row 6 onwards and nothing above it, so the
 * frozen header, the filter views and the sheet's own styling survive because
 * they are never touched rather than because they are carefully restored.
 */

import {
  columnLetter, columnOf, FIRST_DATA_ROW, LEAD_HEADERS, LEAD_TAB, normalizeName,
  TOUCH_HEADERS, TOUCH_TAB,
} from './leadMirrorShared.ts';
import type { FollowUpMode, LeadStage } from './types.ts';

/* ------------------------------------------------------------------- labels --- */

/**
 * Stage names as a person reads them.
 *
 * Mirrors STAGE_LABELS in src/types/domain.ts. The browser must not import across
 * this boundary and neither may the server, so the two are kept in step by
 * src/test/security.test.ts rather than by one importing the other.
 */
export const STAGE_SHEET_LABELS: Record<LeadStage, string> = {
  new_contact: 'New contact',
  follow_up: 'Follow-up',
  qualified: 'Qualified',
  call_scheduled: 'Call scheduled',
  proposal: 'Proposal',
  waiting: 'Waiting',
  won: 'Won',
  lost: 'Lost',
};

/**
 * Follow-up status in the sheet's own shouting capitals.
 *
 * The mirror used DUE SOON, SCHEDULED and NOT SCHEDULED before this code existed
 * and people read those words, so they are preserved exactly. The remaining states
 * are written in the same voice. Mirrors FOLLOW_UP_STATUS_SHEET_LABELS in
 * src/config/followUp.ts, kept in step by test.
 */
export const FOLLOW_UP_STATUS_SHEET_LABELS: Record<string, string> = {
  overdue: 'OVERDUE',
  due_today: 'DUE TODAY',
  due_soon: 'DUE SOON',
  scheduled: 'SCHEDULED',
  not_scheduled: 'NOT SCHEDULED',
  on_hold: 'ON HOLD',
  archived: 'ARCHIVED',
  closed: 'CLOSED',
};

/* -------------------------------------------------------------- mirror keys --- */

/**
 * A readable, stable key for a lead that does not have one yet.
 *
 * Built from the organization, or the contact's name when there is no
 * organization, because that is what a person scanning the column would expect to
 * see. Collisions get a numeric suffix in a deterministic order, so the same set
 * of leads always produces the same set of keys.
 *
 * Never derived from the row id. A uuid fragment would be stable and unique and
 * would also be an internal identifier written into a document people share.
 */
export function slugForKey(value: string | null): string {
  const slug = (value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    // Drop combining marks so "José" becomes "jose" rather than "jos".
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug === '' ? 'unnamed-lead' : slug;
}

export interface KeyAssignment {
  leadId: string;
  externalKey: string;
}

/**
 * Give every lead a mirror key, inventing one only where none exists.
 *
 * Existing keys are never changed: the key is what makes a re-import an update,
 * so rewriting one would orphan a lead's whole touch history. New keys are handed
 * out in id order so the result does not depend on how the rows happened to come
 * back from the database.
 */
export function assignMirrorKeys(
  leads: readonly { id: string; prospect_name: string; organization: string | null; external_key: string | null }[],
): { keyById: Map<string, string>; assigned: KeyAssignment[] } {
  const keyById = new Map<string, string>();
  const taken = new Set<string>();
  const assigned: KeyAssignment[] = [];

  for (const lead of leads) {
    if (lead.external_key !== null && lead.external_key.trim() !== '') {
      keyById.set(lead.id, lead.external_key);
      taken.add(lead.external_key);
    }
  }

  const needing = leads
    .filter((lead) => !keyById.has(lead.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const lead of needing) {
    const base = slugForKey(lead.organization ?? lead.prospect_name);
    let candidate = base;
    let suffix = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.add(candidate);
    keyById.set(lead.id, candidate);
    assigned.push({ leadId: lead.id, externalKey: candidate });
  }

  return { keyById, assigned };
}

/* ------------------------------------------------------------------- shapes --- */

/**
 * A lead and its derived follow-up state, as the export needs it.
 *
 * The derived fields come from lead_follow_up_state in the database rather than
 * being recomputed here, so the spreadsheet cannot disagree with the Pipeline
 * screen about how long somebody has been waiting.
 */
export interface ExportLead {
  id: string;
  external_key: string | null;
  prospect_name: string;
  organization: string | null;
  relationship: string | null;
  stage: LeadStage;
  current_status: string | null;
  source: string | null;
  first_contact_at: string | null;
  next_action: string | null;
  next_action_date: string | null;
  follow_up_mode: FollowUpMode;
  preferred_channel: string | null;
  email: string | null;
  phone: string | null;
  proposed_value: number | null;
  notes: string | null;
  record_confidence: string | null;

  /* Derived, from lead_follow_up_state(as_of). */
  effective_last_touch_on: string | null;
  days_since_touch: number | null;
  follow_up_status: string;
}

export interface ExportTouch {
  lead_id: string;
  occurred_at: string;
  title: string;
  channel: string | null;
  details: string | null;
  evidence_source: string | null;
  activity_type: string;
}

/** Activity types that are not contact. Mirrors NON_TOUCH_ACTIVITY and the SQL. */
export const NON_TOUCH_ACTIVITY = [
  'content_published', 'website_update', 'analytics_check',
  'revenue_received', 'unavailable', 'client_work', 'decision',
];

export type Cell = string | number | null;

/* ---------------------------------------------------------------- the order --- */

/**
 * Worst first, then soonest, then by key.
 *
 * The mirror is read to decide who to contact, so it is ordered the way that
 * question is answered: whoever is most overdue at the top. The third sort key is
 * the mirror key, which is unique, so the order is completely determined by the
 * data and never depends on the order rows arrived in.
 */
const STATUS_ORDER = [
  'overdue', 'due_today', 'due_soon', 'scheduled',
  'not_scheduled', 'on_hold', 'archived', 'closed',
];

export function compareExportLeads(
  a: ExportLead,
  b: ExportLead,
  keyById: Map<string, string>,
): number {
  const rank = (lead: ExportLead) => {
    const at = STATUS_ORDER.indexOf(lead.follow_up_status);
    return at === -1 ? STATUS_ORDER.length : at;
  };

  const byStatus = rank(a) - rank(b);
  if (byStatus !== 0) return byStatus;

  // Nulls last, so a lead with no date never sits above one with a date.
  const dateA = a.next_action_date ?? '9999-12-31';
  const dateB = b.next_action_date ?? '9999-12-31';
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;

  return (keyById.get(a.id) ?? '').localeCompare(keyById.get(b.id) ?? '');
}

/* ----------------------------------------------------------------- the cells --- */

/**
 * A date for a cell, as ISO.
 *
 * ISO rather than 09/27/26 on purpose. USER_ENTERED makes Google parse the string,
 * and 09/27/26 means two different days depending on the spreadsheet's locale,
 * whereas an ISO date means one day everywhere. What the reader sees is still
 * 09/27/26, because the export sets an explicit mm/dd/yy number format on the
 * column. Unambiguous going in, readable coming out.
 */
function dateCell(day: string | null): Cell {
  if (day === null) return '';
  return day.slice(0, 10);
}

/** A blank cell is an empty string: it clears the cell rather than writing a word. */
function textCell(value: string | null): Cell {
  return value ?? '';
}

function numberCell(value: number | null): Cell {
  return value === null ? '' : value;
}

/** One Lead Mirror row, in the sheet's column order. */
export function leadRowCells(lead: ExportLead, mirrorKey: string): Cell[] {
  const cells: Cell[] = new Array(LEAD_HEADERS.length).fill('');
  const put = (header: string, value: Cell) => {
    cells[columnOf(LEAD_HEADERS, header)] = value;
  };

  put('Lead ID', mirrorKey);
  put('Contact', lead.prospect_name);
  put('Organization', textCell(lead.organization));
  put('Relationship', textCell(lead.relationship));
  put('Stage', STAGE_SHEET_LABELS[lead.stage] ?? lead.stage);
  put('Current status', textCell(lead.current_status));
  put('Source', textCell(lead.source));
  put('First contact', dateCell(lead.first_contact_at));
  put('Last touch', dateCell(lead.effective_last_touch_on));
  put('Days since touch', numberCell(lead.days_since_touch));
  put('Next action', textCell(lead.next_action));
  put('Next follow-up', dateCell(lead.next_action_date));
  put('Follow-up status', FOLLOW_UP_STATUS_SHEET_LABELS[lead.follow_up_status] ?? '');
  put('Channel', textCell(lead.preferred_channel));
  put('Email', textCell(lead.email));
  put('Phone / WhatsApp', textCell(lead.phone));
  put('Proposed value', numberCell(lead.proposed_value));
  put('Context / notes', textCell(lead.notes));
  put('Record confidence', textCell(lead.record_confidence));

  return cells;
}

/** One Touch History row, in the sheet's column order. */
export function touchRowCells(
  touch: ExportTouch,
  lead: ExportLead | undefined,
  mirrorKey: string,
): Cell[] {
  const cells: Cell[] = new Array(TOUCH_HEADERS.length).fill('');
  const put = (header: string, value: Cell) => {
    cells[columnOf(TOUCH_HEADERS, header)] = value;
  };

  put('Date', dateCell(touch.occurred_at.slice(0, 10)));
  put('Lead ID', mirrorKey);
  put('Contact', lead ? lead.prospect_name : '');
  put('Organization', lead ? textCell(lead.organization) : '');
  // The activity's own title. For a row that came from this sheet that is the
  // original Activity label, so a round trip changes nothing.
  put('Activity', touch.title);
  put('Channel', textCell(touch.channel));
  put('Details', textCell(touch.details));
  put('Evidence / source', textCell(touch.evidence_source));

  return cells;
}

/* ----------------------------------------------------------------- the write --- */

/** One tab's worth of work: the values, where they go, and what to clear after. */
export interface TabWrite {
  tab: string;
  /** A1 range for the values, starting at the first data row. */
  range: string | null;
  values: Cell[][];
  /** A1 range of leftover rows to empty, when the data has shrunk. */
  clearRange: string | null;
}

export interface MirrorExport {
  leadTab: TabWrite;
  touchTab: TabWrite;
  /** Keys handed to leads that had none. The caller persists these. */
  assignedKeys: KeyAssignment[];
  leadRows: number;
  touchRows: number;
}

function rangeFor(headers: readonly string[], rowCount: number): string | null {
  if (rowCount === 0) return null;
  const lastColumn = columnLetter(headers.length - 1);
  return `A${FIRST_DATA_ROW}:${lastColumn}${FIRST_DATA_ROW + rowCount - 1}`;
}

/**
 * How far down to clear.
 *
 * Only as far as the grid actually goes. Asking Google to clear past the last row
 * of the sheet is an error, and a sheet that has never held many rows is the
 * normal case, so the bound comes from the tab's real size.
 */
function clearRangeFor(
  headers: readonly string[],
  rowCount: number,
  gridRowCount: number,
): string | null {
  const firstSurplus = FIRST_DATA_ROW + rowCount;
  if (gridRowCount < firstSurplus) return null;
  const lastColumn = columnLetter(headers.length - 1);
  return `A${firstSurplus}:${lastColumn}${gridRowCount}`;
}

/**
 * Build both tabs from the current database state.
 *
 * Touches are newest first, which is how the tab already reads, and ties are
 * broken by mirror key then title so the order is fully determined. A touch whose
 * lead is not in the export is left out rather than written with a blank Lead ID,
 * because a row in a history with nobody attached to it is worse than no row.
 */
export function buildMirrorExport(input: {
  leads: readonly ExportLead[];
  touches: readonly ExportTouch[];
  leadGridRows: number;
  touchGridRows: number;
}): MirrorExport {
  const { keyById, assigned } = assignMirrorKeys(input.leads);

  const leads = [...input.leads].sort((a, b) => compareExportLeads(a, b, keyById));
  const leadById = new Map(input.leads.map((lead) => [lead.id, lead]));

  const leadValues = leads.map((lead) => leadRowCells(lead, keyById.get(lead.id) ?? ''));

  const touches = input.touches
    .filter((touch) => leadById.has(touch.lead_id))
    .filter((touch) => !NON_TOUCH_ACTIVITY.includes(touch.activity_type))
    .sort((a, b) => {
      if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? 1 : -1;
      const keyA = keyById.get(a.lead_id) ?? '';
      const keyB = keyById.get(b.lead_id) ?? '';
      if (keyA !== keyB) return keyA.localeCompare(keyB);
      return normalizeName(a.title).localeCompare(normalizeName(b.title));
    });

  const touchValues = touches.map((touch) =>
    touchRowCells(touch, leadById.get(touch.lead_id), keyById.get(touch.lead_id) ?? ''),
  );

  return {
    leadTab: {
      tab: LEAD_TAB,
      range: rangeFor(LEAD_HEADERS, leadValues.length),
      values: leadValues,
      clearRange: clearRangeFor(LEAD_HEADERS, leadValues.length, input.leadGridRows),
    },
    touchTab: {
      tab: TOUCH_TAB,
      range: rangeFor(TOUCH_HEADERS, touchValues.length),
      values: touchValues,
      clearRange: clearRangeFor(TOUCH_HEADERS, touchValues.length, input.touchGridRows),
    },
    assignedKeys: assigned,
    leadRows: leadValues.length,
    touchRows: touchValues.length,
  };
}

/* -------------------------------------------------------------- the formats --- */

/**
 * The number formats the data region needs, by column.
 *
 * Applied over the rows just written. A hand-built sheet usually has its formats
 * on the cells that existed when somebody set them up, so rows added later show a
 * date as 46292 unless something says otherwise. Only numberFormat is set; nothing
 * else about the cells is in the field mask.
 */
export function leadColumnFormats(): { column: number; type: 'DATE' | 'NUMBER' | 'CURRENCY'; pattern: string }[] {
  return [
    { column: columnOf(LEAD_HEADERS, 'First contact'), type: 'DATE', pattern: 'mm/dd/yy' },
    { column: columnOf(LEAD_HEADERS, 'Last touch'), type: 'DATE', pattern: 'mm/dd/yy' },
    { column: columnOf(LEAD_HEADERS, 'Next follow-up'), type: 'DATE', pattern: 'mm/dd/yy' },
    { column: columnOf(LEAD_HEADERS, 'Days since touch'), type: 'NUMBER', pattern: '0' },
    { column: columnOf(LEAD_HEADERS, 'Proposed value'), type: 'CURRENCY', pattern: '$#,##0.##' },
  ];
}

export function touchColumnFormats(): { column: number; type: 'DATE'; pattern: string }[] {
  return [{ column: columnOf(TOUCH_HEADERS, 'Date'), type: 'DATE', pattern: 'mm/dd/yy' }];
}
