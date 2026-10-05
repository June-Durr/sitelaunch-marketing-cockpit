/**
 * What the Supabase-to-Sheet export has to get right.
 *
 * Pure in, pure out: leads and touches go in, two rectangles of cell values come
 * out. Nothing here touches Google, so the ordering, the formatting and the
 * promise that no internal identifier reaches the spreadsheet can all be asserted
 * rather than eyeballed in a live sheet.
 */

import { describe, expect, it } from 'vitest';

import {
  assignMirrorKeys, buildMirrorExport, compareExportLeads, FOLLOW_UP_STATUS_SHEET_LABELS,
  leadColumnFormats, leadRowCells, slugForKey, STAGE_SHEET_LABELS, touchColumnFormats,
  touchRowCells, type ExportLead, type ExportTouch,
} from './leadMirrorExport.ts';
import { columnOf, FIRST_DATA_ROW, LEAD_HEADERS, TOUCH_HEADERS } from './leadMirrorShared.ts';
import { a1Range, columnLetter, googleReasons } from './sheets.ts';

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function lead(over: Partial<ExportLead> = {}): ExportLead {
  return {
    id: UUID_A,
    external_key: 'taylor-handyman',
    prospect_name: 'Taylor',
    organization: 'Your Local Handyman',
    relationship: 'Prospect',
    stage: 'follow_up',
    current_status: 'Awaiting materials',
    source: 'Flyer',
    first_contact_at: '2026-09-19',
    next_action: 'Send one final follow-up',
    next_action_date: '2026-10-06',
    follow_up_mode: 'auto',
    preferred_channel: 'Email',
    email: 'taylor@example.com',
    phone: null,
    proposed_value: null,
    notes: 'Cold call on Sep 19.',
    record_confidence: 'Confirmed',
    effective_last_touch_on: '2026-09-24',
    days_since_touch: 11,
    follow_up_status: 'due_soon',
    ...over,
  };
}

function touch(over: Partial<ExportTouch> = {}): ExportTouch {
  return {
    lead_id: UUID_A,
    occurred_at: '2026-09-24T12:00:00.000Z',
    title: 'Follow-up sent',
    channel: 'Email',
    details: 'Second attempt',
    evidence_source: 'Gmail',
    activity_type: 'follow_up_sent',
    ...over,
  };
}

/** Read one cell of a built row by its column name. */
const cell = (row: unknown[], headers: readonly string[], name: string) =>
  row[columnOf(headers, name)];

/* ---------------------------------------------------------------- the keys --- */

