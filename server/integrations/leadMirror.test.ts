/**
 * What the lead mirror reconciliation has to get right.
 *
 * Nothing here touches Google, Supabase or the real spreadsheet. The input is a
 * grid of strings, exactly the shape the Sheets API returns, written out in this
 * file so every case can be read next to the assertion about it. The people in
 * these fixtures are invented.
 *
 * The tests are organised around the promises the importer makes, because those
 * are what would actually hurt if they broke: a blank read as a zero, two
 * different people merged into one, a touch attached to the wrong person, or a
 * second run quietly doubling everything.
 */

import { describe, expect, it } from 'vitest';

import {
  blankToNull, checkHeaders, dayToTimestamp, FIRST_DATA_ROW, isPlaceholder,
  LEAD_HEADERS, LEAD_TAB, leadChanges, leadFields, matchLead, MIRROR_SOURCE,
  normalizeEmail, normalizeName, parseActivityType, parseFollowUpMode, parseLeadRows,
  parseMoney, parseSheetDate, parseStage, parseTouchRows, planCounts,
  planIsSafeToApply, planReconciliation, TOUCH_HEADERS, TOUCH_TAB, touchFingerprint,
  type ExistingActivity, type ExistingLead, type SheetLeadRow,
} from './leadMirror.ts';

/* ----------------------------------------------------------------- helpers --- */

/** A Lead Mirror row as a grid row, named by column so a test reads clearly. */
function leadRow(values: Partial<Record<(typeof LEAD_HEADERS)[number], string>>): string[] {
  return LEAD_HEADERS.map((header) => values[header] ?? '');
}

function touchRow(values: Partial<Record<(typeof TOUCH_HEADERS)[number], string>>): string[] {
  return TOUCH_HEADERS.map((header) => values[header] ?? '');
}

/** The smallest row that parses, so a test can vary exactly one thing. */
const MINIMAL = {
  'Lead ID': 'taylor-handyman',
  Contact: 'Taylor',
  Organization: 'Your Local Handyman',
  Stage: 'Follow-up',
};

function existing(over: Partial<ExistingLead> = {}): ExistingLead {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    prospect_name: 'Taylor',
    organization: 'Your Local Handyman',
    email: null,
    external_source: null,
    external_key: null,
    ...over,
  };
}

function plan(input: {
  leads?: string[][];
  touches?: string[][];
  existingLeads?: ExistingLead[];
  existingActivities?: ExistingActivity[];
}) {
  return planReconciliation({
    leads: parseLeadRows(input.leads ?? []),
    touches: parseTouchRows(input.touches ?? []),
    existingLeads: input.existingLeads ?? [],
    existingActivities: input.existingActivities ?? [],
  });
}

/* ------------------------------------------------------------- the headers --- */

describe('the header has to be the header the importer was written for', () => {
  it('accepts the real header, in order', () => {
    const check = checkHeaders([...LEAD_HEADERS], LEAD_HEADERS);
    expect(check.ok).toBe(true);
    expect(check.missing).toEqual([]);
    expect(check.misplaced).toEqual([]);
  });

  it('ignores case and surrounding space, because those are not a different column', () => {
    const sloppy = LEAD_HEADERS.map((h) => `  ${h.toUpperCase()} `);
    expect(checkHeaders(sloppy, LEAD_HEADERS).ok).toBe(true);
  });

  it('names a column that is simply not there', () => {
    const without = LEAD_HEADERS.filter((h) => h !== 'Proposed value');
    const check = checkHeaders(without, LEAD_HEADERS);

    expect(check.ok).toBe(false);
    // Only that column is actually gone. The ones after it still exist, one
    // place to the left, so they are reported as moved rather than missing,
    // which is the more useful thing to tell somebody looking for the cause.
    expect(check.missing).toEqual(['Proposed value']);
    expect(check.misplaced.join(' ')).toContain('Context / notes');
    expect(check.misplaced.join(' ')).toContain('Record confidence');
  });

  it('catches a column that moved rather than reading it by position anyway', () => {
    const swapped = [...LEAD_HEADERS];
    [swapped[14], swapped[15]] = [swapped[15], swapped[14]];
    const check = checkHeaders(swapped, LEAD_HEADERS);

    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([]);
    expect(check.misplaced).toHaveLength(2);
    expect(check.misplaced.join(' ')).toContain('Email');
    expect(check.misplaced.join(' ')).toContain('Phone / WhatsApp');
  });

  it('rejects an empty header row rather than reading a sheet it cannot understand', () => {
    expect(checkHeaders([], LEAD_HEADERS).ok).toBe(false);
    expect(checkHeaders([], TOUCH_HEADERS).ok).toBe(false);
  });
});

