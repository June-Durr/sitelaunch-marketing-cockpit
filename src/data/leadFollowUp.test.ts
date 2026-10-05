/**
 * Recording a contact, through a real repository.
 *
 * src/config/followUp.test.ts proves the rule decides the right thing. This proves
 * the writes that carry it out actually happen, and that they happen once: one
 * follow-up task per lead, moved rather than multiplied, however many times a
 * contact is logged.
 *
 * The browser-local adapter is used as the repository, so these are real inserts
 * and updates against real stored rows. src/test/pg/leadMirror.test.ts asserts the
 * database refuses a second open follow-up even if this code ever asked for one.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createLocalRepository } from './localRepository';
import { countsAsContact, recordContact, recordContactIfRelevant } from './leadFollowUp';
import { completeTask } from './taskCompletion';
import type { Repository } from './repository';
import type { ActivityType, Dataset, Lead } from '../types/domain';
import { newLead, newTask } from '../test/fixtures';
import { NON_TOUCH_ACTIVITY } from '../config/followUp';

/** A context standing in for the DataProvider, backed by a real repository. */
function harness(repo: Repository) {
  return {
    insert: ((table: never, row: never) => repo.insert(table, row)) as never,
    update: ((table: never, id: string, patch: never) =>
      repo.update(table, id, patch)) as never,
  };
}

beforeEach(() => {
  localStorage.clear();
});

/** A repository holding exactly one lead and nothing else of interest. */
async function withLead(over: Parameters<typeof newLead>[0] = {}) {
  const repo = createLocalRepository();
  await repo.replaceAll?.({
    accounts: [], contentItems: [], snapshots: [], traffic: [], leads: [],
    tasks: [], recommendations: [], activityEvents: [],
  });

  const lead = await repo.insert('leads', newLead({
    prospect_name: 'Taylor',
    organization: 'Your Local Handyman',
    stage: 'follow_up',
    ...over,
  }));

  const data = await repo.loadAll();
  return { repo, ctx: harness(repo), lead, data };
}

const reload = (repo: Repository): Promise<Dataset> => repo.loadAll();

const followUps = (data: Dataset, leadId: string) =>
  data.tasks.filter((t) => t.lead_id === leadId && t.task_type === 'follow_up');

/* ------------------------------------------------------------------------ */

describe('which activities count as being in touch', () => {
  it('excludes exactly the types the rule excludes, and nothing else', () => {
    for (const type of NON_TOUCH_ACTIVITY) {
      expect(countsAsContact(type), type).toBe(false);
    }
    for (const type of [
      'follow_up_sent', 'reply_received', 'conversation', 'proposal_sent',
      'networking_event', 'contact_added', 'lead_created', 'other',
    ] as ActivityType[]) {
      expect(countsAsContact(type), type).toBe(true);
    }
  });
});