describe('the Lead ID column carries a readable key, never a row id', () => {
  it('keeps a key a lead already has', () => {
    const { keyById, assigned } = assignMirrorKeys([
      { id: UUID_A, prospect_name: 'Taylor', organization: 'Your Local Handyman', external_key: 'taylor-handyman' },
    ]);
    expect(keyById.get(UUID_A)).toBe('taylor-handyman');
    // Nothing invented, because nothing needed inventing. Rewriting an existing
    // key would orphan that lead from its whole touch history on the next import.
    expect(assigned).toEqual([]);
  });

  it('invents one from the organization when a lead has none', () => {
    const { keyById, assigned } = assignMirrorKeys([
      { id: UUID_A, prospect_name: 'Jane Doe', organization: 'Cedar Stone Waterproofing', external_key: null },
    ]);
    expect(keyById.get(UUID_A)).toBe('cedar-stone-waterproofing');
    expect(assigned).toEqual([{ leadId: UUID_A, externalKey: 'cedar-stone-waterproofing' }]);
  });

  it('falls back to the contact when there is no organization', () => {
    const { keyById } = assignMirrorKeys([
      { id: UUID_A, prospect_name: 'Yaritza Kwan', organization: null, external_key: null },
    ]);
    expect(keyById.get(UUID_A)).toBe('yaritza-kwan');
  });

  it('never derives a key from the row id, not even a fragment of it', () => {
    const { keyById } = assignMirrorKeys([
      { id: UUID_A, prospect_name: 'Taylor', organization: null, external_key: null },
    ]);
    const key = keyById.get(UUID_A) as string;
    expect(key).not.toContain('aaaa');
    expect(UUID_A).not.toContain(key);
  });

  it('separates two leads that would slug the same way, in a settled order', () => {
    const leads = [
      { id: UUID_C, prospect_name: 'One', organization: 'Cedar Stone', external_key: null },
      { id: UUID_A, prospect_name: 'Two', organization: 'Cedar Stone', external_key: null },
      { id: UUID_B, prospect_name: 'Three', organization: 'Cedar Stone', external_key: null },
    ];
    const first = assignMirrorKeys(leads);
    // Assigned in id order, so the result does not depend on how the rows came
    // back from the database.
    expect(first.keyById.get(UUID_A)).toBe('cedar-stone');
    expect(first.keyById.get(UUID_B)).toBe('cedar-stone-2');
    expect(first.keyById.get(UUID_C)).toBe('cedar-stone-3');

    // Same input in a different order, same answer.
    const second = assignMirrorKeys([...leads].reverse());
    expect(second.keyById).toEqual(first.keyById);
  });

  it('does not collide with a key somebody already has', () => {
    const { keyById } = assignMirrorKeys([
      { id: UUID_B, prospect_name: 'Held', organization: 'Cedar Stone', external_key: 'cedar-stone' },
      { id: UUID_A, prospect_name: 'New', organization: 'Cedar Stone', external_key: null },
    ]);
    expect(keyById.get(UUID_B)).toBe('cedar-stone');
    expect(keyById.get(UUID_A)).toBe('cedar-stone-2');
  });

  it('makes a usable slug out of awkward names', () => {
    expect(slugForKey('Groovin’ Bean')).toBe('groovin-bean');
    expect(slugForKey('José & Co.')).toBe('jose-co');
    expect(slugForKey('  Moth to Flame  ')).toBe('moth-to-flame');
    expect(slugForKey('DJ 4THE WIN')).toBe('dj-4the-win');
    // Nothing usable at all still has to produce something.
    expect(slugForKey('!!!')).toBe('unnamed-lead');
    expect(slugForKey(null)).toBe('unnamed-lead');
  });
});

/* -------------------------------------------------------------- the ordering --- */