/* -------------------------------------------------------------- blanks --- */

describe('a blank cell stays blank', () => {
  it('turns every empty optional column into null, never into an empty string', () => {
    const parsed = parseLeadRows([leadRow(MINIMAL)]);
    expect(parsed.rejected).toEqual([]);

    const fields = leadFields(parsed.rows[0]);
    for (const key of [
      'relationship', 'current_status', 'source', 'first_contact_at',
      'reported_last_touch_at', 'next_action', 'next_action_date',
      'preferred_channel', 'email', 'phone', 'notes', 'record_confidence',
    ] as const) {
      expect(fields[key], key).toBeNull();
    }
  });

  it('never turns a missing amount into zero', () => {
    const parsed = parseLeadRows([leadRow(MINIMAL)]);
    expect(parsed.rows[0].proposedValue).toBeNull();
    expect(parsed.rows[0].proposedValue).not.toBe(0);
  });

  it('keeps a real zero as zero, because that is a different fact', () => {
    const parsed = parseLeadRows([leadRow({ ...MINIMAL, 'Proposed value': '0' })]);
    expect(parsed.rows[0].proposedValue).toBe(0);
  });

  it('treats whitespace as blank, since nobody means to record a space', () => {
    expect(blankToNull('   ')).toBeNull();
    expect(blankToNull('\t')).toBeNull();
    expect(blankToNull(' x ')).toBe('x');
  });

  it('reads a short row as blanks rather than as undefined', () => {
    // Google trims trailing empty cells, so a row really does arrive short.
    const parsed = parseLeadRows([['chef-groovin-bean', 'Chef', 'Groovin Bean', '', 'Waiting']]);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.rows[0].notes).toBeNull();
    expect(parsed.rows[0].recordConfidence).toBeNull();
  });

  it('skips a row of nothing instead of rejecting it', () => {
    const parsed = parseLeadRows([leadRow(MINIMAL), [], ['', '', '']]);
    expect(parsed.rowsRead).toBe(1);
    expect(parsed.rejected).toEqual([]);
  });
});

/* ---------------------------------------------------------------- the dates --- */

describe('a date is read or refused, never guessed', () => {
  it('reads the sheet’s own month-first format', () => {
    expect(parseSheetDate('09/27/26')).toEqual({ kind: 'date', value: '2026-09-27' });
    expect(parseSheetDate('3/2/26')).toEqual({ kind: 'date', value: '2026-03-02' });
  });

  it('reads ISO, which is what the rest of the app speaks', () => {
    expect(parseSheetDate('2026-09-27')).toEqual({ kind: 'date', value: '2026-09-27' });
  });

  it('reads a four digit year without turning it into 2026', () => {
    expect(parseSheetDate('09/27/2026')).toEqual({ kind: 'date', value: '2026-09-27' });
  });

  it('reads a raw serial, for when the sheet hands back a number', () => {
    // 30 December 1899 plus 46292 days.
    expect(parseSheetDate('46292')).toEqual({ kind: 'date', value: '2026-09-27' });
  });

  it('calls a blank blank and not the epoch', () => {
    expect(parseSheetDate('')).toEqual({ kind: 'blank' });
    expect(parseSheetDate('   ')).toEqual({ kind: 'blank' });
    expect(parseSheetDate(null)).toEqual({ kind: 'blank' });
  });

  it('refuses a day that does not exist rather than rolling it forward', () => {
    expect(parseSheetDate('02/31/26').kind).toBe('invalid');
    expect(parseSheetDate('2026-02-31').kind).toBe('invalid');
    expect(parseSheetDate('13/01/26').kind).toBe('invalid');
  });

  it('refuses prose', () => {
    expect(parseSheetDate('last Tuesday').kind).toBe('invalid');
    expect(parseSheetDate('Sep 2026').kind).toBe('invalid');
    expect(parseSheetDate('TBD').kind).toBe('invalid');
  });

  it('rejects the whole row when a date cannot be read, rather than importing it blank', () => {
    const parsed = parseLeadRows([leadRow({ ...MINIMAL, 'First contact': 'sometime in March' })]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].reason).toContain('First contact');
    expect(parsed.rejected[0].rowNumber).toBe(FIRST_DATA_ROW);
  });

  it('stores a date-only touch at noon UTC, so the day survives any timezone', () => {
    expect(dayToTimestamp('2026-09-30')).toBe('2026-09-30T12:00:00.000Z');
    // The property that matters: reading the day back gives the day written.
    expect(dayToTimestamp('2026-09-30').slice(0, 10)).toBe('2026-09-30');
  });
});

/* --------------------------------------------------------------- the money --- */

