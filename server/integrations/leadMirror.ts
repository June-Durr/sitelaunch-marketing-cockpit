/**
 * Reading the lead mirror spreadsheet, and working out what it would change.
 *
 * Every function here is pure. Nothing fetches, nothing writes, nothing knows what
 * a database is. The Edge Function hands this module the cell values and the rows
 * already in Supabase, and gets back a plan: what would be created, what would be
 * updated, what is already correct, what is ambiguous and what is malformed. The
 * plan is the dry run. Executing it is somebody else's job.
 *
 * WHY A PLAN AND NOT A WRITE
 *
 * This import runs against real relationships with real people in them. A merge
 * that joins two prospects into one is not a bug you notice; it is a bug you find
 * out about when you email the wrong person. Separating "decide" from "do" means
 * the decision can be printed, read and refused before anything is written, and
 * it means the hard part is testable without a database or a Google account.
 *
 * THE RULES THIS MODULE REFUSES TO BREAK
 *
 *   Blank stays blank.     An empty cell becomes null. Never 0, never '', never a
 *                          guessed date. "Not recorded" and "recorded as nothing"
 *                          are different facts and the app shows them differently.
 *   No fuzzy merging.      A person is matched on the Sheet's own stable key, or
 *                          on an exactly equal email, or on an exactly equal
 *                          contact and organization together. Nothing else.
 *                          Similar names are not evidence.
 *   Ambiguity stops.       A row with more than one possible match is left
 *                          completely alone and reported. Picking one would be
 *                          guessing about a person.
 *   Nothing is blanked.    An update only ever fills in or corrects a field the
 *                          Sheet actually has a value for. A blank cell never
 *                          erases what is already in the database.
 *   Re-running is free.    Leads key on (source, Lead ID) and touches key on a
 *                          fingerprint of source, Lead ID, date, activity and
 *                          channel, so the third run writes exactly nothing.
 */

import type { FollowUpMode, LeadStage } from './types.ts';
import {
  blankToNull, FIRST_DATA_ROW, isBlankRow, LEAD_HEADERS, LEAD_TAB, MIRROR_SOURCE,
  normalizeEmail, normalizeName, padRow, TOUCH_HEADERS, TOUCH_TAB,
  type LeadHeader, type TouchHeader,
} from './leadMirrorShared.ts';

export type { FollowUpMode, LeadStage, LeadHeader, TouchHeader };
export {
  blankToNull, FIRST_DATA_ROW, isBlankRow, LEAD_HEADERS, LEAD_TAB, MIRROR_SOURCE,
  normalizeEmail, normalizeName, padRow, TOUCH_HEADERS, TOUCH_TAB,
};
export { HEADER_ROW } from './leadMirrorShared.ts';

/* ---------------------------------------------------------- header checking --- */

export interface HeaderCheck {
  ok: boolean;
  /** Expected columns the sheet does not have, in the expected order. */
  missing: string[];
  /** Columns that are in the wrong place, as "expected X, found Y at column N". */
  misplaced: string[];
  /** What the sheet actually had, for the report. */
  found: string[];
}

/**
 * Is this the header the importer was written for?
 *
 * Checked by position as well as presence. A sheet where somebody inserted a
 * column would still contain every expected name, and reading it by position would
 * put phone numbers in the proposed-value column. Both failures are reported by
 * name so the person can see exactly what moved.
 */
export function checkHeaders(actual: readonly string[], expected: readonly string[]): HeaderCheck {
  const found = expected.map((_, i) => (actual[i] ?? '').trim());
  const normalized = (value: string) => value.trim().toLowerCase();

  const missing: string[] = [];
  const misplaced: string[] = [];

  for (const [index, name] of expected.entries()) {
    if (normalized(found[index]) === normalized(name)) continue;
    const elsewhere = actual.findIndex((cell) => normalized(cell ?? '') === normalized(name));
    if (elsewhere === -1) {
      missing.push(name);
    } else {
      misplaced.push(
        `expected "${name}" in column ${index + 1}, found it in column ${elsewhere + 1}`,
      );
    }
  }

  return { ok: missing.length === 0 && misplaced.length === 0, missing, misplaced, found };
}

/* ----------------------------------------------------------------- the date --- */

export type DateRead =
  | { kind: 'blank' }
  | { kind: 'date'; value: string }
  | { kind: 'invalid'; raw: string };

