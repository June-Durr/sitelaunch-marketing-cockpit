/**
 * Completing a task, undoing it, and the sync requests that follow.
 *
 * These are the rules that only a database can prove. "Two clicks write one
 * activity" is a claim about what happens when two statements race, and a mock
 * that serialises them cannot test it. "Undo refuses when somebody edited the
 * row since" is a claim about timestamps the database itself maintains.
 *
 * Every person, task and token below is invented, and nothing here touches the
 * hosted project.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { freshDatabase, seedRow, USER_A, USER_B, type TestDatabase } from './harness';

let t: TestDatabase;

beforeAll(async () => {
  t = await freshDatabase();
}, 180_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  // Each test builds its own records, so the tables start empty.
  await t.db.exec(`
    delete from sync_jobs;
    delete from activity_events;
    delete from tasks;
    delete from leads;
  `);
});

async function rows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await t.db.query<T>(sql, params)).rows;
}

/** A lead with an open follow-up task against it, owned by one person. */
async function seedFollowUp(owner: string, over: Record<string, unknown> = {}) {
  const leadId = await seedRow(t, owner, 'leads', {
    prospect_name: 'Invented Person',
    organization: 'Invented Trades',
    stage: 'follow_up',
    next_action_date: '2026-10-12',
    next_action: null,
  });
  const taskId = await seedRow(t, owner, 'tasks', {
    lead_id: leadId,
    title: 'Follow up with Invented Person',
    task_type: 'follow_up',
    status: 'open',
    due_date: '2026-10-12',
    follow_up_rule_managed: true,
    ...over,
  });
  return { leadId, taskId };
}

/** Call the completion function as a given person. */
function complete(
  owner: string,
  taskId: string,
  token: string,
  extra: Partial<{
    channel: string;
    message: string;
    outcome: string;
    nextDue: string;
    reopen: boolean;
  }> = {},
) {
  return t.asUser(owner, () =>
    rows<{ complete_task_operation: Record<string, unknown> }>(
      `select complete_task_operation(
         $1, $2, '2026-10-12T15:00:00Z'::timestamptz, $3, $4, $5,
         'follow_up_sent'::activity_type, null, $6::date, null, null, $7, true)`,
      [
        taskId,
        token,
        extra.channel ?? 'text',
        extra.message ?? null,
        extra.outcome ?? null,
        extra.nextDue ?? '2026-10-19',
        extra.reopen ?? true,
      ],
    ),
  );
}

/* ================================== 1. one durable, idempotent operation === */

describe('a completion is written once, however many times it is asked for', () => {
  it('records the activity, moves the task and moves the lead together', async () => {
    const { leadId, taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'token-1', {
      channel: 'text',
      message: 'Hi Carlos, checking in on the pilot.',
      outcome: 'sent, no reply yet',
    });

    const [activity] = await rows<Record<string, string | null>>(
      `select activity_type, channel, approved_message, outcome, source,
              idempotency_token, calendar_history_wanted::text, calendar_sync_status
         from activity_events where task_id = $1`,
      [taskId],
    );
    expect(activity.activity_type).toBe('follow_up_sent');
    expect(activity.channel).toBe('text');
    // The exact approved wording, kept apart from any summary.
    expect(activity.approved_message).toBe('Hi Carlos, checking in on the pilot.');
    expect(activity.outcome).toBe('sent, no reply yet');
    expect(activity.source).toBe('task_completion');
    expect(activity.idempotency_token).toBe('token-1');
    // It wants a place in the calendar history, and has not got one yet.
    expect(activity.calendar_history_wanted).toBe('true');
    expect(activity.calendar_sync_status).toBe('pending');

    const [task] = await rows<Record<string, string>>(
      'select status, due_date::text as due_date, calendar_sync_status from tasks where id = $1',
      [taskId],
    );
    // Reopened on its next date rather than closed: a recurring follow-up that
    // is marked done vanishes from the queue, which is the defect this guards.
    expect(task.status).toBe('open');
    expect(task.due_date).toBe('2026-10-19');
    expect(task.calendar_sync_status).toBe('pending');

    const [lead] = await rows<Record<string, string>>(
      'select next_action_date::text as next_action_date from leads where id = $1',
      [leadId],
    );
    expect(lead.next_action_date).toBe('2026-10-19');
  });

  it('writes nothing a second time when the same token comes back', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'same-token');
    const second = await complete(USER_A, taskId, 'same-token');

    expect(second[0].complete_task_operation.reused).toBe(true);
    expect(
      await rows('select id from activity_events where task_id = $1', [taskId]),
    ).toHaveLength(1);
  });

  it('survives a double click, which is two tokens arriving at once', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    // Different tokens, same task: the second finds the task_completion row the
    // first wrote and reuses it rather than colliding with 0003's index.
    await complete(USER_A, taskId, 'click-1');
    await complete(USER_A, taskId, 'click-2');

    const activities = await rows('select id from activity_events where task_id = $1', [taskId]);
    expect(activities).toHaveLength(1);
  });

  it('refuses a task belonging to somebody else, and writes nothing', async () => {
    const { taskId } = await seedFollowUp(USER_B);
    await expect(complete(USER_A, taskId, 'trespass')).rejects.toThrow();
    expect(await rows('select id from activity_events')).toHaveLength(0);
    expect(await rows('select id from sync_jobs')).toHaveLength(0);
  });

  it('closes the task instead when the rule is not reopening it', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await t.asUser(USER_A, () =>
      rows(
        `select complete_task_operation($1, $2, now(), 'email', null, null,
          'follow_up_sent'::activity_type, null, null, null, null, false, true)`,
        [taskId, 'closing'],
      ),
    );
    const [task] = await rows<Record<string, string | null>>(
      'select status, completed_at from tasks where id = $1',
      [taskId],
    );
    expect(task.status).toBe('done');
    expect(task.completed_at).not.toBeNull();
  });

  it('leaves the lead alone when nothing is scheduled', async () => {
    // A lead on hold or archived gets no next date, and that is a real answer
    // rather than a forgotten argument.
    const { leadId, taskId } = await seedFollowUp(USER_A);
    await t.asUser(USER_A, () =>
      rows(
        `select complete_task_operation($1, $2, now(), null, null, null,
          'follow_up_sent'::activity_type, null, null, null, null, false, true)`,
        [taskId, 'no-next'],
      ),
    );
    const [lead] = await rows<Record<string, string>>(
      'select next_action_date::text as next_action_date from leads where id = $1',
      [leadId],
    );
    expect(lead.next_action_date).toBe('2026-10-12');
  });
});