describe('an amount is read or refused', () => {
  it('reads a currency symbol and separators', () => {
    expect(parseMoney('$150')).toEqual({ kind: 'amount', value: 150 });
    expect(parseMoney('$1,500.50')).toEqual({ kind: 'amount', value: 1500.5 });
    expect(parseMoney('150')).toEqual({ kind: 'amount', value: 150 });
  });

  it('calls a blank blank', () => {
    expect(parseMoney('')).toEqual({ kind: 'blank' });
  });

  it('refuses a word rather than reading it as nothing', () => {
    expect(parseMoney('TBD').kind).toBe('invalid');
    expect(parseMoney('about $150').kind).toBe('invalid');
  });
});

/* ---------------------------------------------------------------- mapping --- */

describe('the sheet’s own words map to the app’s', () => {
  it('reads every stage the mirror uses', () => {
    expect(parseStage('Waiting')).toBe('waiting');
    expect(parseStage('Follow-up')).toBe('follow_up');
    expect(parseStage('New contact')).toBe('new_contact');
  });

  it('refuses a stage it does not know instead of defaulting to one', () => {
    expect(parseStage('Thinking about it')).toBeNull();
    expect(parseStage('')).toBeNull();
  });

  it('rejects the row when the stage is unreadable, because the stage drives everything', () => {
    const parsed = parseLeadRows([leadRow({ ...MINIMAL, Stage: 'Maybe' })]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.rejected[0].reason).toContain('Maybe');
  });

  it('reads only the follow-up statuses that express a decision', () => {
    expect(parseFollowUpMode('NOT SCHEDULED')).toBe('none');
    expect(parseFollowUpMode('ON HOLD')).toBe('hold');
    expect(parseFollowUpMode('ARCHIVED')).toBe('archived');
    // These are worked out from the date and carry no intent at all.
    expect(parseFollowUpMode('DUE SOON')).toBeNull();
    expect(parseFollowUpMode('SCHEDULED')).toBeNull();
  });

  it('honours NOT SCHEDULED when there is no date to contradict it', () => {
    const parsed = parseLeadRows([
      leadRow({ ...MINIMAL, 'Follow-up status': 'NOT SCHEDULED' }),
    ]);
    expect(parsed.rows[0].followUpMode).toBe('none');
    expect(parsed.rows[0].nextFollowUpOn).toBeNull();
  });

  it('keeps the date and reports the contradiction when a row says both', () => {
    const parsed = parseLeadRows([
      leadRow({
        ...MINIMAL,
        'Follow-up status': 'NOT SCHEDULED',
        'Next follow-up': '10/06/26',
      }),
    ]);
    // The more specific claim wins, and nothing is resolved silently.
    expect(parsed.rows[0].followUpMode).toBe('auto');
    expect(parsed.rows[0].nextFollowUpOn).toBe('2026-10-06');
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain('NOT SCHEDULED');
  });

  it('maps known touch labels and keeps unknown ones as other', () => {
    expect(parseActivityType('Follow-up sent')).toBe('follow_up_sent');
    expect(parseActivityType('Discovery conversation')).toBe('conversation');
    expect(parseActivityType('Reply received')).toBe('reply_received');
    expect(parseActivityType('Carrier pigeon')).toBe('other');
  });

  it('never loses the original wording, whatever it maps to', () => {
    const parsed = parseTouchRows([
      touchRow({ Date: '09/30/26', 'Lead ID': 'x', Activity: 'Carrier pigeon' }),
    ]);
    expect(parsed.rows[0].activityType).toBe('other');
    expect(parsed.rows[0].activityLabel).toBe('Carrier pigeon');
  });

  it('does not read Days since touch or Follow-up status as data', () => {
    // Both are derived from the activity log and the follow-up rules. Importing
    // them would create a second, staler copy of a number the app can work out.
    const parsed = parseLeadRows([
      leadRow({ ...MINIMAL, 'Days since touch': '999', 'Follow-up status': 'DUE SOON' }),
    ]);
    const fields = leadFields(parsed.rows[0]) as unknown as Record<string, unknown>;
    expect(fields.days_since_touch).toBeUndefined();
    expect(fields.follow_up_status).toBeUndefined();
  });
});

/* -------------------------------------------------------------- normalizing --- */