/** Sheets counts days from 30 December 1899. Needed only if a cell reads as a serial. */
const SHEETS_EPOCH_UTC = Date.UTC(1899, 11, 30);

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function iso(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * A cell to a calendar day, or an honest refusal.
 *
 * Three readings are accepted and nothing else:
 *
 *   2026-09-27   ISO, which is what the rest of the app speaks.
 *   09/27/26     Month first, as the sheet displays it. A two digit year is read
 *                as 20YY, which is right for every date this business has and
 *                wrong for a birthday in 1926. The mirror holds neither.
 *   46292        A raw serial, for the case where the sheet hands back a number
 *                instead of its displayed text.
 *
 * Anything else returns 'invalid' and the row is rejected. A date that cannot be
 * read is not a date to guess at: it is the difference between somebody being
 * eight days cold and eight months cold.
 */
export function parseSheetDate(raw: string | undefined | null): DateRead {
  const text = (raw ?? '').trim();
  if (text === '') return { kind: 'blank' };

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    return isRealDate(year, month, day)
      ? { kind: 'date', value: iso(year, month, day) }
      : { kind: 'invalid', raw: text };
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    const rawYear = Number(slash[3]);
    const year = slash[3].length === 2 ? 2000 + rawYear : rawYear;
    return isRealDate(year, month, day)
      ? { kind: 'date', value: iso(year, month, day) }
      : { kind: 'invalid', raw: text };
  }

  // A serial. Only whole days are accepted; a fractional serial is a timestamp,
  // and this column is documented as a date.
  if (/^\d{1,6}$/.test(text)) {
    const serial = Number(text);
    const ms = SHEETS_EPOCH_UTC + serial * 86_400_000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      return {
        kind: 'date',
        value: iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()),
      };
    }
  }

  return { kind: 'invalid', raw: text };
}

/**
 * A date-only touch, as a timestamp, at noon UTC.
 *
 * occurred_at is a timestamptz and the sheet records a day. Midnight UTC would
 * show a 30 September touch as the evening of 29 September to anybody west of
 * Greenwich, which is where this business is. Noon UTC lands on the same calendar
 * day everywhere from UTC-11 to UTC+11, so reading the day back out of the
 * timestamp gives the day that was imported, in SQL and in TypeScript alike.
 */
export function dayToTimestamp(day: string): string {
  return `${day}T12:00:00.000Z`;
}

/* ---------------------------------------------------------------- the money --- */

export type MoneyRead =
  | { kind: 'blank' }
  | { kind: 'amount'; value: number }
  | { kind: 'invalid'; raw: string };

/**
 * A proposed value to a number, or a refusal.
 *
 * Currency symbols, thousands separators and surrounding spaces are removed,
 * because a person typing $1,500 means 1500. A cell that still is not a number
 * afterwards is rejected rather than coerced, because 0 and "unknown" are the two
 * things this app is most careful never to confuse.
 */
export function parseMoney(raw: string | undefined | null): MoneyRead {
  const text = (raw ?? '').trim();
  if (text === '') return { kind: 'blank' };

  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { kind: 'invalid', raw: text };

  const value = Number(cleaned);
  return Number.isFinite(value) ? { kind: 'amount', value } : { kind: 'invalid', raw: text };
}

/* -------------------------------------------------------- normalizing names --- */

/**
 * Values that announce they are not yet known.
 *
 * These are used for one thing only: refusing to treat a cell as evidence of
 * identity. "Name pending" appears against four different organizations in the
 * first mirror, and matching on it would merge four unrelated people. What is
 * stored is never changed by this list; the sheet's own words go into the database
 * exactly as written, because "name pending" is a true and useful statement.
 */
const PLACEHOLDER_MARKERS = [
  'name pending', 'pending', 'unknown', 'tbd', 'to be confirmed', 'n/a', 'na',
  'none', 'no name', 'not set',
];

/** Is this value too provisional to identify somebody by? */
export function isPlaceholder(value: string | null | undefined): boolean {
  const normalized = normalizeName(value);
  if (normalized === '') return true;
  return PLACEHOLDER_MARKERS.some(
    (marker) => normalized === marker || normalized.includes(marker),
  );
}

/* ---------------------------------------------------------------- the stage --- */

/** Every stage the pipeline has, by the words a sheet would use for it. */
const STAGE_BY_LABEL: Record<string, LeadStage> = {
  'new contact': 'new_contact',
  'new_contact': 'new_contact',
  'follow-up': 'follow_up',
  'follow up': 'follow_up',
  'follow_up': 'follow_up',
  'qualified': 'qualified',
  'call scheduled': 'call_scheduled',
  'call_scheduled': 'call_scheduled',
  'proposal': 'proposal',
  'waiting': 'waiting',
  'won': 'won',
  'lost': 'lost',
};

export function parseStage(raw: string | undefined | null): LeadStage | null {
  return STAGE_BY_LABEL[normalizeName(raw)] ?? null;
}

/**
 * What the sheet's Follow-up status column says about intent.
 *
 * Only the states that express a decision are read. DUE SOON, DUE TODAY, OVERDUE
 * and SCHEDULED are all derived from the date and carry no intent, so they leave
 * the mode as 'auto' and the follow-up rule takes over.
 */
const MODE_BY_STATUS: Record<string, FollowUpMode> = {
  'not scheduled': 'none',
  'no follow-up': 'none',
  'no follow up': 'none',
  'on hold': 'hold',
  'hold': 'hold',
  'archived': 'archived',
  'archive': 'archived',
};

export function parseFollowUpMode(raw: string | undefined | null): FollowUpMode | null {
  return MODE_BY_STATUS[normalizeName(raw)] ?? null;
}

/* ------------------------------------------------------------- the activity --- */

/**
 * Touch labels to activity types.
 *
 * Anything not listed becomes 'other' and keeps its original wording as the
 * activity's title, so nothing is lost and nothing is mislabelled. 'other' still
 * counts as a touch: see NON_TOUCH_ACTIVITY in src/config/followUp.ts for why an
 * unrecognised contact is treated as contact.
 */