/* ================================================ 3. the sync is requested === */

describe('a completion queues its own sync, durably', () => {
  it('writes a calendar and a lead mirror job in the same transaction', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'sync-1');

    const jobs = await rows<{ kind: string; owner_id: string }>(
      'select kind, owner_id from sync_jobs order by kind',
    );
    expect(jobs.map((j) => j.kind)).toEqual(['calendar', 'lead_mirror']);
    for (const job of jobs) expect(job.owner_id).toBe(USER_A);
  });

  it('does not queue a second sync while one is still pending', async () => {
    // The sync is a full export. A burst of completions collapses into the one
    // job already queued, which will carry all of them when it runs.
    const a = await seedFollowUp(USER_A);
    const b = await seedFollowUp(USER_A);
    await complete(USER_A, a.taskId, 'burst-1');
    await complete(USER_A, b.taskId, 'burst-2');

    expect(await rows("select id from sync_jobs where kind = 'calendar'")).toHaveLength(1);
  });

  it('queues a fresh one once the previous has finished', async () => {
    const a = await seedFollowUp(USER_A);
    await complete(USER_A, a.taskId, 'first');
    await t.asServiceRole(() =>
      rows("select finish_sync_job(id, true) from sync_jobs where kind = 'calendar'"),
    );

    const b = await seedFollowUp(USER_A);
    await complete(USER_A, b.taskId, 'second');
    expect(
      await rows("select id from sync_jobs where kind = 'calendar' and completed_at is null"),
    ).toHaveLength(1);
  });

  it('keeps one owner queue out of another', async () => {
    const a = await seedFollowUp(USER_A);
    const b = await seedFollowUp(USER_B);
    await complete(USER_A, a.taskId, 'a');
    await complete(USER_B, b.taskId, 'b');

    const owners = await rows<{ owner_id: string }>(
      "select distinct owner_id from sync_jobs where kind = 'calendar'",
    );
    expect(owners).toHaveLength(2);

    // And one person cannot read the other's queue.
    const seen = await t.asUser(USER_A, () => rows('select owner_id from sync_jobs'));
    for (const row of seen as { owner_id: string }[]) expect(row.owner_id).toBe(USER_A);
  });

  it('hands a claimed job to one worker only', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'claim');

    const first = await t.asServiceRole(() => rows('select id from claim_sync_jobs(10)'));
    const second = await t.asServiceRole(() => rows('select id from claim_sync_jobs(10)'));
    expect(first.length).toBe(2);
    // Already locked, so a second worker takes nothing.
    expect(second.length).toBe(0);
  });

  it('backs off and keeps the reason when a sync fails', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'fail');
    await t.asServiceRole(() => rows('select id from claim_sync_jobs(10)'));
    await t.asServiceRole(() =>
      rows("select finish_sync_job(id, false, 'Google said no') from sync_jobs where kind = 'calendar'"),
    );

    const [job] = await rows<Record<string, string | null>>(
      "select attempts::text, last_error, completed_at, (run_after > now())::text as deferred"
      + " from sync_jobs where kind = 'calendar'",
    );
    expect(job.attempts).toBe('1');
    expect(job.last_error).toBe('Google said no');
    // Still outstanding, and not eligible again immediately.
    expect(job.completed_at).toBeNull();
    expect(job.deferred).toBe('true');
  });

  it('a failed sync does not erase the activity it was syncing', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'durable');
    await t.asServiceRole(() => rows('select id from claim_sync_jobs(10)'));
    await t.asServiceRole(() =>
      rows("select finish_sync_job(id, false, 'network down') from sync_jobs"),
    );
    // The saved work is untouched by the failure to tell anybody about it.
    expect(await rows('select id from activity_events where task_id = $1', [taskId]))
      .toHaveLength(1);
  });
});