describe('normalizing is case and spacing only', () => {
  it('folds case and collapses runs of space', () => {
    expect(normalizeName('  Taylor   Smith ')).toBe('taylor smith');
    expect(normalizeEmail('  Razila@ClientsMax.COM ')).toBe('razila@clientsmax.com');
  });

  it('does not strip punctuation, because that would merge different people', () => {
    expect(normalizeName("O'Brien")).not.toBe(normalizeName('OBrien'));
  });

  it('does not fold gmail dots, because that is a fact about Gmail and not about email', () => {
    expect(normalizeEmail('a.b@gmail.com')).not.toBe(normalizeEmail('ab@gmail.com'));
  });

  it('knows a provisional value when it sees one', () => {
    for (const value of ['Name pending', 'Chef — name pending', 'Unknown', 'TBD', 'n/a', '']) {
      expect(isPlaceholder(value), value).toBe(true);
    }
    for (const value of ['Taylor', 'Razila Bastola', 'FA Cafe']) {
      expect(isPlaceholder(value), value).toBe(false);
    }
  });
});

/* ---------------------------------------------------------------- matching --- */

describe('matching finds one person or refuses', () => {
  const row = (over: Partial<Record<(typeof LEAD_HEADERS)[number], string>> = {}) =>
    parseLeadRows([leadRow({ ...MINIMAL, ...over })]).rows[0] as SheetLeadRow;

  it('matches on the sheet’s own key, which is the normal path on a re-run', () => {
    const lead = existing({ external_source: MIRROR_SOURCE, external_key: 'taylor-handyman' });
    const match = matchLead(row(), [lead]);
    expect(match.kind).toBe('external_key');
    expect(match.lead?.id).toBe(lead.id);
  });

  it('matches on an exactly equal email', () => {
    const lead = existing({ email: 'TAYLOR@example.com', prospect_name: 'T. Smith' });
    const match = matchLead(row({ Email: 'taylor@example.com' }), [lead]);
    expect(match.kind).toBe('email');
    expect(match.lead?.id).toBe(lead.id);
  });

  it('matches on contact and organization together', () => {
    const match = matchLead(row(), [existing()]);
    expect(match.kind).toBe('contact_organization');
  });

  it('will not match on a name alone', () => {
    const match = matchLead(row({ Organization: 'A Different Company' }), [existing()]);
    expect(match.kind).toBe('none');
    expect(match.lead).toBeNull();
  });

  it('will not match on an organization alone', () => {
    const match = matchLead(row({ Contact: 'Somebody Else' }), [existing()]);
    expect(match.kind).toBe('none');
  });

  it('refuses when two existing leads share the email', () => {
    const match = matchLead(row({ Email: 'shared@example.com' }), [
      existing({ id: 'a', email: 'shared@example.com', prospect_name: 'One' }),
      existing({ id: 'b', email: 'shared@example.com', prospect_name: 'Two' }),
    ]);
    expect(match.kind).toBe('ambiguous');
    expect(match.candidates.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('refuses when two existing leads share the contact and organization', () => {
    const match = matchLead(row(), [existing({ id: 'a' }), existing({ id: 'b' })]);
    expect(match.kind).toBe('ambiguous');
  });

  it('never uses a provisional name as evidence, even with an organization', () => {
    // Four rows in the first mirror are called "Name pending" and they are four
    // different people. Matching on it would merge them.
    const match = matchLead(row({ Contact: 'Name pending' }), [
      existing({ prospect_name: 'Name pending' }),
    ]);
    expect(match.kind).toBe('none');
    expect(match.how).toContain('placeholder');
  });

  it('never uses a provisional organization as evidence', () => {
    const match = matchLead(row({ Organization: 'Unknown' }), [
      existing({ organization: 'Unknown' }),
    ]);
    expect(match.kind).toBe('none');
  });

  it('will not steal a lead another sheet row already claims', () => {
    const claimed = existing({
      external_source: MIRROR_SOURCE,
      external_key: 'somebody-else',
      email: 'taylor@example.com',
    });
    const match = matchLead(row({ Email: 'taylor@example.com' }), [claimed]);
    expect(match.kind).toBe('none');
  });

  it('still matches a lead claimed by this same key', () => {
    const claimed = existing({
      external_source: MIRROR_SOURCE,
      external_key: 'taylor-handyman',
    });
    expect(matchLead(row(), [claimed]).kind).toBe('external_key');
  });
});

describe('two sheet rows cannot both take the same lead', () => {
  it('leaves both alone and reports them, rather than one overwriting the other', () => {
    const lead = existing({ id: 'contested', email: 'shared@example.com' });
    const result = plan({
      leads: [
        leadRow({ ...MINIMAL, 'Lead ID': 'row-one', Email: 'shared@example.com' }),
        leadRow({
          ...MINIMAL,
          'Lead ID': 'row-two',
          Contact: 'Someone Else',
          Email: 'shared@example.com',
        }),
      ],
      existingLeads: [lead],
    });

    expect(result.leads.every((entry) => entry.action === 'ambiguous')).toBe(true);
    expect(result.ambiguous).toHaveLength(2);
    expect(result.leadsToCreate).toBe(0);
    expect(result.leadsToUpdate).toBe(0);
    expect(result.ambiguous[0].reason).toContain('More than one sheet row');
  });
});

describe('two sheet rows cannot claim the same key', () => {
  it('keeps the first and rejects the second', () => {
    const parsed = parseLeadRows([
      leadRow(MINIMAL),
      leadRow({ ...MINIMAL, Contact: 'A Different Taylor' }),
    ]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].reason).toContain('already used on row');
  });
});

/* ----------------------------------------------------------------- changes --- */

describe('an update fills in and corrects, and never blanks', () => {
  it('reports no change when the database already says the same thing', () => {
    const row = parseLeadRows([leadRow({ ...MINIMAL, Email: 'taylor@example.com' })]).rows[0];
    const current = {
      prospect_name: 'Taylor',
      organization: 'Your Local Handyman',
      stage: 'follow_up',
      email: 'taylor@example.com',
      follow_up_mode: 'auto',
    };
    expect(leadChanges(current, leadFields(row))).toEqual([]);
  });

  it('never proposes writing a null over something that is there', () => {
    const row = parseLeadRows([leadRow(MINIMAL)]).rows[0];
    const current = {
      prospect_name: 'Taylor',
      organization: 'Your Local Handyman',
      stage: 'follow_up',
      follow_up_mode: 'auto',
      // Things the sheet row says nothing about.
      email: 'already@known.com',
      phone: '555-0100',
      notes: 'A note somebody wrote in the Cockpit',
      proposed_value: 900,
    };
    const changes = leadChanges(current, leadFields(row));
    expect(changes.map((c) => c.field)).not.toContain('email');
    expect(changes.map((c) => c.field)).not.toContain('phone');
    expect(changes.map((c) => c.field)).not.toContain('notes');
    expect(changes.map((c) => c.field)).not.toContain('proposed_value');
  });

  it('corrects a field the sheet has a different value for', () => {
    const row = parseLeadRows([leadRow({ ...MINIMAL, Stage: 'Waiting' })]).rows[0];
    const changes = leadChanges({ stage: 'follow_up' }, leadFields(row));
    expect(changes).toContainEqual({ field: 'stage', from: 'follow_up', to: 'waiting' });
  });

  it('does not mistake a numeric string for a different number', () => {
    const row = parseLeadRows([leadRow({ ...MINIMAL, 'Proposed value': '$150' })]).rows[0];
    // Postgres hands numeric columns back as strings through some drivers.
    for (const stored of [150, '150', '150.00']) {
      const changes = leadChanges({ proposed_value: stored }, leadFields(row));
      expect(changes.map((c) => c.field), String(stored)).not.toContain('proposed_value');
    }
  });

  it('does not mistake a Date for a different day', () => {
    // PostgREST returns a date column as "2026-09-19"; a direct Postgres driver
    // returns a Date. Reading either as a change made every run report an update
    // for every lead, forever.
    const row = parseLeadRows([leadRow({ ...MINIMAL, 'First contact': '09/19/26' })]).rows[0];
    const shapes: unknown[] = [
      '2026-09-19',
      '2026-09-19T00:00:00.000Z',
      new Date('2026-09-19T00:00:00.000Z'),
    ];
    for (const stored of shapes) {
      const changes = leadChanges({ first_contact_at: stored }, leadFields(row));
      expect(changes.map((c) => c.field), String(stored)).not.toContain('first_contact_at');
    }
  });

  it('still notices a genuinely different day', () => {
    const row = parseLeadRows([leadRow({ ...MINIMAL, 'First contact': '09/19/26' })]).rows[0];
    const changes = leadChanges(
      { first_contact_at: new Date('2026-09-20T00:00:00.000Z') },
      leadFields(row),
    );
    expect(changes.map((c) => c.field)).toContain('first_contact_at');
  });

  it('treats a field that is simply absent as needing to be filled in', () => {
    const row = parseLeadRows([leadRow({ ...MINIMAL, 'First contact': '09/19/26' })]).rows[0];
    const changes = leadChanges({}, leadFields(row));
    expect(changes.map((c) => c.field)).toContain('first_contact_at');
  });

  it('claims the key even when nothing else changed, so the next run is cheap', () => {
    const result = plan({
      leads: [leadRow(MINIMAL)],
      existingLeads: [existing()],
    });
    expect(result.leads[0].action).toBe('update');
    expect(result.leads[0].changes).toContainEqual({
      field: 'external_key',
      from: null,
      to: 'taylor-handyman',
    });
  });

  it('declares itself nondestructive, and has no delete to be otherwise', () => {
    const result = plan({ leads: [leadRow(MINIMAL)], existingLeads: [existing()] });
    expect(result.nondestructive).toBe(true);
    // Every proposed change is a value the sheet actually had.
    for (const entry of result.leads) {
      for (const change of entry.changes) expect(change.to).not.toBeNull();
    }
  });
});

/* ----------------------------------------------------- keys are not uuids --- */

describe('a readable sheet id never becomes a database id', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('keeps the sheet’s id as an external key and leaves the row id to the database', () => {
    const result = plan({ leads: [leadRow(MINIMAL)] });
    const entry = result.leads[0];

    expect(entry.action).toBe('create');
    expect(entry.row.leadKey).toBe('taylor-handyman');
    expect(UUID.test(entry.row.leadKey)).toBe(false);
    // Nothing in the plan proposes an id: the database generates it.
    expect((entry.fields as unknown as Record<string, unknown>).id).toBeUndefined();
    expect(entry.leadId).toBeNull();
  });

  it('resolves a touch’s readable lead id to the matched lead’s uuid', () => {
    const lead = existing({
      id: '22222222-2222-2222-2222-222222222222',
      external_source: MIRROR_SOURCE,
      external_key: 'taylor-handyman',
    });
    const result = plan({
      leads: [leadRow(MINIMAL)],
      touches: [
        touchRow({
          Date: '09/24/26',
          'Lead ID': 'taylor-handyman',
          Activity: 'Follow-up sent',
          Channel: 'Email',
        }),
      ],
      existingLeads: [lead],
    });

    expect(result.touches[0].action).toBe('create');
    expect(result.touches[0].leadId).toBe(lead.id);
    expect(UUID.test(result.touches[0].leadId as string)).toBe(true);
  });

  it('carries a touch for a lead that does not exist yet, to be linked after it is made', () => {
    const result = plan({
      leads: [leadRow(MINIMAL)],
      touches: [
        touchRow({ Date: '09/24/26', 'Lead ID': 'taylor-handyman', Activity: 'Follow-up sent' }),
      ],
    });
    expect(result.touches[0].action).toBe('create');
    // No id yet, because the lead has not been inserted. Not 'unlinked' either:
    // the lead is in this very plan.
    expect(result.touches[0].leadId).toBeNull();
  });
});

/* ------------------------------------------------------------ touch linking --- */

describe('a touch goes to the right person or nowhere', () => {
  it('refuses a touch whose lead is in neither the sheet nor the database', () => {
    const result = plan({
      leads: [leadRow(MINIMAL)],
      touches: [touchRow({ Date: '09/24/26', 'Lead ID': 'nobody', Activity: 'Follow-up sent' })],
    });
    expect(result.touches[0].action).toBe('unlinked');
    expect(result.touchesToCreate).toBe(0);
    expect(result.rejected.some((r) => r.reason.includes('nobody'))).toBe(true);
  });

  it('refuses a touch belonging to a row the importer left alone', () => {
    // An ambiguous lead row is not applied, so attaching its touches to anything
    // would be attaching them to a guess.
    const result = plan({
      leads: [leadRow({ ...MINIMAL, Email: 'shared@example.com' })],
      touches: [
        touchRow({
          Date: '09/24/26',
          'Lead ID': 'taylor-handyman',
          Activity: 'Follow-up sent',
        }),
      ],
      existingLeads: [
        existing({ id: 'a', email: 'shared@example.com' }),
        existing({ id: 'b', email: 'shared@example.com', prospect_name: 'Other' }),
      ],
    });
    expect(result.leads[0].action).toBe('ambiguous');
    expect(result.touches[0].action).toBe('unlinked');
  });

  it('finds a lead that carries the key but is no longer listed on the lead tab', () => {
    const lead = existing({
      id: '33333333-3333-3333-3333-333333333333',
      external_source: MIRROR_SOURCE,
      external_key: 'retired-lead',
    });
    const result = plan({
      touches: [
        touchRow({ Date: '09/24/26', 'Lead ID': 'retired-lead', Activity: 'Follow-up sent' }),
      ],
      existingLeads: [lead],
    });
    expect(result.touches[0].action).toBe('create');
    expect(result.touches[0].leadId).toBe(lead.id);
  });

  it('rejects a touch with no date, no lead or no activity', () => {
    const parsed = parseTouchRows([
      touchRow({ 'Lead ID': 'x', Activity: 'Follow-up sent' }),
      touchRow({ Date: '09/24/26', Activity: 'Follow-up sent' }),
      touchRow({ Date: '09/24/26', 'Lead ID': 'x' }),
    ]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.rejected).toHaveLength(3);
    expect(parsed.rejected[0].reason).toContain('No Date');
    expect(parsed.rejected[1].reason).toContain('No Lead ID');
    expect(parsed.rejected[2].reason).toContain('No Activity');
  });
});

/* ------------------------------------------------------------- idempotency --- */

describe('the fingerprint is what makes a re-import free', () => {
  it('is built from the source, the lead, the day, the activity and the channel', () => {
    const base = {
      leadKey: 'taylor-handyman',
      occurredOn: '2026-09-24',
      activityLabel: 'Follow-up sent',
      channel: 'Email',
    };
    const key = touchFingerprint(base);

    expect(key).toContain('taylor-handyman');
    expect(key).toContain('2026-09-24');
    // Changing any one part changes the key.
    expect(touchFingerprint({ ...base, leadKey: 'other' })).not.toBe(key);
    expect(touchFingerprint({ ...base, occurredOn: '2026-09-25' })).not.toBe(key);
    expect(touchFingerprint({ ...base, activityLabel: 'Reply received' })).not.toBe(key);
    expect(touchFingerprint({ ...base, channel: 'Phone' })).not.toBe(key);
  });

  it('is stable across case and spacing, which are not a different touch', () => {
    expect(
      touchFingerprint({
        leadKey: 'Taylor-Handyman',
        occurredOn: '2026-09-24',
        activityLabel: 'follow-up  sent',
        channel: ' email ',
      }),
    ).toBe(
      touchFingerprint({
        leadKey: 'taylor-handyman',
        occurredOn: '2026-09-24',
        activityLabel: 'Follow-up sent',
        channel: 'Email',
      }),
    );
  });

  it('cannot be forged by a value containing the separator', () => {
    const a = touchFingerprint({
      leadKey: 'a',
      occurredOn: '2026-09-24',
      activityLabel: 'b',
      channel: 'c',
    });
    const b = touchFingerprint({
      leadKey: 'a',
      occurredOn: '2026-09-24',
      activityLabel: 'b:c',
      channel: null,
    });
    expect(a).not.toBe(b);
  });

  it('collapses two identical rows in the same sheet and says so', () => {
    const same = touchRow({
      Date: '09/24/26',
      'Lead ID': 'taylor-handyman',
      Activity: 'Follow-up sent',
      Channel: 'Email',
    });
    const parsed = parseTouchRows([same, [...same]]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0].reason).toContain('already on row');
  });

  it('keeps two touches on the same day that really are different', () => {
    const parsed = parseTouchRows([
      touchRow({ Date: '09/24/26', 'Lead ID': 'x', Activity: 'Follow-up sent', Channel: 'Email' }),
      touchRow({ Date: '09/24/26', 'Lead ID': 'x', Activity: 'Follow-up sent', Channel: 'Phone' }),
      touchRow({ Date: '09/24/26', 'Lead ID': 'x', Activity: 'Reply received', Channel: 'Email' }),
    ]);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rejected).toEqual([]);
  });
});