const ACTIVITY_BY_LABEL: Record<string, string> = {
  'follow-up sent': 'follow_up_sent',
  'follow up sent': 'follow_up_sent',
  'follow-up': 'follow_up_sent',
  'reply received': 'reply_received',
  'reply': 'reply_received',
  'response received': 'reply_received',
  'discovery conversation': 'conversation',
  'conversation': 'conversation',
  'call': 'conversation',
  'phone call': 'conversation',
  'meeting': 'conversation',
  'in person conversation': 'conversation',
  'networking event': 'networking_event',
  'met at event': 'networking_event',
  'contact added': 'contact_added',
  'contact created': 'contact_added',
  'proposal sent': 'proposal_sent',
  'quote sent': 'proposal_sent',
  'enquiry received': 'lead_created',
  'inquiry received': 'lead_created',
  'lead created': 'lead_created',
};

export function parseActivityType(raw: string | undefined | null): string {
  return ACTIVITY_BY_LABEL[normalizeName(raw)] ?? 'other';
}

/* ------------------------------------------------------------------- shapes --- */

/** One Lead Mirror row, read and nothing more. Days since touch is not read: it is derived. */
export interface SheetLeadRow {
  /** The spreadsheet row number, so a report points at something a person can find. */
  rowNumber: number;
  leadKey: string;
  contact: string;
  organization: string | null;
  relationship: string | null;
  stage: LeadStage;
  currentStatus: string | null;
  source: string | null;
  firstContactOn: string | null;
  reportedLastTouchOn: string | null;
  nextAction: string | null;
  nextFollowUpOn: string | null;
  followUpMode: FollowUpMode;
  channel: string | null;
  email: string | null;
  phone: string | null;
  proposedValue: number | null;
  notes: string | null;
  recordConfidence: string | null;
}

/** One Touch History row. */
export interface SheetTouchRow {
  rowNumber: number;
  occurredOn: string;
  leadKey: string;
  contact: string | null;
  organization: string | null;
  activityLabel: string;
  activityType: string;
  channel: string | null;
  details: string | null;
  evidenceSource: string | null;
  /** The durable key that makes importing this row twice a no-op. */
  externalId: string;
}

/** A row the importer will not touch, and the reason in words. */
export interface RejectedRow {
  tab: string;
  rowNumber: number;
  /** Something identifying, for the report. Never a guess. */
  label: string;
  reason: string;
}

/**
 * The fingerprint that makes a touch import idempotent.
 *
 * Built from the source, the lead's own key, the day, the activity and the
 * channel, which together are what makes one touch a different touch from
 * another. Readable on purpose: a hash would be shorter and would tell nobody
 * anything when they are staring at a row in the database wondering why it did
 * not import again.
 *
 * The separator is a unit separator, so a channel containing a colon cannot forge
 * a key that collides with a different row.
 */
export function touchFingerprint(parts: {
  leadKey: string;
  occurredOn: string;
  activityLabel: string;
  channel: string | null;
}): string {
  return [
    'touch',
    normalizeName(parts.leadKey),
    parts.occurredOn,
    normalizeName(parts.activityLabel),
    normalizeName(parts.channel),
  ].join('\u001f');
}

/* ------------------------------------------------------------------ parsing --- */

export interface ParsedLeads {
  rows: SheetLeadRow[];
  rejected: RejectedRow[];
  /** Things worth saying that are not refusals. */
  warnings: string[];
  /** Every non-blank row seen, including the rejected ones. */
  rowsRead: number;
}

/**
 * The Lead Mirror data region, as rows.
 *
 * A row is rejected, not repaired, when it has no Lead ID, no Contact, an
 * unrecognised Stage, or a date or amount that cannot be read. Those are the
 * fields the rest of the import cannot proceed without, or cannot proceed without
 * inventing.
 */
