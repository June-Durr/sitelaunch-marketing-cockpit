/**
 * Turning follow-up dates into tasks, and never into two tasks.
 *
 * Pure planning, so every case here is a list of leads and a list of tasks going
 * in and a list of decisions coming out. No clock, no database, no network, and
 * nobody real: the 21-lead fixture has the same shape as the imported pipeline
 * and none of its contents.
 *
 * The SQL twin of this planner is checked against it in
 * src/test/pg/followUpTasks.test.ts, against a real Postgres.
 */

import { describe, expect, it } from 'vitest';

import {
  adoptableFollowUpTask, desiredFollowUpTask, followUpTaskChanges,
  followUpTaskCounts, managedFollowUpTask, NO_NEXT_ACTION_NOTE, planFollowUpTasks,
} from './followUpTasks';
import { makeLead, makeTask, twentyOneLeads } from '../test/fixtures';
import type { Lead, Task } from '../types/domain';

/** A lead the rule will follow up, varied one field at a time. */
const eligible = (over: Partial<Lead> = {}) =>
  makeLead({
    id: 'L',
    prospect_name: 'Taylor',
    stage: 'follow_up',
    follow_up_mode: 'auto',
    next_action_date: '2026-10-12',
    ...over,
  });

/** The rule's own task for that lead. */
const managed = (over: Partial<Task> = {}) =>
  makeTask({
    id: 'T',
    lead_id: 'L',
    task_type: 'follow_up',
    status: 'open',
    due_date: '2026-10-12',
    title: 'Follow up with Taylor',
    notes: NO_NEXT_ACTION_NOTE,
    follow_up_rule_managed: true,
    ...over,
  });

/* =============================================== the 21 lead pipeline === */

describe('the imported pipeline becomes nineteen follow-up tasks', () => {
  const leads = twentyOneLeads();

  it('reads twenty-one relationships', () => {
    expect(leads).toHaveLength(21);
  });

  it('creates exactly nineteen, one per eligible lead', () => {
    const plan = planFollowUpTasks(leads, []);

    expect(plan.eligible).toBe(19);
    expect(plan.toCreate).toBe(19);
    expect(plan.toUpdate).toBe(0);
    expect(plan.unchanged).toBe(0);
    expect(plan.toClose).toBe(0);
    expect(followUpTaskCounts(plan)).toMatchObject({
      leadsRead: 21,
      eligibleLeads: 19,
      excludedLeads: 2,
      tasksToCreate: 19,
    });
  });

  it('creates none for the two that opted out, and says which and why', () => {
    const plan = planFollowUpTasks(leads, []);

    expect(plan.excluded).toHaveLength(2);
    expect(plan.excluded.map((e) => e.lead.id).sort()).toEqual(['lead-20', 'lead-21']);
    expect(plan.excluded.map((e) => e.reason).join(' ')).toContain('no follow-up on purpose');
    expect(plan.excluded.map((e) => e.reason).join(' ')).toContain('On hold');

    // And nothing at all is planned against them.
    for (const id of ['lead-20', 'lead-21']) {
      expect(plan.entries.some((e) => e.lead.id === id)).toBe(false);
    }
  });

  it('gives every task the lead’s own date and a title naming the prospect', () => {
    const plan = planFollowUpTasks(leads, []);

    for (const entry of plan.entries) {
      expect(entry.fields?.due_date).toBe(entry.lead.next_action_date);
      expect(entry.fields?.title).toBe(`Follow up with ${entry.lead.prospect_name}`);
      expect(entry.fields?.status).toBe('open');
      expect(entry.fields?.follow_up_rule_managed).toBe(true);
      // Blank calendar ids and pending, because nothing has been pushed yet.
      expect(entry.fields?.calendar_sync_status).toBe('pending');
      expect(entry.fields?.sync_error).toBeNull();
    }
  });

  it('puts the lead’s recorded next action in the notes when there is one', () => {
    const plan = planFollowUpTasks(leads, []);
    const withAction = plan.entries.filter((e) => e.lead.next_action !== null);
    const without = plan.entries.filter((e) => e.lead.next_action === null);

    expect(withAction.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);

    for (const entry of withAction) {
      expect(entry.fields?.notes).toBe(entry.lead.next_action);
    }
    for (const entry of without) {
      // Something honest rather than a blank or a made-up instruction.
      expect(entry.fields?.notes).toBe(NO_NEXT_ACTION_NOTE);
    }
  });

  /**
   * Running it three times, the way the real thing will be run.
   *
   * Each pass is given the tasks the previous pass produced, so this is the whole
   * loop and not just the planner talking to itself.
   */
  it('leaves nineteen after three runs, not fifty-seven', () => {
    let tasks: Task[] = [];
    const counts: number[] = [];

    for (let run = 1; run <= 3; run += 1) {
      const plan = planFollowUpTasks(leads, tasks);

      for (const entry of plan.entries) {
        if (entry.action === 'create' && entry.fields) {
          tasks = [
            ...tasks,
            makeTask({
              id: `task-${entry.lead.id}`,
              lead_id: entry.lead.id,
              task_type: 'follow_up',
              ...entry.fields,
            }),
          ];
        } else if (entry.action === 'update' && entry.fields) {
          tasks = tasks.map((t) =>
            t.id === entry.taskId ? makeTask({ ...t, ...entry.fields }) : t,
          );
        }
      }

      counts.push(tasks.length);
      if (run === 1) {
        expect(plan.toCreate, 'first run creates').toBe(19);
      } else {
        expect(plan.toCreate, `run ${run} creates nothing`).toBe(0);
        expect(plan.toUpdate, `run ${run} changes nothing`).toBe(0);
        expect(plan.unchanged, `run ${run} finds them all correct`).toBe(19);
      }
    }

    expect(counts).toEqual([19, 19, 19]);
  });
});

