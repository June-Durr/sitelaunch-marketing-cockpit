/**
 * The follow-up task reconciliation, run against a real Postgres.
 *
 * There are two implementations of this rule on purpose. planFollowUpTasks in
 * src/config/followUpTasks.ts is what the browser uses; reconcile_follow_up_tasks
 * in migration 0009 is what runs server side, where there is no browser and no
 * session, and is therefore what can be reviewed against the hosted project
 * before anything is written.
 *
 * Two implementations of one rule is a liability unless something checks them, so
 * this file is that check. Every case runs through both and fails if they
 * disagree about a single lead.
 *
 * Every person here is invented and every date is fixed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planFollowUpTasks } from '../../config/followUpTasks';
import { makeLead, makeTask, twentyOneLeads } from '../fixtures';
import { freshDatabase, seedRow, USER_A, USER_B, type TestDatabase } from './harness';
import type { Lead, Task } from '../../types/domain';

let t: TestDatabase;

beforeEach(async () => {
  t = await freshDatabase();
});

afterEach(async () => {
  await t.close();
});

/* ------------------------------------------------------------------ seeding --- */

/** Put a fixture lead in the database, returning the id Postgres gave it. */
async function insertLead(owner: string, lead: Lead): Promise<string> {
  return seedRow(t, owner, 'leads', {
    prospect_name: lead.prospect_name,
    organization: lead.organization,
    email: lead.email,
    stage: lead.stage,
    next_action: lead.next_action,
    next_action_date: lead.next_action_date,
    follow_up_mode: lead.follow_up_mode,
    preferred_channel: lead.preferred_channel,
    reported_last_touch_at: lead.reported_last_touch_at,
    external_source: lead.external_source,
    external_key: lead.external_key,
  });
}

async function insertTask(owner: string, leadId: string | null, task: Partial<Task>) {
  return seedRow(t, owner, 'tasks', {
    lead_id: leadId,
    title: task.title ?? 'Follow up',
    task_type: task.task_type ?? 'follow_up',
    status: task.status ?? 'open',
    due_date: task.due_date ?? '2026-10-12',
    notes: task.notes ?? null,
    completed_at: task.completed_at ?? null,
    follow_up_rule_managed: task.follow_up_rule_managed ?? false,
    calendar_sync_status: task.calendar_sync_status ?? 'not_synced',
  });
}

interface ReconcileRow {
  action: string;
  lead_id: string;
  task_id: string | null;
  prospect: string;
  due_date: string | Date | null;
  changed: string[];
  reason: string;
}

async function reconcile(owner: string, dryRun: boolean): Promise<ReconcileRow[]> {
  return t.asUser(owner, async () => {
    const result = await t.db.query<ReconcileRow>(
      'select * from reconcile_follow_up_tasks($1)',
      [dryRun],
    );
    return result.rows;
  });
}

async function taskRows(owner: string) {
  const result = await t.db.query<{
    id: string;
    lead_id: string | null;
    title: string;
    notes: string | null;
    task_type: string;
    status: string;
    due_date: string | Date;
    completed_at: string | null;
    follow_up_rule_managed: boolean;
    calendar_sync_status: string;
  }>('select * from tasks where owner_id = $1 order by created_at, id', [owner]);
  return result.rows;
}

const day = (value: string | Date | null) =>
  value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);

const counts = (rows: ReconcileRow[]) => ({
  create: rows.filter((r) => r.action === 'create').length,
  update: rows.filter((r) => r.action === 'update').length,
  unchanged: rows.filter((r) => r.action === 'unchanged').length,
  close: rows.filter((r) => r.action === 'close').length,
});

/* =========================================== the twenty-one lead pipeline === */

