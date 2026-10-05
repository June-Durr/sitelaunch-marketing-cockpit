/**
 * The follow-up rules, which are the thing this sprint has to get right.
 *
 * Everything asserted here is arithmetic on invented dates. No model, no network,
 * no database, and no dependence on what day the test is run, because a test whose
 * answer moves with the calendar is a test that fails on a Tuesday in six months
 * and nobody knows why.
 *
 * supabase/migrations/0007_lead_mirror.sql implements the same derivation in SQL
 * for the Sheet export. src/test/pg/followUp.test.ts runs the two against each
 * other over the same cases.
 */

import { describe, expect, it } from 'vitest';

import {
  DUE_SOON_DAYS, FOLLOW_UP_CADENCE_DAYS, FOLLOW_UP_MODE_LABELS,
  FOLLOW_UP_STATUS_LABELS, FOLLOW_UP_STATUS_ORDER, FOLLOW_UP_STATUS_TONES,
  NEEDS_ACTION_STATUSES, NON_TOUCH_ACTIVITY, daysSinceTouch, deriveLastTouch,
  followUpState, followUpStates, followUpStatus, isTouch, needsActionToday,
  nextFollowUpDate, openFollowUpTask, planNextAction,
} from './followUp';
import { makeActivity, makeLead, makeTask } from '../test/fixtures';
import { ACTIVITY_TYPE_LABELS, STAGE_ORDER, type ActivityType } from '../types/domain';

/** The day every test reads "today" as. Fixed, on purpose. */
const TODAY = '2026-10-05';

/* ------------------------------------------------------------- last touch --- */

describe('the last touch is the newest confirmed activity', () => {
  const lead = makeLead({ id: 'L' });

  it('takes the newest of several, not the first or the last in the list', () => {
    const events = [
      makeActivity({ id: 'a', lead_id: 'L', activity_type: 'follow_up_sent', occurred_at: '2026-09-19T12:00:00.000Z' }),
      makeActivity({ id: 'b', lead_id: 'L', activity_type: 'follow_up_sent', occurred_at: '2026-09-30T12:00:00.000Z' }),
      makeActivity({ id: 'c', lead_id: 'L', activity_type: 'conversation', occurred_at: '2026-09-24T12:00:00.000Z' }),
    ];

    const touch = deriveLastTouch(lead, events);
    expect(touch.on).toBe('2026-09-30');
    expect(touch.basis).toBe('activity');
    expect(touch.count).toBe(3);
  });

  it('gives the same answer whatever order the activities arrive in', () => {
    const events = [
      makeActivity({ id: 'a', lead_id: 'L', activity_type: 'follow_up_sent', occurred_at: '2026-09-19T12:00:00.000Z' }),
      makeActivity({ id: 'b', lead_id: 'L', activity_type: 'follow_up_sent', occurred_at: '2026-09-30T12:00:00.000Z' }),
    ];
    expect(deriveLastTouch(lead, events).on).toBe(
      deriveLastTouch(lead, [...events].reverse()).on,
    );
  });

  it('ignores activities belonging to somebody else', () => {
    const events = [
      makeActivity({ id: 'a', lead_id: 'L', activity_type: 'follow_up_sent', occurred_at: '2026-09-19T12:00:00.000Z' }),
      makeActivity({ id: 'b', lead_id: 'OTHER', activity_type: 'follow_up_sent', occurred_at: '2026-10-04T12:00:00.000Z' }),
    ];
    expect(deriveLastTouch(lead, events).on).toBe('2026-09-19');
    expect(deriveLastTouch(lead, events).count).toBe(1);
  });

  it('ignores an activity attached to nobody', () => {
    const events = [makeActivity({ id: 'a', lead_id: null, activity_type: 'follow_up_sent' })];
    expect(deriveLastTouch(lead, events).basis).toBe('none');
  });

  it('prefers a confirmed activity over a date the mirror merely reported', () => {
    const claimed = makeLead({ id: 'L', reported_last_touch_at: '2026-09-13' });
    const events = [
      makeActivity({ id: 'a', lead_id: 'L', activity_type: 'conversation', occurred_at: '2026-09-24T12:00:00.000Z' }),
    ];

    const touch = deriveLastTouch(claimed, events);
    expect(touch.effectiveOn).toBe('2026-09-24');
    expect(touch.basis).toBe('activity');
  });

  it('prefers the confirmed activity even when the reported date is newer', () => {
    // A spreadsheet claim is not evidence of an event, so a logged record wins
    // whichever way the dates fall, and the basis says which was used.
    const claimed = makeLead({ id: 'L', reported_last_touch_at: '2026-10-01' });
    const events = [
      makeActivity({ id: 'a', lead_id: 'L', activity_type: 'conversation', occurred_at: '2026-09-24T12:00:00.000Z' }),
    ];
    expect(deriveLastTouch(claimed, events).effectiveOn).toBe('2026-09-24');
    expect(deriveLastTouch(claimed, events).basis).toBe('activity');
  });

  it('uses the reported date only when there is no activity at all, and says so', () => {
    const claimed = makeLead({ id: 'L', reported_last_touch_at: '2026-09-13' });
    const touch = deriveLastTouch(claimed, []);

    expect(touch.at).toBeNull();
    expect(touch.on).toBeNull();
    expect(touch.effectiveOn).toBe('2026-09-13');
    expect(touch.basis).toBe('reported');
  });

  it('says nothing is known rather than inventing a date', () => {
    const touch = deriveLastTouch(lead, []);
    expect(touch.effectiveOn).toBeNull();
    expect(touch.basis).toBe('none');
    expect(touch.count).toBe(0);
  });

  it('does not count publishing, measuring or getting paid as being in touch', () => {
    for (const type of NON_TOUCH_ACTIVITY) {
      const event = makeActivity({ lead_id: 'L', activity_type: type });
      expect(isTouch(event), type).toBe(false);
      expect(deriveLastTouch(lead, [event]).basis, type).toBe('none');
    }
  });

  it('counts an activity type it has never seen, because a missed touch is the worse error', () => {
    // 'other' is where an unrecognised imported label lands. Treating it as no
    // touch would overstate how long somebody has been left waiting.
    const event = makeActivity({ lead_id: 'L', activity_type: 'other' });
    expect(isTouch(event)).toBe(true);
  });

  it('agrees with ActivityType about which types exist', () => {
    const known = Object.keys(ACTIVITY_TYPE_LABELS) as ActivityType[];
    for (const type of NON_TOUCH_ACTIVITY) expect(known, type).toContain(type);
  });
});