export function parseLeadRows(values: readonly string[][]): ParsedLeads {
  const width = LEAD_HEADERS.length;
  const rows: SheetLeadRow[] = [];
  const rejected: RejectedRow[] = [];
  const warnings: string[] = [];
  const seenKeys = new Map<string, number>();
  let rowsRead = 0;

  values.forEach((raw, offset) => {
    const rowNumber = FIRST_DATA_ROW + offset;
    const cells = padRow(raw, width);
    if (isBlankRow(cells)) return;
    rowsRead += 1;

    const at = (header: LeadHeader) => cells[LEAD_HEADERS.indexOf(header)];
    const leadKey = blankToNull(at('Lead ID'));
    const contact = blankToNull(at('Contact'));
    const organization = blankToNull(at('Organization'));
    const label = leadKey ?? contact ?? organization ?? `row ${rowNumber}`;

    const reject = (reason: string) =>
      rejected.push({ tab: LEAD_TAB, rowNumber, label, reason });

    if (leadKey === null) {
      reject('No Lead ID. The Lead ID is the key the import matches on, so a row without one cannot be reconciled safely.');
      return;
    }
    if (seenKeys.has(leadKey)) {
      reject(`Lead ID "${leadKey}" is already used on row ${seenKeys.get(leadKey)}. Two rows claiming the same key cannot both be right, so neither is guessed at.`);
      return;
    }
    if (contact === null) {
      reject('No Contact. A lead has to have a name, and the import will not invent one.');
      return;
    }

    const stage = parseStage(at('Stage'));
    if (stage === null) {
      reject(`Stage "${(at('Stage') ?? '').trim()}" is not one of the pipeline stages.`);
      return;
    }

    const firstContact = parseSheetDate(at('First contact'));
    if (firstContact.kind === 'invalid') {
      reject(`First contact "${firstContact.raw}" is not a date this importer can read.`);
      return;
    }
    const lastTouch = parseSheetDate(at('Last touch'));
    if (lastTouch.kind === 'invalid') {
      reject(`Last touch "${lastTouch.raw}" is not a date this importer can read.`);
      return;
    }
    const nextFollowUp = parseSheetDate(at('Next follow-up'));
    if (nextFollowUp.kind === 'invalid') {
      reject(`Next follow-up "${nextFollowUp.raw}" is not a date this importer can read.`);
      return;
    }

    const money = parseMoney(at('Proposed value'));
    if (money.kind === 'invalid') {
      reject(`Proposed value "${money.raw}" is not an amount. It is left out rather than read as zero.`);
      return;
    }

    const nextFollowUpOn = nextFollowUp.kind === 'date' ? nextFollowUp.value : null;
    const statusMode = parseFollowUpMode(at('Follow-up status'));

    /**
     * A declared intent wins only when there is no date to contradict it.
     *
     * A row saying NOT SCHEDULED while carrying a follow-up date is telling two
     * different stories. The date is the more specific claim, so it is kept and
     * the mode stays automatic, and the contradiction is reported rather than
     * resolved quietly.
     */
    let followUpMode: FollowUpMode = 'auto';
    if (statusMode !== null && nextFollowUpOn === null) {
      followUpMode = statusMode;
    } else if (statusMode !== null && nextFollowUpOn !== null) {
      warnings.push(
        `Row ${rowNumber} (${label}): Follow-up status says "${(at('Follow-up status') ?? '').trim()}" but a Next follow-up date of ${nextFollowUpOn} is set. The date was kept and follow-up left automatic.`,
      );
    }

    rows.push({
      rowNumber,
      leadKey,
      contact,
      organization,
      relationship: blankToNull(at('Relationship')),
      stage,
      currentStatus: blankToNull(at('Current status')),
      source: blankToNull(at('Source')),
      firstContactOn: firstContact.kind === 'date' ? firstContact.value : null,
      reportedLastTouchOn: lastTouch.kind === 'date' ? lastTouch.value : null,
      nextAction: blankToNull(at('Next action')),
      nextFollowUpOn,
      followUpMode,
      channel: blankToNull(at('Channel')),
      email: blankToNull(at('Email')),
      phone: blankToNull(at('Phone / WhatsApp')),
      proposedValue: money.kind === 'amount' ? money.value : null,
      notes: blankToNull(at('Context / notes')),
      recordConfidence: blankToNull(at('Record confidence')),
    });
    seenKeys.set(leadKey, rowNumber);
  });

  return { rows, rejected, warnings, rowsRead };
}

export interface ParsedTouches {
  rows: SheetTouchRow[];
  rejected: RejectedRow[];
  rowsRead: number;
}

/**
 * The Touch History data region, as rows.
 *
 * A touch with no date, no Lead ID or no Activity is rejected: all three are part
 * of its identity, and a touch that cannot be identified cannot be imported twice
 * safely. Two rows producing the same fingerprint are reported, and only the first
 * is kept, because a touch is a thing that happened once.
 */