describe('the order is worst first, and settled by the data alone', () => {
  const keys = new Map([[UUID_A, 'a'], [UUID_B, 'b'], [UUID_C, 'c']]);

  it('puts an overdue lead above one due today', () => {
    const overdue = lead({ id: UUID_A, follow_up_status: 'overdue' });
    const today = lead({ id: UUID_B, follow_up_status: 'due_today' });
    expect(compareExportLeads(overdue, today, keys)).toBeLessThan(0);
  });

  it('puts anything active above the deliberate states', () => {
    const scheduled = lead({ id: UUID_A, follow_up_status: 'scheduled' });
    for (const quiet of ['not_scheduled', 'on_hold', 'archived', 'closed']) {
      const other = lead({ id: UUID_B, follow_up_status: quiet });
      expect(compareExportLeads(scheduled, other, keys), quiet).toBeLessThan(0);
    }
  });

  it('puts the sooner date first within the same status', () => {
    const soon = lead({ id: UUID_A, next_action_date: '2026-10-06' });
    const later = lead({ id: UUID_B, next_action_date: '2026-10-07' });
    expect(compareExportLeads(soon, later, keys)).toBeLessThan(0);
  });

  it('puts a lead with no date below one that has a date', () => {
    const dated = lead({ id: UUID_A, next_action_date: '2099-01-01' });
    const undated = lead({ id: UUID_B, next_action_date: null });
    expect(compareExportLeads(dated, undated, keys)).toBeLessThan(0);
  });

  it('breaks a remaining tie on the mirror key, which is unique', () => {
    const a = lead({ id: UUID_A });
    const b = lead({ id: UUID_B });
    expect(compareExportLeads(a, b, keys)).toBeLessThan(0);
    expect(compareExportLeads(b, a, keys)).toBeGreaterThan(0);
    // No pair ever compares equal, so the sort is fully determined.
    expect(compareExportLeads(a, a, keys)).toBe(0);
  });

  it('produces the same sheet from the same data, whatever order it arrived in', () => {
    const leads = [
      lead({ id: UUID_A, external_key: 'a', follow_up_status: 'scheduled', next_action_date: '2026-11-09' }),
      lead({ id: UUID_B, external_key: 'b', follow_up_status: 'overdue', next_action_date: '2026-09-01' }),
      lead({ id: UUID_C, external_key: 'c', follow_up_status: 'not_scheduled', next_action_date: null }),
    ];
    const forwards = buildMirrorExport({ leads, touches: [], leadGridRows: 26, touchGridRows: 20 });
    const backwards = buildMirrorExport({
      leads: [...leads].reverse(), touches: [], leadGridRows: 26, touchGridRows: 20,
    });

    expect(forwards.leadTab.values).toEqual(backwards.leadTab.values);
    // And it is the order the sheet should be worked in.
    expect(forwards.leadTab.values.map((row) => cell(row, LEAD_HEADERS, 'Lead ID')))
      .toEqual(['b', 'a', 'c']);
  });

  it('puts the newest touch at the top, as the tab already reads', () => {
    const touches = [
      touch({ occurred_at: '2026-09-19T12:00:00.000Z', title: 'Discovery conversation' }),
      touch({ occurred_at: '2026-09-30T12:00:00.000Z', title: 'Follow-up sent' }),
      touch({ occurred_at: '2026-09-24T12:00:00.000Z', title: 'Follow-up sent' }),
    ];
    const built = buildMirrorExport({
      leads: [lead()], touches, leadGridRows: 26, touchGridRows: 20,
    });
    expect(built.touchTab.values.map((row) => cell(row, TOUCH_HEADERS, 'Date')))
      .toEqual(['2026-09-30', '2026-09-24', '2026-09-19']);
  });

  it('settles two touches on the same day by key then wording', () => {
    const touches = [
      touch({ occurred_at: '2026-09-24T12:00:00.000Z', title: 'Reply received' }),
      touch({ occurred_at: '2026-09-24T12:00:00.000Z', title: 'Follow-up sent' }),
    ];
    const built = buildMirrorExport({
      leads: [lead()], touches, leadGridRows: 26, touchGridRows: 20,
    });
    expect(built.touchTab.values.map((row) => cell(row, TOUCH_HEADERS, 'Activity')))
      .toEqual(['Follow-up sent', 'Reply received']);
  });
});

/* ------------------------------------------------------------ the formatting --- */