describe('the imported pipeline becomes nineteen follow-up tasks', () => {
  beforeEach(async () => {
    for (const lead of twentyOneLeads()) await insertLead(USER_A, lead);
  });

  it('plans nineteen and writes nothing on a dry run', async () => {
    const planned = await reconcile(USER_A, true);

    expect(counts(planned)).toEqual({ create: 19, update: 0, unchanged: 0, close: 0 });
    // A dry run has no task to point at yet, which is how you can tell.
    expect(planned.every((r) => r.task_id === null)).toBe(true);
    expect(await taskRows(USER_A)).toEqual([]);
  });

  it('creates exactly nineteen when it is allowed to write', async () => {
    const applied = await reconcile(USER_A, false);
    expect(counts(applied)).toEqual({ create: 19, update: 0, unchanged: 0, close: 0 });

    const tasks = await taskRows(USER_A);
    expect(tasks).toHaveLength(19);
    expect(tasks.every((task) => task.follow_up_rule_managed)).toBe(true);
    expect(tasks.every((task) => task.status === 'open')).toBe(true);
    expect(tasks.every((task) => task.task_type === 'follow_up')).toBe(true);
    expect(tasks.every((task) => task.lead_id !== null)).toBe(true);
    // Blank calendar ids and pending, because nothing has been pushed yet.
    expect(tasks.every((task) => task.calendar_sync_status === 'pending')).toBe(true);
  });

  it('creates none for the two that opted out', async () => {
    await reconcile(USER_A, false);

    const optedOut = await t.db.query<{ n: string }>(
      `select count(*)::text as n
         from tasks t join leads l on l.id = t.lead_id
        where l.follow_up_mode <> 'auto'`,
      [],
    );
    expect(Number(optedOut.rows[0].n)).toBe(0);

    const total = await t.db.query<{ n: string }>(
      'select count(*)::text as n from leads where owner_id = $1',
      [USER_A],
    );
    expect(Number(total.rows[0].n)).toBe(21);
  });

  it('gives every task its own lead’s date', async () => {
    await reconcile(USER_A, false);

    const joined = await t.db.query<{ due_date: string | Date; next_action_date: string | Date }>(
      `select t.due_date, l.next_action_date
         from tasks t join leads l on l.id = t.lead_id
        where t.owner_id = $1`,
      [USER_A],
    );
    expect(joined.rows).toHaveLength(19);
    for (const row of joined.rows) {
      expect(day(row.due_date)).toBe(day(row.next_action_date));
    }
  });

  it('leaves nineteen after three runs, not fifty-seven', async () => {
    const first = await reconcile(USER_A, false);
    expect(counts(first).create).toBe(19);
    expect(await taskRows(USER_A)).toHaveLength(19);

    for (const run of [2, 3]) {
      const again = await reconcile(USER_A, false);
      expect(counts(again), `run ${run}`).toEqual({
        create: 0, update: 0, unchanged: 19, close: 0,
      });
      expect(await taskRows(USER_A), `run ${run}`).toHaveLength(19);
    }
  });

  it('does not touch a task it has already synced on a later run', async () => {
    await reconcile(USER_A, false);
    // A distinct event id each, because tasks_unique_external_event from
    // migration 0003 quite rightly refuses to let two tasks claim one event.
    await t.db.query(
      `update tasks set calendar_sync_status = 'synced',
                        external_calendar_id = 'cal',
                        external_event_id = 'evt-' || id
        where owner_id = $1`,
      [USER_A],
    );

    await reconcile(USER_A, false);

    const stillSynced = await t.db.query<{ n: string }>(
      `select count(*)::text as n from tasks
        where owner_id = $1 and calendar_sync_status = 'synced'`,
      [USER_A],
    );
    expect(Number(stillSynced.rows[0].n)).toBe(19);
  });
});

/* ====================================== the two implementations agree === */