export function parseTouchRows(values: readonly string[][]): ParsedTouches {
  const width = TOUCH_HEADERS.length;
  const rows: SheetTouchRow[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<string, number>();
  let rowsRead = 0;

  values.forEach((raw, offset) => {
    const rowNumber = FIRST_DATA_ROW + offset;
    const cells = padRow(raw, width);
    if (isBlankRow(cells)) return;
    rowsRead += 1;

    const at = (header: TouchHeader) => cells[TOUCH_HEADERS.indexOf(header)];
    const leadKey = blankToNull(at('Lead ID'));
    const activityLabel = blankToNull(at('Activity'));
    const label = `${leadKey ?? 'no lead id'} · ${(at('Date') ?? '').trim() || 'no date'}`;
    const reject = (reason: string) =>
      rejected.push({ tab: TOUCH_TAB, rowNumber, label, reason });

    const date = parseSheetDate(at('Date'));
    if (date.kind === 'blank') {
      reject('No Date. A touch with no date cannot be placed in the history, and the import will not guess one.');
      return;
    }
    if (date.kind === 'invalid') {
      reject(`Date "${date.raw}" is not a date this importer can read.`);
      return;
    }
    if (leadKey === null) {
      reject('No Lead ID, so there is no way to say who this touch was with.');
      return;
    }
    if (activityLabel === null) {
      reject('No Activity, so there is no way to say what happened.');
      return;
    }

    const channel = blankToNull(at('Channel'));
    const externalId = touchFingerprint({
      leadKey,
      occurredOn: date.value,
      activityLabel,
      channel,
    });

    if (seen.has(externalId)) {
      reject(
        `The same touch is already on row ${seen.get(externalId)}: same lead, day, activity and channel. One was imported.`,
      );
      return;
    }
    seen.set(externalId, rowNumber);

    rows.push({
      rowNumber,
      occurredOn: date.value,
      leadKey,
      contact: blankToNull(at('Contact')),
      organization: blankToNull(at('Organization')),
      activityLabel,
      activityType: parseActivityType(activityLabel),
      channel,
      details: blankToNull(at('Details')),
      evidenceSource: blankToNull(at('Evidence / source')),
      externalId,
    });
  });

  return { rows, rejected, rowsRead };
}

/* ----------------------------------------------------------------- matching --- */

/**
 * A lead already in the database, as the reconciliation needs to see it.
 *
 * WHY EVERY SHEET-OWNED COLUMN IS HERE AND NOT JUST THE MATCHING ONES
 *
 * Matching needs four fields. Deciding whether a matched lead would actually
 * change needs all of them, because a field the caller did not select reads as
 * absent, and absent differs from every value, so a thinner query would make
 * every run report every lead as needing an update. The third run would then
 * still write nothing new but would claim twenty-one changes and bump every
 * updated_at, which is exactly the kind of quietly wrong that makes people stop
 * trusting a report.
 *
 * Fields are optional in the type so a caller that genuinely only has the
 * matching columns can still call matchLead, but leadChanges is only honest when
 * the whole row is present.
 */
export interface ExistingLead {
  id: string;
  prospect_name: string;
  organization: string | null;
  email: string | null;
  external_source: string | null;
  external_key: string | null;

  /* The rest of what the Sheet owns, for working out whether anything differs. */
  relationship?: string | null;
  stage?: LeadStage | null;
  current_status?: string | null;
  source?: string | null;
  first_contact_at?: string | null;
  reported_last_touch_at?: string | null;
  next_action?: string | null;
  next_action_date?: string | null;
  follow_up_mode?: FollowUpMode | null;
  preferred_channel?: string | null;
  phone?: string | null;
  proposed_value?: number | string | null;
  notes?: string | null;
  record_confidence?: string | null;
}

/**
 * Exactly the columns ExistingLead needs, for the select that fetches them.
 *
 * Exported so the query cannot drift from the type. A column added to LeadFields
 * and forgotten here would reintroduce the phantom-update bug above, which
 * server/integrations/leadMirror.test.ts asserts against.
 */
export const EXISTING_LEAD_COLUMNS = [
  'id', 'prospect_name', 'organization', 'email', 'external_source', 'external_key',
  'relationship', 'stage', 'current_status', 'source', 'first_contact_at',
  'reported_last_touch_at', 'next_action', 'next_action_date', 'follow_up_mode',
  'preferred_channel', 'phone', 'proposed_value', 'notes', 'record_confidence',
] as const;

export type LeadMatchKind =
  | 'external_key' | 'email' | 'contact_organization' | 'none' | 'ambiguous';

export interface LeadMatch {
  kind: LeadMatchKind;
  lead: ExistingLead | null;
  /** Populated only when ambiguous, so the report can name every candidate. */
  candidates: ExistingLead[];
  /** How the decision was reached, in words, for the report. */
  how: string;
}

/**
 * Find the one lead this sheet row is about, or refuse.
 *
 * Three rules, tried in order, and no fourth:
 *
 *   1. The Sheet's own key. If a lead already carries (google_sheets, this key) it
 *      is the same lead, full stop. This is the normal path on every re-run.
 *   2. An exactly equal email. Addresses are unique to a person in practice, and
 *      equality here is case folding and trimming, not provider trickery.
 *   3. An exactly equal contact AND organization together. Either alone is far too
 *      weak: one Taylor is not every Taylor, and an organization is not a person.
 *
 * Any rule that finds more than one candidate returns 'ambiguous' and the row is
 * left completely alone. Leads already claimed by a different Sheet key are never
 * candidates for rules 2 and 3, because matching them would quietly steal another
 * row's lead.
 *
 * Values that announce themselves as provisional, such as "Name pending" or
 * "Unknown", are never used as evidence. Four rows in the first mirror are called
 * "Name pending" and they are four different people.
 */
export function matchLead(row: SheetLeadRow, existing: readonly ExistingLead[]): LeadMatch {
  const byKey = existing.filter(
    (lead) => lead.external_source === MIRROR_SOURCE && lead.external_key === row.leadKey,
  );
  if (byKey.length === 1) {
    return {
      kind: 'external_key',
      lead: byKey[0],
      candidates: [],
      how: `Matched on the Lead ID "${row.leadKey}", which this lead already carries.`,
    };
  }
  if (byKey.length > 1) {
    return {
      kind: 'ambiguous',
      lead: null,
      candidates: byKey,
      how: `${byKey.length} leads already carry the Lead ID "${row.leadKey}". Left unchanged.`,
    };
  }

  // Only leads that are not already spoken for by a different key.
  const unclaimed = existing.filter(
    (lead) =>
      lead.external_key === null ||
      lead.external_source !== MIRROR_SOURCE ||
      lead.external_key === row.leadKey,
  );

  if (row.email !== null && !isPlaceholder(row.email)) {
    const wanted = normalizeEmail(row.email);
    const byEmail = unclaimed.filter((lead) => normalizeEmail(lead.email) === wanted);
    if (byEmail.length === 1) {
      return {
        kind: 'email',
        lead: byEmail[0],
        candidates: [],
        how: `Matched on the email ${wanted}, which exactly one existing lead has.`,
      };
    }
    if (byEmail.length > 1) {
      return {
        kind: 'ambiguous',
        lead: null,
        candidates: byEmail,
        how: `${byEmail.length} existing leads share the email ${wanted}. Left unchanged, because picking one would be a guess about a person.`,
      };
    }
  }

  if (
    !isPlaceholder(row.contact) &&
    row.organization !== null &&
    !isPlaceholder(row.organization)
  ) {
    const wantedName = normalizeName(row.contact);
    const wantedOrg = normalizeName(row.organization);
    const byPair = unclaimed.filter(
      (lead) =>
        normalizeName(lead.prospect_name) === wantedName &&
        normalizeName(lead.organization) === wantedOrg,
    );
    if (byPair.length === 1) {
      return {
        kind: 'contact_organization',
        lead: byPair[0],
        candidates: [],
        how: `Matched on the contact and organization together, "${row.contact}" at "${row.organization}".`,
      };
    }
    if (byPair.length > 1) {
      return {
        kind: 'ambiguous',
        lead: null,
        candidates: byPair,
        how: `${byPair.length} existing leads have the contact "${row.contact}" at "${row.organization}". Left unchanged.`,
      };
    }
  }

  const why: string[] = [];
  if (row.email === null) why.push('no email on the row');
  else if (isPlaceholder(row.email)) why.push('the email reads as a placeholder');
  if (isPlaceholder(row.contact)) why.push('the contact name reads as a placeholder');
  if (row.organization === null) why.push('no organization on the row');
  else if (isPlaceholder(row.organization)) why.push('the organization reads as a placeholder');

  return {
    kind: 'none',
    lead: null,
    candidates: [],
    how:
      why.length === 0
        ? 'No existing lead carries this Lead ID, email, or contact and organization.'
        : `No existing lead matched (${why.join('; ')}).`,
  };
}

/* ------------------------------------------------------------------ the plan --- */

/** The columns the Sheet owns, as the database spells them. */
export interface LeadFields {
  prospect_name: string;
  organization: string | null;
  relationship: string | null;
  stage: LeadStage;
  current_status: string | null;
  source: string | null;
  first_contact_at: string | null;
  reported_last_touch_at: string | null;
  next_action: string | null;
  next_action_date: string | null;
  follow_up_mode: FollowUpMode;
  preferred_channel: string | null;
  email: string | null;
  phone: string | null;
  proposed_value: number | null;
  notes: string | null;
  record_confidence: string | null;
}

/**
 * A sheet row as database columns.
 *
 * Nothing is computed here. Days since touch and Follow-up status are not stored
 * at all: both are derived from the activity log and the follow-up rules, so
 * importing them would create a second, staler copy of a number the app already
 * knows how to work out.
 */
export function leadFields(row: SheetLeadRow): LeadFields {
  return {
    prospect_name: row.contact,
    organization: row.organization,
    relationship: row.relationship,
    stage: row.stage,
    current_status: row.currentStatus,
    source: row.source,
    first_contact_at: row.firstContactOn,
    reported_last_touch_at: row.reportedLastTouchOn,
    next_action: row.nextAction,
    next_action_date: row.nextFollowUpOn,
    follow_up_mode: row.followUpMode,
    preferred_channel: row.channel,
    email: row.email,
    phone: row.phone,
    proposed_value: row.proposedValue,
    notes: row.notes,
    record_confidence: row.recordConfidence,
  };
}

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * Is a stored value the same fact as the one the sheet has?
 *
 * WHY THIS IS NOT ===
 *
 * The same column arrives in different shapes depending on how it was read. A
 * date comes back from PostgREST as the string "2026-09-19" and from a direct
 * Postgres driver as a Date object. A numeric comes back as a number through one
 * and as the string "150.00" through the other. None of those are a change, and
 * treating them as one made the reconciliation report an update for every lead on
 * every run forever: harmless in the data, corrosive in the report, because a
 * number nobody can trust is worse than no number.
 *
 * Compared by meaning, then: a day against a day, an amount against an amount,
 * and anything else as text.
 */
function sameValue(previous: unknown, next: string | number): boolean {
  if (previous === null || previous === undefined) return false;
  if (previous === next) return true;

  // A day. The sheet always produces YYYY-MM-DD, so that is what to compare to.
  if (typeof next === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(next)) {
    const asDay =
      previous instanceof Date
        ? previous.toISOString().slice(0, 10)
        : String(previous).slice(0, 10);
    return asDay === next;
  }

  // An amount. 150, "150" and "150.00" are one figure.
  if (typeof next === 'number') {
    const asNumber = typeof previous === 'number' ? previous : Number(previous);
    return Number.isFinite(asNumber) && asNumber === next;
  }

  return String(previous) === String(next);
}

/**
 * What an update would actually change, and nothing it would not.
 *
 * A blank in the sheet never erases a value in the database. The sheet is a mirror
 * of what somebody wrote down by hand, and a cell they left empty is far more
 * likely to mean "I did not fill this in" than "delete what you know". So only
 * fields where the sheet has a value, and where that value differs in meaning, are
 * changed.
 *
 * A field missing from `current` counts as different, which is correct for a row
 * that genuinely lacks it and wrong for a query that forgot to select it. See
 * EXISTING_LEAD_COLUMNS for why that distinction is kept honest by the caller.
 */
export function leadChanges(
  current: Record<string, unknown>,
  desired: LeadFields,
): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const [field, next] of Object.entries(desired)) {
    if (next === null) continue;
    const previous = current[field] ?? null;
    if (!sameValue(previous, next as string | number)) {
      changes.push({ field, from: previous, to: next });
    }
  }

  return changes;
}