describe('the cells say what the column means', () => {
  it('writes every column in the sheet’s own order', () => {
    const row = leadRowCells(lead(), 'taylor-handyman');
    expect(row).toHaveLength(LEAD_HEADERS.length);

    expect(cell(row, LEAD_HEADERS, 'Lead ID')).toBe('taylor-handyman');
    expect(cell(row, LEAD_HEADERS, 'Contact')).toBe('Taylor');
    expect(cell(row, LEAD_HEADERS, 'Organization')).toBe('Your Local Handyman');
    expect(cell(row, LEAD_HEADERS, 'Stage')).toBe('Follow-up');
    expect(cell(row, LEAD_HEADERS, 'Days since touch')).toBe(11);
    expect(cell(row, LEAD_HEADERS, 'Follow-up status')).toBe('DUE SOON');
  });

  it('keeps the wording the sheet has always used for a status', () => {
    expect(FOLLOW_UP_STATUS_SHEET_LABELS.due_soon).toBe('DUE SOON');
    expect(FOLLOW_UP_STATUS_SHEET_LABELS.scheduled).toBe('SCHEDULED');
    expect(FOLLOW_UP_STATUS_SHEET_LABELS.not_scheduled).toBe('NOT SCHEDULED');
  });

  it('keeps the stage names a person reads', () => {
    expect(STAGE_SHEET_LABELS.waiting).toBe('Waiting');
    expect(STAGE_SHEET_LABELS.new_contact).toBe('New contact');
    expect(STAGE_SHEET_LABELS.follow_up).toBe('Follow-up');
  });

  it('writes dates unambiguously, as ISO, and formats them for reading', () => {
    const row = leadRowCells(lead(), 'k');
    // 09/27/26 means two different days depending on the sheet's locale. ISO
    // means one day everywhere, and the number format below makes it readable.
    expect(cell(row, LEAD_HEADERS, 'First contact')).toBe('2026-09-19');
    expect(cell(row, LEAD_HEADERS, 'Last touch')).toBe('2026-09-24');
    expect(cell(row, LEAD_HEADERS, 'Next follow-up')).toBe('2026-10-06');

    const dateColumns = leadColumnFormats().filter((f) => f.type === 'DATE');
    expect(dateColumns.map((f) => f.pattern)).toEqual(['mm/dd/yy', 'mm/dd/yy', 'mm/dd/yy']);
    expect(dateColumns.map((f) => f.column)).toEqual([
      columnOf(LEAD_HEADERS, 'First contact'),
      columnOf(LEAD_HEADERS, 'Last touch'),
      columnOf(LEAD_HEADERS, 'Next follow-up'),
    ]);
    expect(touchColumnFormats()[0]).toEqual({
      column: columnOf(TOUCH_HEADERS, 'Date'),
      type: 'DATE',
      pattern: 'mm/dd/yy',
    });
  });

  it('writes a blank as an empty cell, never as a word', () => {
    const row = leadRowCells(
      lead({
        organization: null, relationship: null, current_status: null, source: null,
        first_contact_at: null, next_action: null, next_action_date: null,
        preferred_channel: null, email: null, phone: null, proposed_value: null,
        notes: null, record_confidence: null, effective_last_touch_on: null,
        days_since_touch: null,
      }),
      'k',
    );

    for (const header of LEAD_HEADERS) {
      if (header === 'Lead ID' || header === 'Contact' || header === 'Stage') continue;
      if (header === 'Follow-up status') continue;
      expect(cell(row, LEAD_HEADERS, header), header).toBe('');
    }
    // Not the string "null", not "None", not 0.
    expect(row).not.toContain('null');
    expect(row).not.toContain(0);
  });

  it('writes an amount as a number so the sheet can total it', () => {
    const row = leadRowCells(lead({ proposed_value: 150 }), 'k');
    expect(cell(row, LEAD_HEADERS, 'Proposed value')).toBe(150);
    expect(cell(row, LEAD_HEADERS, 'Proposed value')).not.toBe('$150');
  });

  it('writes a touch row with its lead’s readable key and the lead’s own name', () => {
    const row = touchRowCells(touch(), lead(), 'taylor-handyman');
    expect(row).toHaveLength(TOUCH_HEADERS.length);
    expect(cell(row, TOUCH_HEADERS, 'Date')).toBe('2026-09-24');
    expect(cell(row, TOUCH_HEADERS, 'Lead ID')).toBe('taylor-handyman');
    expect(cell(row, TOUCH_HEADERS, 'Contact')).toBe('Taylor');
    expect(cell(row, TOUCH_HEADERS, 'Organization')).toBe('Your Local Handyman');
    expect(cell(row, TOUCH_HEADERS, 'Activity')).toBe('Follow-up sent');
    expect(cell(row, TOUCH_HEADERS, 'Channel')).toBe('Email');
    expect(cell(row, TOUCH_HEADERS, 'Details')).toBe('Second attempt');
    expect(cell(row, TOUCH_HEADERS, 'Evidence / source')).toBe('Gmail');
  });
});

/* ------------------------------------------------- nothing private gets out --- */

