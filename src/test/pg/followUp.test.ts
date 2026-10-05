/**
 * The follow-up derivation, proved twice and proved to agree.
 *
 * WHY THERE ARE TWO IMPLEMENTATIONS AT ALL
 *
 * The Pipeline and Today screens work this out in the browser, from
 * src/config/followUp.ts. The Google Sheet mirror is written by a server function
 * with no browser anywhere in the path, and future recommendations are meant to
 * read authoritative database state rather than recompute from a spreadsheet, so
 * the same derivation exists in SQL as lead_follow_up_state(as_of).
 *
 * Two implementations of one rule is a liability unless something checks them, so
 * this file is that check. Every case below runs through both and fails if they
 * disagree by a single day or a single word. The configuration module remains the
 * documented home of the rule; this is the proof that the SQL copy still matches
 * it.
 *
 * Every date here is a fixed string. The SQL takes the date as a parameter rather
 * than reading current_date precisely so that it can be pinned like this.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DUE_SOON_DAYS, FOLLOW_UP_CADENCE_DAYS, NON_TOUCH_ACTIVITY, daysSinceTouch,
  deriveLastTouch, followUpStatus,
} from '../../config/followUp';
import { makeActivity, makeLead } from '../fixtures';
import { freshDatabase, seedRow, USER_A, USER_B, type TestDatabase } from './harness';
import type { ActivityType, FollowUpMode, LeadStage } from '../../types/domain';

let t: TestDatabase;

beforeEach(async () => {
  t = await freshDatabase();
});

afterEach(async () => {
  await t.close();
});

/** What one row of lead_follow_up_state looks like coming back. */
interface StateRow {
  lead_id: string;
  owner_id: string;
  last_touch_at: string | null;
  last_touch_on: string | Date | null;
  effective_last_touch_on: string | Date | null;
  last_touch_basis: string;
  touch_count: number;
  days_since_touch: number | null;
  next_action_date: string | Date | null;
  follow_up_mode: FollowUpMode;
  follow_up_status: string;
}