export type LeadAction = 'create' | 'update' | 'unchanged' | 'ambiguous';

export interface LeadPlanEntry {
  row: SheetLeadRow;
  action: LeadAction;
  /** The existing lead's id, when there is one. */
  leadId: string | null;
  match: LeadMatch;
  changes: FieldChange[];
  fields: LeadFields;
}

export type TouchAction = 'create' | 'present' | 'unlinked';

export interface TouchPlanEntry {
  row: SheetTouchRow;
  action: TouchAction;
  /** Null when the lead does not exist yet, which is normal on a first import. */
  leadId: string | null;
  reason: string;
}

/** An existing activity, as far as idempotency is concerned. */
export interface ExistingActivity {
  external_source: string | null;
  external_id: string | null;
}

export interface AmbiguityEntry {
  tab: string;
  rowNumber: number;
  label: string;
  reason: string;
  /** Candidate ids, so the ambiguity can be resolved by hand afterwards. */
  candidateIds: string[];
}

/**
 * Everything the dry run reports, and everything the live run executes.
 *
 * The same object both times. A dry run is this plan printed; a live run is this
 * plan applied. There is no second code path that could behave differently from
 * the one that was reviewed, which is the entire point.
 */
export interface ReconciliationPlan {
  leadRowsRead: number;
  touchRowsRead: number;
  leads: LeadPlanEntry[];
  touches: TouchPlanEntry[];
  leadsToCreate: number;
  leadsToUpdate: number;
  leadsUnchanged: number;
  touchesToCreate: number;
  touchesAlreadyPresent: number;
  ambiguous: AmbiguityEntry[];
  rejected: RejectedRow[];
  warnings: string[];
  /** True when nothing here would delete or overwrite anything. Always true by construction. */
  nondestructive: boolean;
}