describe('nothing internal or private reaches the spreadsheet', () => {
  const built = buildMirrorExport({
    leads: [lead({ id: UUID_A }), lead({ id: UUID_B, external_key: null, organization: 'Cedar Stone' })],
    touches: [touch({ lead_id: UUID_A }), touch({ lead_id: UUID_B })],
    leadGridRows: 26,
    touchGridRows: 20,
  });

  const everyCell = [...built.leadTab.values, ...built.touchTab.values]
    .flat()
    .map((value) => String(value ?? ''));

  it('writes no row id anywhere, on either tab', () => {
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const value of everyCell) expect(UUID.test(value), value).toBe(false);
    expect(everyCell).not.toContain(UUID_A);
    expect(everyCell).not.toContain(UUID_B);
  });

  it('writes nothing that looks like a credential', () => {
    const forbidden = [
      'private_key', 'BEGIN PRIVATE KEY', 'access_token', 'refresh_token',
      'service_role', 'gserviceaccount', 'client_secret', 'owner_id', 'connection_id',
    ];
    const joined = everyCell.join(' ').toLowerCase();
    for (const word of forbidden) expect(joined, word).not.toContain(word.toLowerCase());
  });
});

/* ------------------------------------------------------------- the ranges --- */

describe('the write stays below the header and clears what it should', () => {
  it('starts at the first data row and never above it', () => {
    const built = buildMirrorExport({
      leads: [lead()], touches: [touch()], leadGridRows: 26, touchGridRows: 20,
    });
    expect(built.leadTab.range).toBe(`A${FIRST_DATA_ROW}:S${FIRST_DATA_ROW}`);
    expect(built.touchTab.range).toBe(`A${FIRST_DATA_ROW}:H${FIRST_DATA_ROW}`);
  });

  it('spans exactly as many rows as there is data', () => {
    const built = buildMirrorExport({
      leads: [lead({ id: UUID_A }), lead({ id: UUID_B, external_key: 'b' })],
      touches: [],
      leadGridRows: 26,
      touchGridRows: 20,
    });
    expect(built.leadTab.range).toBe('A6:S7');
    expect(built.leadRows).toBe(2);
  });

  it('empties the rows a previous, longer export left behind', () => {
    const built = buildMirrorExport({
      leads: [lead()], touches: [], leadGridRows: 26, touchGridRows: 20,
    });
    // Row 6 is written; 7 to 26 are emptied, and nothing beyond the grid.
    expect(built.leadTab.clearRange).toBe('A7:S26');
  });

  it('asks to clear nothing when the data already fills the grid', () => {
    const built = buildMirrorExport({
      leads: [lead()], touches: [], leadGridRows: FIRST_DATA_ROW, touchGridRows: 20,
    });
    expect(built.leadTab.clearRange).toBeNull();
  });

  it('writes no values but still clears when there is nothing at all to show', () => {
    const built = buildMirrorExport({
      leads: [], touches: [], leadGridRows: 26, touchGridRows: 20,
    });
    expect(built.leadTab.range).toBeNull();
    expect(built.leadTab.values).toEqual([]);
    expect(built.leadTab.clearRange).toBe('A6:S26');
  });
});

/* ------------------------------------------------------------ what is shown --- */

describe('the Touch History tab shows touches and only touches', () => {
  it('leaves out the activities that are not contact with a person', () => {
    const built = buildMirrorExport({
      leads: [lead()],
      touches: [
        touch({ title: 'Follow-up sent', activity_type: 'follow_up_sent' }),
        touch({ title: 'Checked the numbers', activity_type: 'analytics_check' }),
        touch({ title: 'Published the case study', activity_type: 'content_published' }),
        touch({ title: 'Did the build', activity_type: 'client_work' }),
      ],
      leadGridRows: 26,
      touchGridRows: 20,
    });
    expect(built.touchTab.values.map((row) => cell(row, TOUCH_HEADERS, 'Activity')))
      .toEqual(['Follow-up sent']);
  });

  it('leaves out a touch whose lead is not in the export rather than writing it orphaned', () => {
    const built = buildMirrorExport({
      leads: [lead({ id: UUID_A })],
      touches: [touch({ lead_id: UUID_A }), touch({ lead_id: 'a-lead-that-is-gone' })],
      leadGridRows: 26,
      touchGridRows: 20,
    });
    expect(built.touchRows).toBe(1);
    expect(cell(built.touchTab.values[0], TOUCH_HEADERS, 'Lead ID')).toBe('taylor-handyman');
  });
});

/* ================================================== the Sheets client bits === */