describe('the SQL and the TypeScript plan the same thing', () => {
  /**
   * Each case is a pipeline and a task list. Both planners see the same inputs,
   * and the test fails if they disagree about any lead's outcome.
   */
  const CASES: { name: string; leads: Lead[]; tasks: Partial<Task>[] }[] = [
    { name: 'the whole twenty-one lead pipeline, from nothing', leads: twentyOneLeads(), tasks: [] },
    {
      name: 'a lead whose date moved',
      leads: [makeLead({ id: 'L', prospect_name: 'Taylor', stage: 'follow_up', next_action_date: '2026-10-20' })],
      tasks: [{ title: 'Follow up with Taylor', due_date: '2026-10-12', follow_up_rule_managed: true }],
    },
    {
      name: 'a finished task that has to be reopened',
      leads: [makeLead({ id: 'L', prospect_name: 'Taylor', stage: 'follow_up', next_action_date: '2026-10-20' })],
      tasks: [{
        title: 'Follow up with Taylor', due_date: '2026-10-20', status: 'done',
        completed_at: '2026-10-19T09:00:00.000Z', follow_up_rule_managed: true,
      }],
    },
    {
      name: 'a task that is already exactly right',
      leads: [makeLead({
        id: 'L', prospect_name: 'Taylor', stage: 'follow_up',
        next_action_date: '2026-10-12', next_action: 'Send the quote',
      })],
      tasks: [{
        title: 'Follow up with Taylor', notes: 'Send the quote',
        due_date: '2026-10-12', follow_up_rule_managed: true,
      }],
    },
    {
      name: 'an open follow-up somebody made by hand, to be adopted',
      leads: [makeLead({ id: 'L', prospect_name: 'Taylor', stage: 'follow_up', next_action_date: '2026-10-12' })],
      tasks: [{ title: 'Ring Taylor', notes: 'He asked about price', due_date: '2026-10-01' }],
    },
    {
      name: 'a lead put on hold while the rule still held a task',
      leads: [makeLead({ id: 'L', prospect_name: 'Taylor', stage: 'waiting', follow_up_mode: 'hold', next_action_date: '2026-10-12' })],
      tasks: [{ title: 'Follow up with Taylor', due_date: '2026-10-12', follow_up_rule_managed: true }],
    },
    {
      name: 'a won lead whose task is still open',
      leads: [makeLead({ id: 'L', prospect_name: 'Taylor', stage: 'won', next_action_date: '2026-10-12' })],
      tasks: [{ title: 'Follow up with Taylor', due_date: '2026-10-12', follow_up_rule_managed: true }],
    },
    {
      name: 'a lead with no date at all',
      leads: [makeLead({ id: 'L', prospect_name: 'Taylor', stage: 'follow_up', next_action_date: null })],
      tasks: [],
    },
    {
      name: 'other kinds of task attached to the same lead',
      leads: [makeLead({ id: 'L', prospect_name: 'Taylor', stage: 'follow_up', next_action_date: '2026-10-12' })],
      tasks: [
        { title: 'Check the numbers', task_type: 'measurement_check' },
        { title: 'Publish the case study', task_type: 'publish' },
        { title: 'Chase the invoice', task_type: 'admin' },
      ],
    },
  ];

  for (const testCase of CASES) {
    it(`agrees about ${testCase.name}`, async () => {
      // Seed, keeping a map from the fixture id to the id Postgres chose.
      const idByFixture = new Map<string, string>();
      for (const lead of testCase.leads) {
        idByFixture.set(lead.id, await insertLead(USER_A, lead));
      }
      const leadId = idByFixture.get(testCase.leads[0]?.id ?? '') ?? null;
      const seededTasks: Task[] = [];
      for (const task of testCase.tasks) {
        const id = await insertTask(USER_A, leadId, task);
        seededTasks.push(makeTask({ ...task, id, lead_id: leadId }));
      }

      // The TypeScript planner, over leads carrying the database's own ids.
      const leadsWithRealIds = testCase.leads.map((lead) =>
        makeLead({ ...lead, id: idByFixture.get(lead.id) as string }),
      );
      const expected = planFollowUpTasks(leadsWithRealIds, seededTasks);

      const actual = await reconcile(USER_A, true);

      // Same decision per lead, compared as a sorted list so ordering is not
      // what is under test here.
      const asPairs = (rows: { lead: string; action: string }[]) =>
        rows.map((r) => `${r.lead}:${r.action}`).sort();

      expect(
        asPairs(actual.map((r) => ({ lead: r.lead_id, action: r.action }))),
      ).toEqual(
        asPairs(expected.entries.map((e) => ({ lead: e.lead.id, action: e.action }))),
      );

      // And the same target task, and the same date, for everything it will write.
      for (const row of actual) {
        const match = expected.entries.find(
          (e) => e.lead.id === row.lead_id && e.action === row.action,
        );
        expect(match, `${row.action} for ${row.lead_id}`).toBeTruthy();
        if (match?.fields) {
          expect(day(row.due_date), 'due date').toBe(match.fields.due_date);
        }
        if (match?.taskId) {
          expect(row.task_id, 'task').toBe(match.taskId);
        }
      }
    });
  }
});