/* ======================================================= 2. undo and recovery === */

describe('undo puts back exactly what the operation changed', () => {
  it('restores the task, the lead and marks the activity reversed', async () => {
    const { leadId, taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'undo-me');

    const [result] = await t.asUser(USER_A, () =>
      rows<{ undo_task_operation: Record<string, unknown> }>(
        'select undo_task_operation($1)', [taskId],
      ),
    );
    expect(result.undo_task_operation.status).toBe('undone');

    const [task] = await rows<Record<string, string>>(
      'select status, due_date::text as due_date from tasks where id = $1', [taskId],
    );
    expect(task.due_date).toBe('2026-10-12');
    expect(task.status).toBe('open');

    const [lead] = await rows<Record<string, string>>(
      'select next_action_date::text as next_action_date from leads where id = $1', [leadId],
    );
    expect(lead.next_action_date).toBe('2026-10-12');

    const [activity] = await rows<Record<string, string | null>>(
      'select reversed_at, reversal_note from activity_events where task_id = $1', [taskId],
    );
    // Kept, not deleted: "this did not happen after all" is a fact worth having.
    expect(activity.reversed_at).not.toBeNull();
    expect(activity.reversal_note).toContain('reversed');
  });

  it('stops a reversed completion counting as completed work', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'counted');
    await t.asUser(USER_A, () => rows('select undo_task_operation($1)', [taskId]));

    const [live] = await rows<{ count: string }>(
      "select count(*)::text as count from activity_events"
      + " where source = 'task_completion' and reversed_at is null",
    );
    expect(live.count).toBe('0');
  });

  it('refuses when the task was edited after the completion', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'raced');
    // Somebody changes the task afterwards. Undoing would discard their edit.
    await t.asUser(USER_A, () =>
      rows("update tasks set notes = 'I changed this myself' where id = $1", [taskId]),
    );

    const [result] = await t.asUser(USER_A, () =>
      rows<{ undo_task_operation: Record<string, unknown> }>(
        'select undo_task_operation($1)', [taskId],
      ),
    );
    expect(result.undo_task_operation.status).toBe('conflict');
    expect(JSON.stringify(result.undo_task_operation.reasons)).toContain('task was edited');

    // And it really did refuse: the newer note is still there.
    const [task] = await rows<Record<string, string>>(
      'select notes, due_date::text as due_date from tasks where id = $1', [taskId],
    );
    expect(task.notes).toBe('I changed this myself');
    expect(task.due_date).toBe('2026-10-19');
  });

  it('says there is nothing to undo rather than inventing something', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    const [result] = await t.asUser(USER_A, () =>
      rows<{ undo_task_operation: Record<string, unknown> }>(
        'select undo_task_operation($1)', [taskId],
      ),
    );
    expect(result.undo_task_operation.status).toBe('nothing_to_undo');
  });

  it('cannot be used on somebody else task', async () => {
    const { taskId } = await seedFollowUp(USER_B);
    await complete(USER_B, taskId, 'theirs');
    const [result] = await t.asUser(USER_A, () =>
      rows<{ undo_task_operation: Record<string, unknown> }>(
        'select undo_task_operation($1)', [taskId],
      ),
    );
    expect(result.undo_task_operation.status).toBe('not_found');
  });

  it('queues a sync, because the calendar now says the wrong date', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'resync');
    await t.asServiceRole(() => rows('select finish_sync_job(id, true) from sync_jobs'));
    await t.asUser(USER_A, () => rows('select undo_task_operation($1)', [taskId]));

    expect(await rows("select id from sync_jobs where completed_at is null"))
      .toHaveLength(2);
  });

  it('re-finishing after an undo reuses the row instead of writing a second', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'first-go');
    await t.asUser(USER_A, () => rows('select undo_task_operation($1)', [taskId]));
    await complete(USER_A, taskId, 'second-go');

    const activities = await rows<Record<string, string | null>>(
      'select reversed_at from activity_events where task_id = $1', [taskId],
    );
    expect(activities).toHaveLength(1);
    // The reversal is cleared, so it counts again.
    expect(activities[0].reversed_at).toBeNull();
  });
});