describe('running the import three times changes nothing after the first', () => {
  /** The sheet, as a grid, with two relationships and two touches. */
  const LEADS = [
    leadRow({
      'Lead ID': 'taylor-handyman',
      Contact: 'Taylor',
      Organization: 'Your Local Handyman',
      Stage: 'Follow-up',
      Email: 'taylor@example.com',
      'First contact': '09/19/26',
      'Last touch': '09/24/26',
      'Next follow-up': '10/06/26',
      'Follow-up status': 'DUE SOON',
    }),
    leadRow({
      'Lead ID': 'olde-capital',
      Contact: 'Name pending',
      Organization: 'Olde Capital Investments',
      Stage: 'Waiting',
      'Follow-up status': 'NOT SCHEDULED',
    }),
  ];
  const TOUCHES = [
    touchRow({
      Date: '09/24/26',
      'Lead ID': 'taylor-handyman',
      Activity: 'Follow-up sent',
      Channel: 'Email',
      Details: 'Second attempt',
      'Evidence / source': 'Gmail',
    }),
    touchRow({
      Date: '09/19/26',
      'Lead ID': 'taylor-handyman',
      Activity: 'Discovery conversation',
      Channel: 'Phone',
    }),
  ];

  /** The database, as the first import would have left it. */
  function afterFirstImport(): {
    leads: ExistingLead[];
    activities: ExistingActivity[];
  } {
    const first = plan({ leads: LEADS, touches: TOUCHES });

    const leads = first.leads.map((entry, index) => ({
      // The database generated these; the importer never chose them.
      id: `0000000${index}-0000-4000-8000-000000000000`,
      external_source: MIRROR_SOURCE,
      external_key: entry.row.leadKey,
      // The whole row comes back, as the real select returns it. A thinner
      // fixture would hide the phantom-update bug this test exists to catch.
      ...entry.fields,
    }));

    const activities = first.touches
      .filter((touch) => touch.action === 'create')
      .map((touch) => ({
        external_source: MIRROR_SOURCE,
        external_id: touch.row.externalId,
      }));

    return { leads, activities };
  }

  it('creates everything on the first run', () => {
    const first = plan({ leads: LEADS, touches: TOUCHES });
    expect(planCounts(first)).toMatchObject({
      leadRowsRead: 2,
      touchRowsRead: 2,
      leadsToCreate: 2,
      leadsToUpdate: 0,
      leadsUnchanged: 0,
      ambiguousMatches: 0,
      touchesToCreate: 2,
      touchesAlreadyPresent: 0,
      rejectedRows: 0,
    });
  });

  it('creates nothing on the second or the third', () => {
    const state = afterFirstImport();

    for (const attempt of [2, 3]) {
      const again = plan({
        leads: LEADS,
        touches: TOUCHES,
        existingLeads: state.leads,
        existingActivities: state.activities,
      });

      expect(planCounts(again), `run ${attempt}`).toMatchObject({
        leadsToCreate: 0,
        leadsToUpdate: 0,
        leadsUnchanged: 2,
        ambiguousMatches: 0,
        touchesToCreate: 0,
        touchesAlreadyPresent: 2,
        rejectedRows: 0,
      });
      expect(again.leads.every((e) => e.action === 'unchanged'), `run ${attempt}`).toBe(true);
      expect(again.touches.every((t) => t.action === 'present'), `run ${attempt}`).toBe(true);
    }
  });

  it('keeps every activity pointing at the lead it belongs to, run after run', () => {
    const state = afterFirstImport();
    const taylor = state.leads.find((l) => l.external_key === 'taylor-handyman');

    const again = plan({
      leads: LEADS,
      touches: TOUCHES,
      existingLeads: state.leads,
      existingActivities: [],
    });

    // Both touches belong to Taylor, and both resolve to Taylor's generated id.
    expect(again.touches).toHaveLength(2);
    for (const touch of again.touches) {
      expect(touch.leadId).toBe(taylor?.id);
    }
  });

  it('leaves a lead the sheet has never heard of completely alone', () => {
    const untouched = existing({
      id: '99999999-9999-4999-8999-999999999999',
      prospect_name: 'Somebody Added In The Cockpit',
      organization: 'Not In The Sheet',
      email: 'cockpit@example.com',
    });
    const result = plan({
      leads: LEADS,
      touches: TOUCHES,
      existingLeads: [untouched],
    });

    // Two creates, and nothing at all proposed against the existing lead.
    expect(result.leadsToCreate).toBe(2);
    expect(result.leads.some((e) => e.leadId === untouched.id)).toBe(false);
  });
});