/**
 * Decide what the import would do, without doing any of it.
 *
 * Two passes over the leads, because a decision that looks fine on its own can be
 * wrong in company: if two sheet rows both resolve to the same existing lead, each
 * of them looked like a clean match, and applying both would overwrite one person
 * with another. The second pass turns that pair into two ambiguities.
 */
export function planReconciliation(input: {
  leads: ParsedLeads;
  touches: ParsedTouches;
  existingLeads: readonly ExistingLead[];
  existingActivities: readonly ExistingActivity[];
}): ReconciliationPlan {
  const { leads, touches, existingLeads, existingActivities } = input;

  const firstPass = leads.rows.map((row) => {
    const match = matchLead(row, existingLeads);
    const fields = leadFields(row);
    return { row, match, fields };
  });

  // Which existing leads got claimed more than once.
  const claims = new Map<string, number>();
  for (const { match } of firstPass) {
    if (match.lead) claims.set(match.lead.id, (claims.get(match.lead.id) ?? 0) + 1);
  }

  const ambiguous: AmbiguityEntry[] = [];
  const entries: LeadPlanEntry[] = firstPass.map(({ row, match, fields }) => {
    const contested = match.lead !== null && (claims.get(match.lead.id) ?? 0) > 1;

    if (match.kind === 'ambiguous' || contested) {
      const reason = contested
        ? `More than one sheet row resolves to the same existing lead, so none of them was applied. ${match.how}`
        : match.how;
      ambiguous.push({
        tab: LEAD_TAB,
        rowNumber: row.rowNumber,
        label: row.leadKey,
        reason,
        candidateIds: contested && match.lead ? [match.lead.id] : match.candidates.map((c) => c.id),
      });
      return { row, action: 'ambiguous', leadId: null, match, changes: [], fields };
    }

    if (match.lead === null) {
      return { row, action: 'create', leadId: null, match, changes: [], fields };
    }

    const changes = leadChanges(match.lead as unknown as Record<string, unknown>, fields);
    // Claiming the key is a change in its own right, and the one that makes every
    // future run cheap, so a lead matched by email or name is never "unchanged".
    if (match.lead.external_key !== row.leadKey) {
      changes.push({
        field: 'external_key',
        from: match.lead.external_key,
        to: row.leadKey,
      });
    }

    return {
      row,
      action: changes.length === 0 ? 'unchanged' : 'update',
      leadId: match.lead.id,
      match,
      changes,
      fields,
    };
  });

  /* Lead key to the id it will have. Keys of ambiguous rows are deliberately
   * absent, so a touch belonging to a row the import refused to touch is reported
   * rather than attached to a guess. */
  const idByKey = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.action === 'ambiguous') continue;
    idByKey.set(entry.row.leadKey, entry.leadId);
  }
  // A lead already carrying a key but absent from the sheet still counts, so a
  // touch for somebody removed from the Lead Mirror tab still finds its lead.
  for (const lead of existingLeads) {
    if (lead.external_source !== MIRROR_SOURCE || lead.external_key === null) continue;
    if (!idByKey.has(lead.external_key)) idByKey.set(lead.external_key, lead.id);
  }

  const presentKeys = new Set(
    existingActivities
      .filter((a) => a.external_source === MIRROR_SOURCE && a.external_id !== null)
      .map((a) => a.external_id as string),
  );

  const touchEntries: TouchPlanEntry[] = touches.rows.map((row) => {
    if (!idByKey.has(row.leadKey)) {
      return {
        row,
        action: 'unlinked',
        leadId: null,
        reason: `No lead in the mirror or the database carries the Lead ID "${row.leadKey}", so this touch has nobody to attach to. Imported touches must link to the right lead, so it was left out.`,
      };
    }
    if (presentKeys.has(row.externalId)) {
      return {
        row,
        action: 'present',
        leadId: idByKey.get(row.leadKey) ?? null,
        reason: 'Already imported. Same lead, day, activity and channel.',
      };
    }
    return {
      row,
      action: 'create',
      leadId: idByKey.get(row.leadKey) ?? null,
      reason: 'Not in the activity log yet.',
    };
  });

  const rejected = [
    ...leads.rejected,
    ...touches.rejected,
    ...touchEntries
      .filter((t) => t.action === 'unlinked')
      .map((t) => ({
        tab: TOUCH_TAB,
        rowNumber: t.row.rowNumber,
        label: `${t.row.leadKey} · ${t.row.occurredOn}`,
        reason: t.reason,
      })),
  ];

  return {
    leadRowsRead: leads.rowsRead,
    touchRowsRead: touches.rowsRead,
    leads: entries,
    touches: touchEntries,
    leadsToCreate: entries.filter((e) => e.action === 'create').length,
    leadsToUpdate: entries.filter((e) => e.action === 'update').length,
    leadsUnchanged: entries.filter((e) => e.action === 'unchanged').length,
    touchesToCreate: touchEntries.filter((t) => t.action === 'create').length,
    touchesAlreadyPresent: touchEntries.filter((t) => t.action === 'present').length,
    ambiguous,
    rejected,
    warnings: leads.warnings,
    // There is no delete and no blank-overwrite anywhere in this module, and
    // leadChanges skips every null. Asserted by test rather than just claimed.
    nondestructive: true,
  };
}