describe('an A1 range names the right tab', () => {
  it('quotes a tab name with a space in it', () => {
    // Unquoted, the API reads "Lead" as the tab and "Mirror!A6" as nonsense.
    expect(a1Range('Lead Mirror', 'A6:S26')).toBe("'Lead Mirror'!A6:S26");
  });

  it('doubles a quote inside a tab name, which is the A1 escaping rule', () => {
    expect(a1Range("Alberto's Sheet", 'A1')).toBe("'Alberto''s Sheet'!A1");
  });
});

describe('column letters', () => {
  it('counts past Z the way a spreadsheet does', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(7)).toBe('H');
    expect(columnLetter(18)).toBe('S');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
    expect(columnLetter(51)).toBe('AZ');
    expect(columnLetter(52)).toBe('BA');
  });

  it('covers both tabs, so a range never runs short of its own header', () => {
    expect(columnLetter(LEAD_HEADERS.length - 1)).toBe('S');
    expect(columnLetter(TOUCH_HEADERS.length - 1)).toBe('H');
  });
});

/**
 * Why a failed Sheets call keeps Google's reason codes and nothing else.
 *
 * A 403 is either "nobody shared the spreadsheet" or "the Sheets API is switched
 * off", and the status code alone cannot tell them apart. Keeping the reason codes
 * turned an afternoon of guessing into one line. Keeping anything else from that
 * body would have risked writing a credential into an error column the owner can
 * read.
 */
describe('a Google failure gives up its reason codes and nothing else', () => {
  it('reads the status enum', () => {
    expect(googleReasons({ error: { status: 'PERMISSION_DENIED' } }))
      .toEqual(['PERMISSION_DENIED']);
  });

  it('reads the reason out of the details, which is where SERVICE_DISABLED lives', () => {
    const body = {
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        details: [{ reason: 'SERVICE_DISABLED' }, { reason: 'SERVICE_DISABLED' }],
      },
    };
    // Deduplicated, and both kept, because together they say which 403 this is.
    expect(googleReasons(body).sort()).toEqual(['PERMISSION_DENIED', 'SERVICE_DISABLED']);
  });

  it('tells the two kinds of 403 apart', () => {
    const notShared = { error: { code: 403, status: 'PERMISSION_DENIED' } };
    const apiOff = {
      error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] },
    };
    expect(googleReasons(notShared)).not.toContain('SERVICE_DISABLED');
    expect(googleReasons(apiOff)).toContain('SERVICE_DISABLED');
  });

  it('refuses anything that is not a bare enum token', () => {
    // The filter is the shape, not the field name, which is what makes it safe.
    const body = {
      error: {
        status: 'sitelaunch-cockpit-sync@sitelaunch-marketing-cockpit.iam.gserviceaccount.com',
        details: [
          { reason: '-----BEGIN PRIVATE KEY-----MIIEvQIBADANB' },
          { reason: 'ya29.a0AfH6SMBx_notarealtoken' },
          { reason: 'Alberto Camacho' },
          { reason: 'The caller does not have permission' },
          { reason: '+1 203-522-3232' },
          { reason: 'lower_case_reason' },
          { reason: 'AB' },
        ],
      },
    };
    expect(googleReasons(body)).toEqual([]);
  });

  it('cannot be made to leak the message field, whatever is in it', () => {
    const body = {
      error: {
        code: 403,
        message: 'The caller does not have permission. Request had client_email=x@y.com',
        status: 'PERMISSION_DENIED',
      },
    };
    expect(googleReasons(body)).toEqual(['PERMISSION_DENIED']);
    expect(googleReasons(body).join(' ')).not.toContain('client_email');
  });

  it('says nothing rather than throwing when there is no error object', () => {
    expect(googleReasons(null)).toEqual([]);
    expect(googleReasons({})).toEqual([]);
    expect(googleReasons({ error: {} })).toEqual([]);
    expect(googleReasons({ error: { details: 'not an array' } })).toEqual([]);
    expect(googleReasons('a string')).toEqual([]);
    expect(googleReasons({ error: { details: [null, 7, 'x'] } })).toEqual([]);
  });
});