describe('logging a contact moves the follow-up on', () => {
  it('creates one follow-up task and sets the date on the lead', async () => {
    const { repo, ctx, lead } = await withLead();
    const outcome = await recordContact(ctx, await reload(repo), lead, '2026-10-05');

    expect(outcome.plan.kind).toBe('create');
    expect(outcome.taskChanged).toBe(true);

    const after = await reload(repo);
    const tasks = followUps(after, lead.id);
    expect(tasks).toHaveLength(1);
    // follow_up stage is a seven day rhythm.
    expect(tasks[0].due_date).toBe('2026-10-12');
    expect(tasks[0].status).toBe('open');
    expect(tasks[0].title).toBe('Follow up with Taylor');
    // And the reason is on the task, not only in a toast that vanished.
    expect(tasks[0].notes).toContain('7 days');

    const updated = after.leads.find((l) => l.id === lead.id) as Lead;
    expect(updated.next_action_date).toBe('2026-10-12');
  });

  it('fills in the next action only when there was nothing there', async () => {
    const { repo, ctx, lead } = await withLead();
    await recordContact(ctx, await reload(repo), lead, '2026-10-05');

    const after = await reload(repo);
    expect((after.leads.find((l) => l.id === lead.id) as Lead).next_action)
      .toBe('Follow up with Taylor');
  });

  it('never overwrites a next action somebody wrote themselves', async () => {
    const { repo, ctx, lead } = await withLead({
      next_action: 'Ask about the Spanish version of the mockup',
    });
    await recordContact(ctx, await reload(repo), lead, '2026-10-05');

    const after = await reload(repo);
    const updated = after.leads.find((l) => l.id === lead.id) as Lead;
    expect(updated.next_action).toBe('Ask about the Spanish version of the mockup');
    // The date still moved; only the words were left alone.
    expect(updated.next_action_date).toBe('2026-10-12');
  });

  it('uses the stage’s own rhythm', async () => {
    for (const [stage, due] of [
      ['new_contact', '2026-11-04'],
      ['follow_up', '2026-10-12'],
      ['call_scheduled', '2026-10-08'],
      ['proposal', '2026-10-10'],
      ['waiting', '2026-10-19'],
    ] as const) {
      localStorage.clear();
      const { repo, ctx, lead } = await withLead({ stage });
      await recordContact(ctx, await reload(repo), lead, '2026-10-05');

      const after = await reload(repo);
      expect(followUps(after, lead.id)[0].due_date, stage).toBe(due);
    }
  });

  it('takes the day from when the contact happened, not from now', async () => {
    const { repo, ctx, lead } = await withLead();
    // A touch being logged late, for something that happened last month.
    await recordContact(ctx, await reload(repo), lead, '2026-09-19T15:00:00.000Z');

    const after = await reload(repo);
    expect(followUps(after, lead.id)[0].due_date).toBe('2026-09-26');
  });
});

describe('a second contact moves the same task rather than adding another', () => {
  it('leaves exactly one open follow-up after three contacts', async () => {
    const { repo, ctx, lead } = await withLead();

    const first = await recordContact(ctx, await reload(repo), lead, '2026-10-05');
    const second = await recordContact(ctx, await reload(repo), lead, '2026-10-07');
    const third = await recordContact(ctx, await reload(repo), lead, '2026-10-09');

    expect(first.plan.kind).toBe('create');
    expect(second.plan.kind).toBe('reschedule');
    expect(third.plan.kind).toBe('reschedule');
    // The same task both times, which is the whole point.
    expect(second.plan.taskId).toBe(third.plan.taskId);
    expect(first.plan.taskId).toBeNull();

    const after = await reload(repo);
    const tasks = followUps(after, lead.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].due_date).toBe('2026-10-16');
    expect((after.leads.find((l) => l.id === lead.id) as Lead).next_action_date)
      .toBe('2026-10-16');
  });

  it('starts a new one once the old one has been finished', async () => {
    const { repo, ctx, lead } = await withLead();
    const first = await recordContact(ctx, await reload(repo), lead, '2026-10-05');
    // A create plan has no task id: the task did not exist when it was planned.
    expect(first.plan.taskId).toBeNull();

    const created = followUps(await reload(repo), lead.id)[0];
    await repo.update('tasks', created.id, { status: 'done' });

    const second = await recordContact(ctx, await reload(repo), lead, '2026-10-07');
    expect(second.plan.kind).toBe('create');

    const after = await reload(repo);
    expect(followUps(after, lead.id)).toHaveLength(2);
    expect(followUps(after, lead.id).filter((t) => t.status === 'open')).toHaveLength(1);
  });
});

describe('a deliberate decision survives somebody logging a note', () => {
  for (const over of [
    { follow_up_mode: 'none' as const },
    { follow_up_mode: 'hold' as const },
    { follow_up_mode: 'archived' as const },
    { stage: 'won' as const },
    { stage: 'lost' as const },
  ]) {
    const name = Object.entries(over).map(([k, v]) => `${k}=${v}`).join(' ');
    it(`writes no task and moves no date for ${name}`, async () => {
      localStorage.clear();
      const { repo, ctx, lead } = await withLead(over);
      const outcome = await recordContact(ctx, await reload(repo), lead, '2026-10-05');

      expect(outcome.plan.kind).toBe('none');
      expect(outcome.taskChanged).toBe(false);
      expect(outcome.leadChanged).toBe(false);
      expect(outcome.plan.reason).toBeTruthy();

      const after = await reload(repo);
      expect(followUps(after, lead.id)).toEqual([]);
      expect((after.leads.find((l) => l.id === lead.id) as Lead).next_action_date)
        .toBeNull();
    });
  }
});