/** The counts, flat, for storing against a run and showing in the Cockpit. */
export function planCounts(plan: ReconciliationPlan): Record<string, number> {
  return {
    leadRowsRead: plan.leadRowsRead,
    touchRowsRead: plan.touchRowsRead,
    leadsToCreate: plan.leadsToCreate,
    leadsToUpdate: plan.leadsToUpdate,
    leadsUnchanged: plan.leadsUnchanged,
    ambiguousMatches: plan.ambiguous.length,
    touchesToCreate: plan.touchesToCreate,
    touchesAlreadyPresent: plan.touchesAlreadyPresent,
    rejectedRows: plan.rejected.length,
  };
}

/**
 * Is this plan safe to apply without being asked again?
 *
 * The gate the sprint was given: the expected number of rows on both tabs, no
 * ambiguity at all, and nothing destructive. Anything else stops before writing
 * and reports the discrepancy, because a reconciliation that surprises you is one
 * you should look at rather than run.
 */
export function planIsSafeToApply(
  plan: ReconciliationPlan,
  expected: { leadRows: number; touchRows: number },
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (plan.leadRowsRead !== expected.leadRows) {
    reasons.push(
      `Expected ${expected.leadRows} relationship rows on the ${LEAD_TAB} tab, found ${plan.leadRowsRead}.`,
    );
  }
  if (plan.touchRowsRead !== expected.touchRows) {
    reasons.push(
      `Expected ${expected.touchRows} touch rows on the ${TOUCH_TAB} tab, found ${plan.touchRowsRead}.`,
    );
  }
  if (plan.ambiguous.length > 0) {
    reasons.push(
      `${plan.ambiguous.length} row${plan.ambiguous.length === 1 ? '' : 's'} could match more than one existing lead.`,
    );
  }
  if (plan.rejected.length > 0) {
    reasons.push(
      `${plan.rejected.length} row${plan.rejected.length === 1 ? '' : 's'} could not be read.`,
    );
  }
  if (!plan.nondestructive) {
    reasons.push('The plan would overwrite or delete existing data.');
  }

  return { ok: reasons.length === 0, reasons };
}