/* ========================================================= eligibility === */

describe('who gets a task and who does not', () => {
  const cases: [string, Partial<Lead>, boolean][] = [
    ['followed up on the usual rhythm', {}, true],
    ['set to no follow-up on purpose', { follow_up_mode: 'none' }, false],
    ['on hold', { follow_up_mode: 'hold' }, false],
    ['archived', { follow_up_mode: 'archived' }, false],
    ['won', { stage: 'won' }, false],
    ['lost', { stage: 'lost' }, false],
    ['with no follow-up date at all', { next_action_date: null }, false],
  ];

  for (const [name, over, expected] of cases) {
    it(`${expected ? 'gives' : 'gives no'} task to a lead ${name}`, () => {
      const plan = planFollowUpTasks([eligible(over)], []);
      expect(plan.toCreate).toBe(expected ? 1 : 0);
      expect(plan.excluded).toHaveLength(expected ? 0 : 1);
      if (!expected) expect(plan.excluded[0].reason).toBeTruthy();
    });
  }
});

/* ============================================== updating what exists === */

describe('an existing task is moved rather than duplicated', () => {
  it('finds nothing to do when it already says the right thing', () => {
    const plan = planFollowUpTasks([eligible()], [managed()]);

    expect(plan.unchanged).toBe(1);
    expect(plan.toCreate).toBe(0);
    expect(plan.entries[0].changed).toEqual([]);
  });

  it('moves the date when the lead’s date moved', () => {
    const plan = planFollowUpTasks([eligible({ next_action_date: '2026-10-20' })], [managed()]);

    expect(plan.toUpdate).toBe(1);
    expect(plan.entries[0].taskId).toBe('T');
    expect(plan.entries[0].changed).toContain('due_date');
    expect(plan.entries[0].fields?.due_date).toBe('2026-10-20');
  });

  it('reopens one that was finished, and clears the completion', () => {
    const done = managed({ status: 'done', completed_at: '2026-10-10T09:00:00.000Z' });
    const plan = planFollowUpTasks([eligible()], [done]);

    expect(plan.toUpdate).toBe(1);
    expect(plan.entries[0].changed).toEqual(expect.arrayContaining(['status', 'completed_at']));
    expect(plan.entries[0].fields?.status).toBe('open');
    expect(plan.entries[0].fields?.completed_at).toBeNull();
  });

  it('marks the calendar stale whenever it changes something', () => {
    const plan = planFollowUpTasks([eligible({ next_action_date: '2026-10-20' })], [managed()]);
    expect(plan.entries[0].fields?.calendar_sync_status).toBe('pending');
    expect(plan.entries[0].fields?.sync_error).toBeNull();
  });

  it('does not touch a task that is already synced and still correct', () => {
    // No change means no write, which is what stops the calendar being told to
    // update an event that has not moved.
    const synced = managed({
      calendar_sync_status: 'synced',
      external_calendar_id: 'cal',
      external_event_id: 'evt',
    });
    const plan = planFollowUpTasks([eligible()], [synced]);
    expect(plan.unchanged).toBe(1);
    expect(plan.toUpdate).toBe(0);
  });

  it('adopts an open follow-up somebody made by hand instead of adding a second', () => {
    const theirs = makeTask({
      id: 'MANUAL',
      lead_id: 'L',
      task_type: 'follow_up',
      status: 'open',
      due_date: '2026-10-01',
      title: 'Ring Taylor about the mockup',
      notes: 'He asked for a price on the three page version',
      follow_up_rule_managed: false,
    });
    const plan = planFollowUpTasks([eligible()], [theirs]);

    expect(plan.toCreate).toBe(0);
    expect(plan.toUpdate).toBe(1);
    expect(plan.entries[0].taskId).toBe('MANUAL');
    expect(plan.entries[0].changed).toContain('follow_up_rule_managed');
    // Their wording survives, because the lead has no recorded next action.
    expect(plan.entries[0].fields?.notes).toBe('He asked for a price on the three page version');
  });

  it('prefers the lead’s recorded next action over the task’s old notes', () => {
    const theirs = managed({ notes: 'Something older' });
    const lead = eligible({ next_action: 'Send the revised quote' });
    const plan = planFollowUpTasks([lead], [theirs]);

    expect(plan.entries[0].fields?.notes).toBe('Send the revised quote');
    expect(plan.entries[0].changed).toContain('notes');
  });
});