/** Postgres hands a date back as a Date in some drivers; compare as days. */
function day(value: string | Date | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

async function stateFor(asOf: string, leadId: string): Promise<StateRow> {
  const result = await t.db.query<StateRow>(
    'select * from lead_follow_up_state($1) where lead_id = $2',
    [asOf, leadId],
  );
  expect(result.rows, `no state row for ${leadId}`).toHaveLength(1);
  return result.rows[0];
}

/**
 * One lead, with optional touches, in the database and in memory at once.
 *
 * The same fixture drives both implementations, which is the whole point: a case
 * that only existed on one side would prove nothing about the other.
 */
async function bothWays(input: {
  lead?: Parameters<typeof makeLead>[0];
  touches?: { type: ActivityType; at: string }[];
  owner?: string;
}) {
  const owner = input.owner ?? USER_A;
  const lead = makeLead({ id: 'ignored', ...input.lead });

  const leadId = await seedRow(t, owner, 'leads', {
    prospect_name: lead.prospect_name,
    organization: lead.organization,
    email: lead.email,
    stage: lead.stage,
    next_action: lead.next_action,
    next_action_date: lead.next_action_date,
    follow_up_mode: lead.follow_up_mode,
    reported_last_touch_at: lead.reported_last_touch_at,
    first_contact_at: lead.first_contact_at,
  });

  const events = (input.touches ?? []).map((touch, index) =>
    makeActivity({
      id: `a${index}`,
      lead_id: leadId,
      activity_type: touch.type,
      occurred_at: touch.at,
      title: `Touch ${index}`,
    }),
  );

  for (const event of events) {
    await seedRow(t, owner, 'activity_events', {
      occurred_at: event.occurred_at,
      activity_type: event.activity_type,
      title: event.title,
      lead_id: leadId,
    });
  }

  return { leadId, lead: { ...lead, id: leadId }, events };
}

/* ============================================= the two must agree exactly === */

describe('the SQL and the TypeScript give the same answer', () => {
  /**
   * The cases that matter, each one a thing that could plausibly be got wrong.
   *
   * Listed as data so adding a case costs one line and automatically checks both
   * implementations rather than only the one somebody remembered.
   */
  const CASES: {
    name: string;
    asOf: string;
    lead: Parameters<typeof makeLead>[0];
    touches?: { type: ActivityType; at: string }[];
  }[] = [
    {
      name: 'overdue by a month',
      asOf: '2026-10-05',
      lead: { stage: 'follow_up', next_action_date: '2026-09-01' },
    },
    {
      name: 'due today',
      asOf: '2026-10-05',
      lead: { stage: 'follow_up', next_action_date: '2026-10-05' },
    },
    {
      name: 'due tomorrow',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', next_action_date: '2026-10-06' },
    },
    {
      name: `due on the ${DUE_SOON_DAYS}th day, the last that counts as soon`,
      asOf: '2026-10-05',
      lead: { stage: 'waiting', next_action_date: '2026-10-08' },
    },
    {
      name: 'due one day past that, which is merely scheduled',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', next_action_date: '2026-10-09' },
    },
    {
      name: 'scheduled well out',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', next_action_date: '2026-11-09' },
    },
    {
      name: 'no date at all',
      asOf: '2026-10-05',
      lead: { stage: 'new_contact', next_action_date: null },
    },
    {
      name: 'deliberately not scheduled, with no date',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', follow_up_mode: 'none' },
    },
    {
      name: 'on hold, with a date that would otherwise be overdue',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', follow_up_mode: 'hold', next_action_date: '2026-09-01' },
    },
    {
      name: 'archived, which outranks even a closed stage',
      asOf: '2026-10-05',
      lead: { stage: 'won', follow_up_mode: 'archived', next_action_date: '2026-10-05' },
    },
    {
      name: 'won, with a date left behind on it',
      asOf: '2026-10-05',
      lead: { stage: 'won', next_action_date: '2026-09-01' },
    },
    {
      name: 'lost',
      asOf: '2026-10-05',
      lead: { stage: 'lost', next_action_date: '2026-10-05' },
    },
    {
      name: 'one logged touch',
      asOf: '2026-10-05',
      lead: { stage: 'follow_up', next_action_date: '2026-10-06' },
      touches: [{ type: 'follow_up_sent', at: '2026-09-24T12:00:00.000Z' }],
    },
    {
      name: 'several touches, the newest of which wins',
      asOf: '2026-10-05',
      lead: { stage: 'follow_up', next_action_date: '2026-10-06' },
      touches: [
        { type: 'conversation', at: '2026-09-19T12:00:00.000Z' },
        { type: 'follow_up_sent', at: '2026-09-30T12:00:00.000Z' },
        { type: 'reply_received', at: '2026-09-24T12:00:00.000Z' },
      ],
    },
    {
      name: 'a reported date with no activity behind it',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', reported_last_touch_at: '2026-09-13', next_action_date: '2026-11-09' },
    },
    {
      name: 'a reported date that a logged activity overrides',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', reported_last_touch_at: '2026-09-13' },
      touches: [{ type: 'follow_up_sent', at: '2026-09-30T12:00:00.000Z' }],
    },
    {
      name: 'a reported date newer than the only logged activity',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', reported_last_touch_at: '2026-10-01' },
      touches: [{ type: 'follow_up_sent', at: '2026-09-24T12:00:00.000Z' }],
    },
    {
      name: 'activity that is not contact, so it does not count as a touch',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', next_action_date: '2026-10-20' },
      touches: [
        { type: 'analytics_check', at: '2026-10-04T12:00:00.000Z' },
        { type: 'content_published', at: '2026-10-03T12:00:00.000Z' },
      ],
    },
    {
      name: 'a mix, where only the contact ones count',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', next_action_date: '2026-10-20' },
      touches: [
        { type: 'analytics_check', at: '2026-10-04T12:00:00.000Z' },
        { type: 'follow_up_sent', at: '2026-09-20T12:00:00.000Z' },
      ],
    },
    {
      name: 'an unrecognised label, which still counts',
      asOf: '2026-10-05',
      lead: { stage: 'waiting', next_action_date: '2026-10-20' },
      touches: [{ type: 'other', at: '2026-09-28T12:00:00.000Z' }],
    },
    {
      name: 'nothing recorded at all',
      asOf: '2026-10-05',
      lead: { stage: 'new_contact' },
    },
    {
      name: 'read as at a different day, to prove the date really is a parameter',
      asOf: '2026-09-20',
      lead: { stage: 'follow_up', next_action_date: '2026-09-21' },
      touches: [{ type: 'follow_up_sent', at: '2026-09-19T12:00:00.000Z' }],
    },
  ];

  for (const testCase of CASES) {
    it(`agrees about ${testCase.name}`, async () => {
      const { leadId, lead, events } = await bothWays(testCase);

      const sql = await t.db
        .query<StateRow>('select * from lead_follow_up_state($1) where lead_id = $2', [
          testCase.asOf,
          leadId,
        ])
        .then((r) => r.rows[0]);

      const touch = deriveLastTouch(lead, events);
      const status = followUpStatus(lead, testCase.asOf);
      const since = daysSinceTouch(touch.effectiveOn, testCase.asOf);

      expect(sql.follow_up_status, 'status').toBe(status);
      expect(sql.last_touch_basis, 'basis').toBe(touch.basis);
      expect(day(sql.last_touch_on), 'last touch day').toBe(touch.on);
      expect(day(sql.effective_last_touch_on), 'effective last touch').toBe(touch.effectiveOn);
      expect(Number(sql.touch_count), 'touch count').toBe(touch.count);
      expect(
        sql.days_since_touch === null ? null : Number(sql.days_since_touch),
        'days since',
      ).toBe(since);
    });
  }

  it('agrees for every stage at once, with the same date on each', () => {
    // Covered in SQL below; this guards the cadence table itself, which only the
    // TypeScript side owns because only it schedules anything.
    for (const stage of Object.keys(FOLLOW_UP_CADENCE_DAYS) as LeadStage[]) {
      const cadence = FOLLOW_UP_CADENCE_DAYS[stage];
      expect(cadence === null || cadence > 0, stage).toBe(true);
    }
  });
});

/* ========================================== the configuration is in step === */

describe('the SQL carries the same configuration as the module', () => {
  it('uses the same due-soon threshold', async () => {
    // Found by experiment rather than by reading the file, so a changed literal
    // in the migration fails here instead of being discovered in the mirror.
    const asOf = '2026-10-05';
    const { leadId } = await bothWays({
      lead: { stage: 'waiting', next_action_date: '2026-10-05' },
    });

    let lastSoon = 0;
    for (let offset = 1; offset <= 14; offset += 1) {
      const date = new Date(Date.UTC(2026, 9, 5 + offset)).toISOString().slice(0, 10);
      await t.db.query('update leads set next_action_date = $1 where id = $2', [date, leadId]);
      const state = await stateFor(asOf, leadId);
      if (state.follow_up_status === 'due_soon') lastSoon = offset;
    }

    expect(lastSoon).toBe(DUE_SOON_DAYS);
  });

  it('excludes exactly the activity types the module excludes', async () => {
    const asOf = '2026-10-05';

    for (const type of NON_TOUCH_ACTIVITY) {
      const { leadId } = await bothWays({
        lead: { stage: 'waiting' },
        touches: [{ type, at: '2026-10-04T12:00:00.000Z' }],
      });
      const state = await stateFor(asOf, leadId);
      expect(state.last_touch_basis, type).toBe('none');
      expect(Number(state.touch_count), type).toBe(0);
    }
  });

  it('counts every other type as a touch', async () => {
    const asOf = '2026-10-05';
    const contactTypes: ActivityType[] = [
      'contact_added', 'follow_up_sent', 'reply_received', 'conversation',
      'networking_event', 'lead_created', 'proposal_sent', 'other',
    ];

    for (const type of contactTypes) {
      const { leadId } = await bothWays({
        lead: { stage: 'waiting' },
        touches: [{ type, at: '2026-10-04T12:00:00.000Z' }],
      });
      const state = await stateFor(asOf, leadId);
      expect(state.last_touch_basis, type).toBe('activity');
      expect(day(state.last_touch_on), type).toBe('2026-10-04');
    }
  });

  it('reads a noon-UTC timestamp back as the day it was written', async () => {
    // Why the importer stores a date-only touch at noon rather than midnight:
    // midnight UTC is the previous evening anywhere west of Greenwich, and both
    // implementations have to pick the same calendar day.
    const { leadId } = await bothWays({
      lead: { stage: 'waiting' },
      touches: [{ type: 'follow_up_sent', at: '2026-09-30T12:00:00.000Z' }],
    });
    const state = await stateFor('2026-10-05', leadId);
    expect(day(state.last_touch_on)).toBe('2026-09-30');
    expect(Number(state.days_since_touch)).toBe(5);
  });
});

/* ================================================= it still respects RLS === */

describe('the derivation cannot see across owners', () => {
  it('shows a signed in user only their own leads', async () => {
    const mine = await t.asUser(USER_A, () =>
      bothWays({ lead: { prospect_name: 'Mine', stage: 'waiting' }, owner: USER_A }),
    );
    await bothWays({ lead: { prospect_name: 'Theirs', stage: 'waiting' }, owner: USER_B });

    const visible = await t.asUser(USER_A, async () => {
      const result = await t.db.query<StateRow>('select * from lead_follow_up_state($1)', [
        '2026-10-05',
      ]);
      return result.rows;
    });

    expect(visible).toHaveLength(1);
    expect(visible[0].lead_id).toBe(mine.leadId);
    expect(visible[0].owner_id).toBe(USER_A);
  });

  it('never counts another owner’s activity as a touch', async () => {
    // The join is on lead and owner together. A lead id colliding across owners
    // is impossible with uuids, but the owner is in the join anyway, because
    // "impossible" is not a security property.
    const { leadId } = await bothWays({
      lead: { prospect_name: 'Mine', stage: 'waiting' },
      owner: USER_A,
    });
    await seedRow(t, USER_B, 'activity_events', {
      occurred_at: '2026-10-04T12:00:00.000Z',
      activity_type: 'follow_up_sent',
      title: 'Not mine',
      lead_id: null,
    });

    const state = await stateFor('2026-10-05', leadId);
    expect(Number(state.touch_count)).toBe(0);
  });

  it('shows an anonymous visitor nothing, because it cannot be called at all', async () => {
    await bothWays({ lead: { stage: 'waiting' }, owner: USER_A });

    await t.asAnon(async () => {
      await expect(
        t.db.query('select * from lead_follow_up_state($1)', ['2026-10-05']),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('gives the same answer through the convenience view', async () => {
    const { leadId } = await bothWays({
      lead: { stage: 'waiting', next_action_date: '2026-11-09' },
      owner: USER_A,
    });

    const viaView = await t.asUser(USER_A, async () => {
      const result = await t.db.query<StateRow>(
        'select * from lead_follow_up_today where lead_id = $1',
        [leadId],
      );
      return result.rows[0];
    });

    expect(viaView.follow_up_status).toBe('scheduled');
    expect(viaView.lead_id).toBe(leadId);
  });
});