/* --------------------------------------------------------------- the gate --- */

describe('the gate stops a live import that does not look like what was reviewed', () => {
  const good = plan({ leads: [leadRow(MINIMAL)] });

  it('passes when the sheet is exactly the size expected and nothing is wrong', () => {
    expect(planIsSafeToApply(good, { leadRows: 1, touchRows: 0 })).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it('refuses on a different number of relationship rows', () => {
    const gate = planIsSafeToApply(good, { leadRows: 21, touchRows: 0 });
    expect(gate.ok).toBe(false);
    expect(gate.reasons[0]).toContain('21');
    expect(gate.reasons[0]).toContain(LEAD_TAB);
  });

  it('refuses on a different number of touch rows', () => {
    const gate = planIsSafeToApply(good, { leadRows: 1, touchRows: 15 });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toContain(TOUCH_TAB);
  });

  it('refuses when anything at all is ambiguous', () => {
    const ambiguous = plan({
      leads: [leadRow({ ...MINIMAL, Email: 'shared@example.com' })],
      existingLeads: [
        existing({ id: 'a', email: 'shared@example.com' }),
        existing({ id: 'b', email: 'shared@example.com', prospect_name: 'Other' }),
      ],
    });
    const gate = planIsSafeToApply(ambiguous, { leadRows: 1, touchRows: 0 });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toContain('more than one existing lead');
  });

  it('refuses when any row could not be read', () => {
    const broken = plan({ leads: [leadRow({ ...MINIMAL, Stage: 'Maybe' })] });
    const gate = planIsSafeToApply(broken, { leadRows: 1, touchRows: 0 });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.join(' ')).toContain('could not be read');
  });

  it('refuses when no expectation was given at all', () => {
    // The function takes -1 when the caller sent nothing, which can never match.
    expect(planIsSafeToApply(good, { leadRows: -1, touchRows: -1 }).ok).toBe(false);
  });
});