describe('recording a contact only when there is a contact to record', () => {
  it('does nothing when the activity names nobody', async () => {
    const { repo, ctx } = await withLead();
    const outcome = await recordContactIfRelevant(ctx, await reload(repo), {
      leadId: null,
      activityType: 'follow_up_sent',
      occurredAt: '2026-10-05T12:00:00.000Z',
    });
    expect(outcome).toBeNull();
  });

  it('does nothing for an activity that is not contact', async () => {
    const { repo, ctx, lead } = await withLead();
    const outcome = await recordContactIfRelevant(ctx, await reload(repo), {
      leadId: lead.id,
      activityType: 'analytics_check',
      occurredAt: '2026-10-05T12:00:00.000Z',
    });

    expect(outcome).toBeNull();
    expect(followUps(await reload(repo), lead.id)).toEqual([]);
  });

  it('does nothing for a lead that is not there', async () => {
    const { repo, ctx } = await withLead();
    const outcome = await recordContactIfRelevant(ctx, await reload(repo), {
      leadId: 'a-lead-that-does-not-exist',
      activityType: 'follow_up_sent',
      occurredAt: '2026-10-05T12:00:00.000Z',
    });
    expect(outcome).toBeNull();
  });
});

describe('finishing a follow-up task reschedules the next one', () => {
  it('logs the activity and moves the same task, leaving one open', async () => {
    const { repo, ctx, lead } = await withLead();

    const task = await repo.insert('tasks', newTask({
      lead_id: lead.id,
      title: 'Follow up with Taylor',
      task_type: 'follow_up',
      status: 'open',
      due_date: '2026-10-05',
    }));

    const result = await completeTask(
      ctx, await reload(repo), task, '2026-10-05T12:00:00.000Z',
    );

    expect(result.activityCreated).toBe(true);
    expect(result.followUp?.plan.kind).toBe('reschedule');

    const after = await reload(repo);
    // The task is done and has been moved forward, and there is still only one.
    const tasks = followUps(after, lead.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(task.id);
    expect(tasks[0].due_date).toBe('2026-10-12');

    // One activity, and it is linked to the person.
    const logged = after.activityEvents.filter((a) => a.lead_id === lead.id);
    expect(logged).toHaveLength(1);
    expect(logged[0].activity_type).toBe('follow_up_sent');
    expect(logged[0].source).toBe('task_completion');
  });

  it('does nothing to a follow-up for a task that names no person', async () => {
    const { repo, ctx } = await withLead();
    const task = await repo.insert('tasks', newTask({
      title: 'Write the newsletter',
      task_type: 'marketing_action',
      status: 'open',
      due_date: '2026-10-05',
    }));

    const result = await completeTask(
      ctx, await reload(repo), task, '2026-10-05T12:00:00.000Z',
    );
    expect(result.followUp).toBeNull();
  });

  it('does not move anything when the activity was already logged', async () => {
    const { repo, ctx, lead } = await withLead();
    const task = await repo.insert('tasks', newTask({
      lead_id: lead.id,
      title: 'Follow up with Taylor',
      task_type: 'follow_up',
      status: 'open',
      due_date: '2026-10-05',
    }));

    await completeTask(ctx, await reload(repo), task, '2026-10-05T12:00:00.000Z');
    const between = await reload(repo);
    const dueAfterFirst = followUps(between, lead.id)[0].due_date;

    // Ticking it again, for instance after reopening it.
    const again = await completeTask(ctx, between, task, '2026-10-09T12:00:00.000Z');

    expect(again.alreadyLogged).toBe(true);
    expect(again.followUp).toBeNull();

    const after = await reload(repo);
    expect(after.activityEvents.filter((a) => a.task_id === task.id)).toHaveLength(1);
    // The date did not creep forward on a repeat tick either.
    expect(followUps(after, lead.id)[0].due_date).toBe(dueAfterFirst);
  });
});