describe('days since touch', () => {
  it('counts whole days up to today', () => {
    expect(daysSinceTouch('2026-09-27', TODAY)).toBe(8);
    expect(daysSinceTouch('2026-09-12', TODAY)).toBe(23);
    expect(daysSinceTouch(TODAY, TODAY)).toBe(0);
  });

  it('says nothing rather than zero when there has never been a touch', () => {
    expect(daysSinceTouch(null, TODAY)).toBeNull();
    expect(daysSinceTouch(null, TODAY)).not.toBe(0);
  });
});

/* ----------------------------------------------------------------- status --- */

describe('the follow-up status', () => {
  const at = (over: Parameters<typeof makeLead>[0]) => followUpStatus(makeLead(over), TODAY);

  it('is overdue when the date has gone by', () => {
    expect(at({ stage: 'follow_up', next_action_date: '2026-10-04' })).toBe('overdue');
    expect(at({ stage: 'follow_up', next_action_date: '2026-03-07' })).toBe('overdue');
  });

  it('is due today on the day itself', () => {
    expect(at({ stage: 'follow_up', next_action_date: TODAY })).toBe('due_today');
  });

  it(`is due soon within ${DUE_SOON_DAYS} days`, () => {
    expect(at({ stage: 'follow_up', next_action_date: '2026-10-06' })).toBe('due_soon');
    expect(at({ stage: 'follow_up', next_action_date: '2026-10-08' })).toBe('due_soon');
  });

  it('is merely scheduled beyond that', () => {
    expect(at({ stage: 'follow_up', next_action_date: '2026-10-09' })).toBe('scheduled');
    expect(at({ stage: 'waiting', next_action_date: '2026-11-09' })).toBe('scheduled');
  });

  it('is not scheduled when no date is set', () => {
    expect(at({ stage: 'follow_up', next_action_date: null })).toBe('not_scheduled');
  });

  it('reads the first mirror exactly as the spreadsheet did', () => {
    // The sheet was written on this day, so these are the words it showed.
    const cases: [string, string][] = [
      ['2026-10-06', 'DUE SOON'],
      ['2026-10-07', 'DUE SOON'],
      ['2026-10-12', 'SCHEDULED'],
      ['2026-10-15', 'SCHEDULED'],
      ['2026-10-17', 'SCHEDULED'],
      ['2026-11-09', 'SCHEDULED'],
    ];
    for (const [date, expected] of cases) {
      const status = at({ stage: 'waiting', next_action_date: date });
      expect(FOLLOW_UP_STATUS_LABELS[status].toUpperCase(), date).toBe(expected);
    }
  });

  it('respects a deliberate decision over any arithmetic', () => {
    // Each of these has a date that would otherwise read as due today.
    expect(at({ follow_up_mode: 'none', next_action_date: TODAY })).toBe('not_scheduled');
    expect(at({ follow_up_mode: 'hold', next_action_date: TODAY })).toBe('on_hold');
    expect(at({ follow_up_mode: 'archived', next_action_date: TODAY })).toBe('archived');
  });

  it('puts archived above even a closed stage, because it is the stronger statement', () => {
    expect(at({ follow_up_mode: 'archived', stage: 'won', next_action_date: TODAY }))
      .toBe('archived');
  });

  it('calls a won or lost lead closed, whatever date is left on it', () => {
    expect(at({ stage: 'won', next_action_date: '2026-03-01' })).toBe('closed');
    expect(at({ stage: 'lost', next_action_date: TODAY })).toBe('closed');
  });

  it('has a label, a tone and an explanation for every status it can return', () => {
    for (const status of FOLLOW_UP_STATUS_ORDER) {
      expect(FOLLOW_UP_STATUS_LABELS[status], status).toBeTruthy();
      expect(FOLLOW_UP_STATUS_TONES[status], status).toBeTruthy();
    }
  });

  it('has a label for every follow-up mode', () => {
    for (const mode of ['auto', 'none', 'hold', 'archived'] as const) {
      expect(FOLLOW_UP_MODE_LABELS[mode], mode).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------- the ordering --- */

describe('leads come back in the order they should be worked', () => {
  const leads = [
    makeLead({ id: 'scheduled', stage: 'waiting', next_action_date: '2026-11-09' }),
    makeLead({ id: 'overdue', stage: 'follow_up', next_action_date: '2026-09-01' }),
    makeLead({ id: 'held', follow_up_mode: 'hold' }),
    makeLead({ id: 'today', stage: 'follow_up', next_action_date: TODAY }),
    makeLead({ id: 'soon', stage: 'follow_up', next_action_date: '2026-10-06' }),
  ];

  it('is worst first', () => {
    const order = followUpStates(leads, [], TODAY).map((s) => s.lead.id);
    expect(order).toEqual(['overdue', 'today', 'soon', 'scheduled', 'held']);
  });

  it('puts whoever has waited longest first within a status', () => {
    const waiting = [
      makeLead({ id: 'recent', stage: 'follow_up', next_action_date: '2026-09-01', reported_last_touch_at: '2026-10-01' }),
      makeLead({ id: 'ancient', stage: 'follow_up', next_action_date: '2026-09-01', reported_last_touch_at: '2026-03-07' }),
    ];
    expect(followUpStates(waiting, [], TODAY).map((s) => s.lead.id))
      .toEqual(['ancient', 'recent']);
  });

  it('does not depend on the order the leads arrived in', () => {
    const forwards = followUpStates(leads, [], TODAY).map((s) => s.lead.id);
    const backwards = followUpStates([...leads].reverse(), [], TODAY).map((s) => s.lead.id);
    expect(forwards).toEqual(backwards);
  });
});

describe('the Today screen gets the people who are actually waiting', () => {
  it('takes overdue and due today, and nothing further out', () => {
    expect(NEEDS_ACTION_STATUSES).toEqual(['overdue', 'due_today']);

    const leads = [
      makeLead({ id: 'overdue', stage: 'follow_up', next_action_date: '2026-09-01' }),
      makeLead({ id: 'today', stage: 'follow_up', next_action_date: TODAY }),
      makeLead({ id: 'soon', stage: 'follow_up', next_action_date: '2026-10-06' }),
    ];
    expect(needsActionToday(leads, [], TODAY).map((s) => s.lead.id))
      .toEqual(['overdue', 'today']);
  });

  it('leaves out anybody deliberately on hold, archived or set to no follow-up', () => {
    const leads = [
      makeLead({ id: 'none', follow_up_mode: 'none', next_action_date: '2026-09-01' }),
      makeLead({ id: 'hold', follow_up_mode: 'hold', next_action_date: '2026-09-01' }),
      makeLead({ id: 'archived', follow_up_mode: 'archived', next_action_date: '2026-09-01' }),
    ];
    expect(needsActionToday(leads, [], TODAY)).toEqual([]);
  });

  it('leaves out a won or lost lead with a date left behind on it', () => {
    const leads = [
      makeLead({ id: 'won', stage: 'won', next_action_date: '2026-09-01' }),
      makeLead({ id: 'lost', stage: 'lost', next_action_date: '2026-09-01' }),
    ];
    expect(needsActionToday(leads, [], TODAY)).toEqual([]);
  });

  it('carries the days-since number, which is the reason it is on the list', () => {
    const lead = makeLead({ id: 'L', stage: 'follow_up', next_action_date: '2026-09-01' });
    const events = [
      makeActivity({ lead_id: 'L', activity_type: 'follow_up_sent', occurred_at: '2026-09-27T12:00:00.000Z' }),
    ];
    const [state] = needsActionToday([lead], events, TODAY);
    expect(state.daysSince).toBe(8);
    expect(state.lastTouch.basis).toBe('activity');
  });
});

/* --------------------------------------------------------------- the cadence --- */

describe('the next follow-up date', () => {
  it('has a cadence for every open stage and none for the closed ones', () => {
    for (const stage of STAGE_ORDER) {
      const cadence = FOLLOW_UP_CADENCE_DAYS[stage];
      if (stage === 'won' || stage === 'lost') {
        expect(cadence, stage).toBeNull();
      } else {
        expect(cadence, stage).toBeGreaterThan(0);
      }
    }
  });

  it('counts forward from the day of the contact', () => {
    expect(nextFollowUpDate('follow_up', '2026-10-05')).toBe('2026-10-12');
    expect(nextFollowUpDate('new_contact', '2026-09-17')).toBe('2026-10-17');
    expect(nextFollowUpDate('call_scheduled', '2026-10-05')).toBe('2026-10-08');
  });

  it('declines rather than scheduling today, which is not the same thing', () => {
    expect(nextFollowUpDate('won', '2026-10-05')).toBeNull();
    expect(nextFollowUpDate('lost', '2026-10-05')).toBeNull();
  });
});

/* ------------------------------------------------- one task, never a second --- */

describe('logging a contact never leaves two follow-up tasks', () => {
  const lead = makeLead({ id: 'L', stage: 'follow_up', prospect_name: 'Taylor' });

  it('creates one when there is none open', () => {
    const plan = planNextAction(lead, [], '2026-10-05');
    expect(plan.kind).toBe('create');
    expect(plan.dueDate).toBe('2026-10-12');
    expect(plan.taskId).toBeNull();
    expect(plan.title).toBe('Follow up with Taylor');
    expect(plan.reason).toContain('7 days');
  });

  it('moves the one that is already open rather than adding another', () => {
    const open = makeTask({ id: 'T1', lead_id: 'L', task_type: 'follow_up', status: 'open' });
    const plan = planNextAction(lead, [open], '2026-10-05');

    expect(plan.kind).toBe('reschedule');
    expect(plan.taskId).toBe('T1');
    expect(plan.dueDate).toBe('2026-10-12');
    expect(plan.reason).toContain('rather than adding a second');
  });

  it('is still a reschedule the second and third time contact is logged', () => {
    const open = makeTask({ id: 'T1', lead_id: 'L', task_type: 'follow_up', status: 'open' });
    for (const day of ['2026-10-05', '2026-10-06', '2026-10-07']) {
      const plan = planNextAction(lead, [open], day);
      expect(plan.kind, day).toBe('reschedule');
      expect(plan.taskId, day).toBe('T1');
    }
  });

  it('does not count a finished or skipped follow-up as the open one', () => {
    const done = makeTask({ id: 'T1', lead_id: 'L', task_type: 'follow_up', status: 'done' });
    const skipped = makeTask({ id: 'T2', lead_id: 'L', task_type: 'follow_up', status: 'skipped' });
    expect(planNextAction(lead, [done, skipped], '2026-10-05').kind).toBe('create');
  });

  it('does not count somebody else’s open follow-up', () => {
    const theirs = makeTask({ id: 'T1', lead_id: 'OTHER', task_type: 'follow_up', status: 'open' });
    expect(planNextAction(lead, [theirs], '2026-10-05').kind).toBe('create');
  });

  it('does not count a task of a different kind against this lead', () => {
    const other = makeTask({ id: 'T1', lead_id: 'L', task_type: 'admin', status: 'open' });
    expect(planNextAction(lead, [other], '2026-10-05').kind).toBe('create');
    expect(openFollowUpTask([other], 'L')).toBeNull();
  });

  it('finds exactly the open follow-up and nothing else', () => {
    const tasks = [
      makeTask({ id: 'done', lead_id: 'L', task_type: 'follow_up', status: 'done' }),
      makeTask({ id: 'open', lead_id: 'L', task_type: 'follow_up', status: 'open' }),
      makeTask({ id: 'admin', lead_id: 'L', task_type: 'admin', status: 'open' }),
    ];
    expect(openFollowUpTask(tasks, 'L')?.id).toBe('open');
  });
});

describe('a deliberate decision is never overridden by logging a note', () => {
  const cases: [string, Parameters<typeof makeLead>[0], string][] = [
    ['archived', { follow_up_mode: 'archived' }, 'archived'],
    ['on hold', { follow_up_mode: 'hold' }, 'on hold'],
    ['no follow-up', { follow_up_mode: 'none' }, 'no follow-up on purpose'],
    ['won', { stage: 'won' }, 'won'],
    ['lost', { stage: 'lost' }, 'lost'],
  ];

  for (const [name, over, expected] of cases) {
    it(`schedules nothing for a ${name} lead, and says why`, () => {
      const plan = planNextAction(makeLead({ id: 'L', ...over }), [], '2026-10-05');
      expect(plan.kind).toBe('none');
      expect(plan.dueDate).toBeNull();
      expect(plan.taskId).toBeNull();
      expect(plan.reason.toLowerCase()).toContain(expected);
    });
  }

  it('leaves an already open task alone rather than moving it', () => {
    const open = makeTask({ id: 'T1', lead_id: 'L', task_type: 'follow_up', status: 'open' });
    const plan = planNextAction(makeLead({ id: 'L', follow_up_mode: 'hold' }), [open], '2026-10-05');
    expect(plan.kind).toBe('none');
    expect(plan.taskId).toBeNull();
  });

  it('always gives a reason, whatever it decides', () => {
    for (const stage of STAGE_ORDER) {
      const plan = planNextAction(makeLead({ id: 'L', stage }), [], '2026-10-05');
      expect(plan.reason, stage).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------- end to end --- */

describe('the whole state of one lead', () => {
  it('reads the imported mirror row the way the spreadsheet did', () => {
    // taylor-handyman as the first mirror recorded it, with the touch history
    // that came with it.
    const lead = makeLead({
      id: 'L',
      prospect_name: 'Taylor',
      stage: 'follow_up',
      first_contact_at: '2026-09-19',
      reported_last_touch_at: '2026-09-24',
      next_action_date: '2026-10-06',
    });
    const events = [
      makeActivity({ id: 'a', lead_id: 'L', activity_type: 'conversation', occurred_at: '2026-09-19T12:00:00.000Z', title: 'Discovery conversation' }),
      makeActivity({ id: 'b', lead_id: 'L', activity_type: 'follow_up_sent', occurred_at: '2026-09-24T12:00:00.000Z', title: 'Follow-up sent' }),
    ];

    const state = followUpState(lead, events, TODAY);
    expect(state.lastTouch.on).toBe('2026-09-24');
    expect(state.lastTouch.basis).toBe('activity');
    expect(state.daysSince).toBe(11);
    expect(state.nextFollowUp).toBe('2026-10-06');
    expect(state.status).toBe('due_soon');
  });

  it('reads a row that had a date but no touch history as reported', () => {
    // moth-to-flame: a last-touch date with nothing in the touch tab behind it.
    const lead = makeLead({
      id: 'L',
      stage: 'waiting',
      reported_last_touch_at: '2026-09-13',
      next_action_date: '2026-11-09',
    });
    const state = followUpState(lead, [], TODAY);

    expect(state.lastTouch.basis).toBe('reported');
    expect(state.daysSince).toBe(22);
    expect(state.status).toBe('scheduled');
  });

  it('reads a row with nothing at all as nothing at all', () => {
    // olde-capital: no dates, and NOT SCHEDULED on purpose.
    const lead = makeLead({ id: 'L', stage: 'waiting', follow_up_mode: 'none' });
    const state = followUpState(lead, [], TODAY);

    expect(state.lastTouch.basis).toBe('none');
    expect(state.daysSince).toBeNull();
    expect(state.nextFollowUp).toBeNull();
    expect(state.status).toBe('not_scheduled');
  });
});