/* ========================================= what it refuses to touch === */

describe('it only ever edits the follow-up task it owns', () => {
  const otherTypes: Task['task_type'][] = [
    'measurement_check', 'publish', 'marketing_action', 'admin',
  ];

  for (const type of otherTypes) {
    it(`never changes a ${type} task, even one attached to the lead`, () => {
      const other = makeTask({
        id: 'OTHER',
        lead_id: 'L',
        task_type: type,
        status: 'open',
        due_date: '2026-10-01',
        title: 'Something else entirely',
      });
      const plan = planFollowUpTasks([eligible()], [other]);

      // A task is created for the lead, and the other one is not in the plan.
      expect(plan.toCreate).toBe(1);
      expect(plan.entries.some((e) => e.taskId === 'OTHER')).toBe(false);
    });
  }

  it('never changes a follow-up belonging to a different lead', () => {
    const elsewhere = managed({ id: 'OTHER', lead_id: 'SOMEBODY-ELSE' });
    const plan = planFollowUpTasks([eligible()], [elsewhere]);

    expect(plan.toCreate).toBe(1);
    expect(plan.entries.some((e) => e.taskId === 'OTHER')).toBe(false);
  });

  it('never changes a follow-up attached to no lead at all', () => {
    const loose = makeTask({
      id: 'LOOSE', lead_id: null, task_type: 'follow_up', status: 'open',
    });
    const plan = planFollowUpTasks([eligible()], [loose]);

    expect(plan.toCreate).toBe(1);
    expect(plan.entries.some((e) => e.taskId === 'LOOSE')).toBe(false);
  });

  it('declares itself nondestructive, and has no delete to be otherwise', () => {
    const plan = planFollowUpTasks(twentyOneLeads(), []);
    expect(plan.nondestructive).toBe(true);
    expect(plan.entries.every((e) => e.action !== ('delete' as never))).toBe(true);
  });
});

/* ================================================= stopping the chase === */

describe('a lead that stops being followed up', () => {
  it('has the rule’s task marked skipped rather than deleted', () => {
    const plan = planFollowUpTasks([eligible({ follow_up_mode: 'hold' })], [managed()]);

    expect(plan.toClose).toBe(1);
    expect(plan.entries[0].action).toBe('close');
    expect(plan.entries[0].taskId).toBe('T');
    expect(plan.entries[0].reason).toContain('skipped rather than deleted');
  });

  it('leaves a task somebody made by hand completely alone', () => {
    const theirs = makeTask({
      id: 'MANUAL', lead_id: 'L', task_type: 'follow_up', status: 'open',
      follow_up_rule_managed: false,
    });
    const plan = planFollowUpTasks([eligible({ follow_up_mode: 'hold' })], [theirs]);

    expect(plan.toClose).toBe(0);
    expect(plan.entries).toEqual([]);
  });

  it('does nothing when the rule’s task is already closed', () => {
    const closed = managed({ status: 'skipped' });
    const plan = planFollowUpTasks([eligible({ follow_up_mode: 'none' })], [closed]);
    expect(plan.toClose).toBe(0);
  });
});

/* =============================================== the small helpers === */

describe('the lookups say which task is whose', () => {
  it('finds only a task carrying the flag', () => {
    expect(managedFollowUpTask([managed()], 'L')?.id).toBe('T');
    expect(managedFollowUpTask([managed({ follow_up_rule_managed: false })], 'L')).toBeNull();
  });

  it('falls back to an open follow-up for adoption, but never a closed one', () => {
    const open = makeTask({
      id: 'M', lead_id: 'L', task_type: 'follow_up', status: 'open',
      follow_up_rule_managed: false,
    });
    const done = makeTask({
      id: 'M', lead_id: 'L', task_type: 'follow_up', status: 'done',
      follow_up_rule_managed: false,
    });
    expect(adoptableFollowUpTask([open], 'L')?.id).toBe('M');
    expect(adoptableFollowUpTask([done], 'L')).toBeNull();
  });

  it('reports no change when nothing differs', () => {
    const lead = eligible();
    expect(followUpTaskChanges(managed(), desiredFollowUpTask(lead, managed()))).toEqual([]);
  });
});