/* ============================================ what it refuses to touch === */

describe('reconciliation only edits the follow-up task it owns', () => {
  it('leaves every other kind of task exactly as it was', async () => {
    const leadId = await insertLead(
      USER_A,
      makeLead({ id: 'L', prospect_name: 'Taylor', stage: 'follow_up', next_action_date: '2026-10-12' }),
    );
    for (const type of ['measurement_check', 'publish', 'marketing_action', 'admin'] as const) {
      await insertTask(USER_A, leadId, {
        title: `A ${type} task`, task_type: type, due_date: '2026-10-01',
      });
    }

    const before = await taskRows(USER_A);
    await reconcile(USER_A, false);
    const after = await taskRows(USER_A);

    // One new follow-up, and the other four untouched down to the last column.
    expect(after).toHaveLength(before.length + 1);
    for (const original of before) {
      const same = after.find((task) => task.id === original.id);
      expect(same, original.title).toEqual(original);
    }
  });

  it('leaves a follow-up somebody made for a different lead alone', async () => {
    const mine = await insertLead(
      USER_A,
      makeLead({ id: 'L1', prospect_name: 'Taylor', stage: 'follow_up', next_action_date: '2026-10-12' }),
    );
    const other = await insertLead(
      USER_A,
      makeLead({ id: 'L2', prospect_name: 'Ariel', stage: 'waiting', follow_up_mode: 'none' }),
    );
    const theirs = await insertTask(USER_A, other, {
      title: 'Ring Ariel one day', due_date: '2026-10-01',
    });

    await reconcile(USER_A, false);

    const after = await taskRows(USER_A);
    const untouched = after.find((task) => task.id === theirs);
    expect(untouched?.title).toBe('Ring Ariel one day');
    expect(untouched?.status).toBe('open');
    expect(untouched?.follow_up_rule_managed).toBe(false);
    expect(after.filter((task) => task.lead_id === mine)).toHaveLength(1);
  });

  it('never deletes anything', async () => {
    const leadId = await insertLead(
      USER_A,
      makeLead({ id: 'L', prospect_name: 'Taylor', stage: 'follow_up', next_action_date: '2026-10-12' }),
    );
    await insertTask(USER_A, leadId, { title: 'Follow up with Taylor', follow_up_rule_managed: true });

    // Put the lead beyond the rule's interest and reconcile.
    await t.db.query(`update leads set follow_up_mode = 'archived' where id = $1`, [leadId]);
    await reconcile(USER_A, false);

    const after = await taskRows(USER_A);
    expect(after).toHaveLength(1);
    // Closed, not removed, and still carrying its history.
    expect(after[0].status).toBe('skipped');
  });
});

/* ================================================== owners stay apart === */