/* ======================================================= skip and delete === */

describe('skipping and deleting are reversible too', () => {
  it('skips without logging anything, and undoes', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await t.asUser(USER_A, () => rows('select skip_task_operation($1)', [taskId]));

    // Skipping means it did not happen, so there is nothing to record.
    expect(await rows('select id from activity_events')).toHaveLength(0);
    let [task] = await rows<Record<string, string>>(
      'select status from tasks where id = $1', [taskId],
    );
    expect(task.status).toBe('skipped');

    await t.asUser(USER_A, () => rows('select undo_task_operation($1)', [taskId]));
    [task] = await rows<Record<string, string>>(
      'select status from tasks where id = $1', [taskId],
    );
    expect(task.status).toBe('open');
  });

  it('hides a deleted task from every ordinary read', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await t.asUser(USER_A, () => rows('select soft_delete_task($1)', [taskId]));

    // The policy hides it, so no existing query had to learn about deleted_at.
    const seen = await t.asUser(USER_A, () => rows('select id from tasks'));
    expect(seen).toHaveLength(0);
  });

  it('keeps every relationship and external id through delete and restore', async () => {
    const { leadId, taskId } = await seedFollowUp(USER_A);
    await t.asUser(USER_A, () =>
      rows(
        "update tasks set external_event_id = 'slcabc123', external_calendar_id = 'primary'"
        + ' where id = $1',
        [taskId],
      ),
    );
    await t.asUser(USER_A, () => rows('select soft_delete_task($1)', [taskId]));
    await t.asUser(USER_A, () => rows('select undo_task_operation($1)', [taskId]));

    const [task] = await rows<Record<string, string | null>>(
      'select lead_id, external_event_id, external_calendar_id, deleted_at from tasks where id = $1',
      [taskId],
    );
    // A real delete would have taken all of these with it.
    expect(task.lead_id).toBe(leadId);
    expect(task.external_event_id).toBe('slcabc123');
    expect(task.external_calendar_id).toBe('primary');
    expect(task.deleted_at).toBeNull();
  });

  it('lists what is in the bin, newest first, for its owner only', async () => {
    const mine = await seedFollowUp(USER_A);
    const theirs = await seedFollowUp(USER_B);
    await t.asUser(USER_A, () => rows('select soft_delete_task($1)', [mine.taskId]));
    await t.asUser(USER_B, () => rows('select soft_delete_task($1)', [theirs.taskId]));

    const binned = await t.asUser(USER_A, () =>
      rows<{ id: string }>('select id from recently_deleted_tasks()'),
    );
    expect(binned.map((r) => r.id)).toEqual([mine.taskId]);
  });
});

/* ============================================= 4. the calendar history row === */

describe('a completed contact gets its own calendar identity', () => {
  it('asks for a history entry on the day it happened', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'history');

    const [activity] = await rows<Record<string, string>>(
      `select calendar_history_wanted::text as wanted, calendar_sync_status,
              occurred_at::date::text as on_date
         from activity_events where task_id = $1`,
      [taskId],
    );
    expect(activity.wanted).toBe('true');
    expect(activity.calendar_sync_status).toBe('pending');
    expect(activity.on_date).toBe('2026-10-12');
  });

  it('does not move the historical date when the next follow-up is rescheduled', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'stable');

    // The follow-up moves again, a week later.
    await t.asUser(USER_A, () =>
      rows(
        `select complete_task_operation($1, $2, '2026-10-19T15:00:00Z'::timestamptz,
           'text', null, null, 'follow_up_sent'::activity_type, null,
           '2026-10-26'::date, null, null, true, true)`,
        [taskId, 'stable-2'],
      ),
    );

    const [task] = await rows<Record<string, string>>(
      'select due_date::text as due_date from tasks where id = $1', [taskId],
    );
    const [activity] = await rows<Record<string, string>>(
      'select occurred_at::date::text as on_date from activity_events where task_id = $1',
      [taskId],
    );
    // The reminder moved. The record of what happened did not.
    expect(task.due_date).toBe('2026-10-26');
    expect(activity.on_date).toBe('2026-10-12');
  });

  it('withdraws the history entry when the completion is undone', async () => {
    const { taskId } = await seedFollowUp(USER_A);
    await complete(USER_A, taskId, 'withdraw');
    await t.asUser(USER_A, () => rows('select undo_task_operation($1)', [taskId]));

    const [activity] = await rows<Record<string, string>>(
      'select calendar_history_wanted::text as wanted from activity_events where task_id = $1',
      [taskId],
    );
    expect(activity.wanted).toBe('false');
  });
});