describe('reconciliation cannot reach another account', () => {
  it('plans nothing for leads it cannot see', async () => {
    for (const lead of twentyOneLeads()) await insertLead(USER_B, lead);

    const mine = await reconcile(USER_A, false);
    expect(mine).toEqual([]);
    expect(await taskRows(USER_A)).toEqual([]);
    expect(await taskRows(USER_B)).toEqual([]);
  });

  it('writes only into the account that ran it', async () => {
    for (const lead of twentyOneLeads()) await insertLead(USER_A, lead);
    for (const lead of twentyOneLeads()) await insertLead(USER_B, lead);

    await reconcile(USER_A, false);

    expect(await taskRows(USER_A)).toHaveLength(19);
    expect(await taskRows(USER_B)).toHaveLength(0);
  });

  it('refuses an anonymous caller outright', async () => {
    await t.asAnon(async () => {
      await expect(
        t.db.query('select * from reconcile_follow_up_tasks(true)'),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});

/* ===================================== one owner cannot reach another === */

describe('a signed in person cannot read or alter another account', () => {
  /**
   * Everything this sprint added that carries an identifier worth protecting:
   * the task, its calendar ids, the connection row naming the calendar, and the
   * run history. All four are checked as a signed in user, not as the admin role
   * the tests seed with, because the admin role bypasses row level security and
   * would prove nothing.
   */
  async function seedOtherAccount() {
    const leadId = await insertLead(
      USER_B,
      makeLead({ id: 'L', prospect_name: 'Not Mine', stage: 'follow_up', next_action_date: '2026-10-12' }),
    );
    const taskId = await seedRow(t, USER_B, 'tasks', {
      lead_id: leadId,
      title: 'Follow up with Not Mine',
      task_type: 'follow_up',
      status: 'open',
      due_date: '2026-10-12',
      follow_up_rule_managed: true,
      external_calendar_id: 'their-calendar@group.calendar.google.com',
      external_event_id: 'slctheirsecreteventid0000000000000',
      calendar_sync_status: 'synced',
    });
    await t.db.query(
      `insert into integration_connections (owner_id, provider, provider_account_id, status)
       values ($1, 'google_calendar', 'their-calendar@group.calendar.google.com', 'ready')`,
      [USER_B],
    );
    await t.db.query(
      `insert into sync_runs (owner_id, provider, status, idempotency_key, completed_at)
       values ($1, 'google_calendar', 'succeeded', 'google_calendar:export:2026-10-06', now())`,
      [USER_B],
    );
    return { leadId, taskId };
  }

  it('cannot read their task, or the calendar ids on it', async () => {
    const { taskId } = await seedOtherAccount();

    const visible = await t.asUser(USER_A, async () => {
      const result = await t.db.query(
        'select id, external_calendar_id, external_event_id from tasks',
      );
      return result.rows;
    });
    expect(visible).toEqual([]);

    // Not even when asking for it by id.
    const byId = await t.asUser(USER_A, async () => {
      const result = await t.db.query('select id from tasks where id = $1', [taskId]);
      return result.rows;
    });
    expect(byId).toEqual([]);
  });

  it('cannot alter their task', async () => {
    const { taskId } = await seedOtherAccount();

    await t.asUser(USER_A, async () => {
      await t.db.query(
        `update tasks set due_date = '2099-01-01', external_event_id = 'hijacked'
          where id = $1`,
        [taskId],
      );
    });

    const after = await t.db.query<{ due_date: string | Date; external_event_id: string }>(
      'select due_date, external_event_id from tasks where id = $1',
      [taskId],
    );
    expect(day(after.rows[0].due_date)).toBe('2026-10-12');
    expect(after.rows[0].external_event_id).toBe('slctheirsecreteventid0000000000000');
  });

  it('cannot read which calendar they are writing to', async () => {
    await seedOtherAccount();

    const visible = await t.asUser(USER_A, async () => {
      const result = await t.db.query('select provider_account_id from integration_connections');
      return result.rows;
    });
    expect(visible).toEqual([]);
  });

  it('cannot read their run history', async () => {
    await seedOtherAccount();

    const visible = await t.asUser(USER_A, async () => {
      const result = await t.db.query('select id from sync_runs');
      return result.rows;
    });
    expect(visible).toEqual([]);
  });

  it('cannot reconcile their leads into their task list', async () => {
    await seedOtherAccount();

    const planned = await reconcile(USER_A, false);
    expect(planned).toEqual([]);

    // And their one task is still their one task.
    const theirs = await t.db.query<{ n: string }>(
      'select count(*)::text as n from tasks where owner_id = $1',
      [USER_B],
    );
    expect(Number(theirs.rows[0].n)).toBe(1);
  });
});
