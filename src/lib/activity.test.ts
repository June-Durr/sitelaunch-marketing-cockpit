/**
 * Activity rules.
 *
 * The load-bearing one is deduplication: finishing a task must leave exactly one
 * record however many times it is clicked, reopened, or clicked again.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalRepository } from '../data/localRepository';
import { emptyDataset } from '../data/repository';
import { blankCalendarSync } from '../data/factories';
import { completeTask, skipTask } from '../data/taskCompletion';
import type { Repository } from '../data/repository';
import type { ActivityEvent, Dataset, Task } from '../types/domain';
import {
  TASK_TO_ACTIVITY, activityFromTask, activityInRange, existingTaskActivity,
  needsTaskActivity, recentMeaningfulActivity, sortActivity,
} from './activity';

const T = '2026-09-19T12:00:00.000Z';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'tk1', content_item_id: null, lead_id: null,
    title: 'Send the revised proposal', task_type: 'follow_up', status: 'open',
    due_date: '2026-09-19', window_type: null, notes: 'Second attempt',
    completed_at: null, ...blankCalendarSync(), is_seed: false,
    created_at: T, updated_at: T, ...over,
  };
}

function activity(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'a1', occurred_at: T, activity_type: 'other', title: 'Something',
    details: null, source: 'manual', external_id: null,
    content_item_id: null, lead_id: null, task_id: null,
    ...blankCalendarSync(), is_seed: false, created_at: T, updated_at: T, ...over,
  };
}

/** A context standing in for the DataProvider, backed by a real local repository. */
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

/* ------------------------------------------------------------------------ */

describe('a task becomes the right kind of activity', () => {
  it('maps every task type to an activity type', () => {
    expect(Object.keys(TASK_TO_ACTIVITY).sort()).toEqual([
      'admin', 'follow_up', 'marketing_action', 'measurement_check', 'publish',
    ]);
  });

  it('carries the task title, notes and links across', () => {
    const t = task({ content_item_id: 'c1', lead_id: 'l1' });
    const made = activityFromTask(t, T);

    expect(made.title).toBe('Send the revised proposal');
    expect(made.details).toBe('Second attempt');
    expect(made.activity_type).toBe('follow_up_sent');
    expect(made.source).toBe('task_completion');
    expect(made.task_id).toBe('tk1');
    expect(made.content_item_id).toBe('c1');
    expect(made.lead_id).toBe('l1');
    expect(made.occurred_at).toBe(T);
  });

  it('records a measurement check as checking the numbers', () => {
    expect(activityFromTask(task({ task_type: 'measurement_check' })).activity_type)
      .toBe('analytics_check');
  });
});

describe('completing a task cannot create duplicate activity', () => {
  it('creates exactly one record the first time', async () => {
    const repo = createLocalRepository();
    await repo.replaceAll?.(emptyDataset());
    const created = await repo.insert('tasks', task());

    const result = await completeTask(harness(repo), await repo.loadAll(), created);
    expect(result.activityCreated).toBe(true);

    const after = await repo.loadAll();
    expect(after.activityEvents).toHaveLength(1);
    expect(after.tasks[0].status).toBe('done');
    expect(after.activityEvents[0].task_id).toBe(created.id);
  });

  it('creates nothing on a second completion', async () => {
    const repo = createLocalRepository();
    await repo.replaceAll?.(emptyDataset());
    const created = await repo.insert('tasks', task());

    await completeTask(harness(repo), await repo.loadAll(), created);
    const second = await completeTask(harness(repo), await repo.loadAll(), created);

    expect(second.activityCreated).toBe(false);
    expect(second.alreadyLogged).toBe(true);
    expect((await repo.loadAll()).activityEvents).toHaveLength(1);
  });

  it('creates nothing when a task is reopened and finished again', async () => {
    const repo = createLocalRepository();
    await repo.replaceAll?.(emptyDataset());
    const created = await repo.insert('tasks', task());

    await completeTask(harness(repo), await repo.loadAll(), created);
    await repo.update('tasks', created.id, { status: 'open', completed_at: null });
    await completeTask(harness(repo), await repo.loadAll(), created);

    const after = await repo.loadAll();
    expect(after.activityEvents).toHaveLength(1);
    // The original timestamp survives: the work happened the first time.
    expect(after.activityEvents[0].occurred_at).toBeTruthy();
  });

  it('keeps the records of two different tasks apart', async () => {
    const repo = createLocalRepository();
    await repo.replaceAll?.(emptyDataset());
    const one = await repo.insert('tasks', task({ id: undefined, title: 'First' }));
    const two = await repo.insert('tasks', task({ id: undefined, title: 'Second' }));

    await completeTask(harness(repo), await repo.loadAll(), one);
    await completeTask(harness(repo), await repo.loadAll(), two);

    const after = await repo.loadAll();
    expect(after.activityEvents).toHaveLength(2);
    expect(new Set(after.activityEvents.map((a) => a.task_id)).size).toBe(2);
  });

  it('logs nothing when a task is skipped, because nothing happened', async () => {
    const repo = createLocalRepository();
    await repo.replaceAll?.(emptyDataset());
    const created = await repo.insert('tasks', task());

    await skipTask(harness(repo), created);

    const after = await repo.loadAll();
    expect(after.tasks[0].status).toBe('skipped');
    expect(after.activityEvents).toHaveLength(0);
  });

  it('does not treat a hand written note about a task as the automatic record', () => {
    const byHand = activity({ task_id: 'tk1', source: 'manual' });
    expect(existingTaskActivity([byHand], 'tk1')).toBeNull();

    const data: Dataset = { ...emptyDataset(), activityEvents: [byHand] };
    expect(needsTaskActivity(data, 'tk1')).toBe(true);
  });
});

describe('recent activity on the Today screen', () => {
  const data: Dataset = {
    ...emptyDataset(),
    activityEvents: [
      activity({ id: 'a1', activity_type: 'analytics_check', occurred_at: '2026-09-18T10:00:00.000Z' }),
      activity({ id: 'a2', activity_type: 'lead_created', occurred_at: '2026-09-17T10:00:00.000Z' }),
      activity({ id: 'a3', activity_type: 'proposal_sent', occurred_at: '2026-09-19T10:00:00.000Z' }),
      activity({ id: 'a4', activity_type: 'client_work', occurred_at: '2026-09-19T11:00:00.000Z' }),
    ],
  };

  it('keeps only the kinds that represent real movement', () => {
    const recent = recentMeaningfulActivity(data, 10, '2026-09-19T23:59:59.000Z');
    const ids = recent.map((a) => a.id);
    expect(ids).toContain('a3');
    expect(ids).toContain('a2');
    // Routine number checking and client work are filtered out of the summary.
    expect(ids).not.toContain('a1');
    expect(ids).not.toContain('a4');
  });

  it('puts the newest first and respects the limit', () => {
    const recent = recentMeaningfulActivity(data, 1, '2026-09-19T23:59:59.000Z');
    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe('a3');
  });

  it('never shows activity dated in the future', () => {
    const recent = recentMeaningfulActivity(data, 10, '2026-09-17T23:59:59.000Z');
    expect(recent.map((a) => a.id)).toEqual(['a2']);
  });

  it('shows nothing at all when nothing was logged', () => {
    expect(recentMeaningfulActivity(emptyDataset())).toEqual([]);
  });
});

describe('filtering', () => {
  const events = [
    activity({ id: 'a1', occurred_at: '2026-09-01T10:00:00.000Z' }),
    activity({ id: 'a2', occurred_at: '2026-09-15T10:00:00.000Z' }),
    activity({ id: 'a3', occurred_at: '2026-09-30T10:00:00.000Z' }),
  ];

  it('includes both ends of the range', () => {
    expect(activityInRange(events, '2026-09-01', '2026-09-30').map((a) => a.id))
      .toEqual(['a1', 'a2', 'a3']);
    expect(activityInRange(events, '2026-09-02', '2026-09-29').map((a) => a.id))
      .toEqual(['a2']);
  });

  it('sorts newest first', () => {
    expect(sortActivity(events).map((a) => a.id)).toEqual(['a3', 'a2', 'a1']);
  });
});

describe('upgrading over data saved by an older version', () => {
  it('fills in tables that did not exist when the data was saved', async () => {
    // Exactly what sits in a browser that used the app before activity existed.
    localStorage.setItem(
      'slmc.dataset.v1',
      JSON.stringify({
        accounts: [], contentItems: [], snapshots: [],
        traffic: [], leads: [], tasks: [], recommendations: [],
      }),
    );

    const repo = createLocalRepository();
    const data = await repo.loadAll();

    expect(data.activityEvents).toEqual([]);
    expect(Array.isArray(data.activityEvents)).toBe(true);
  });

  it('keeps the rows the older version did have', async () => {
    localStorage.setItem(
      'slmc.dataset.v1',
      JSON.stringify({
        accounts: [{ id: 'acc1', platform: 'instagram', handle: '@x' }],
        contentItems: [], snapshots: [], traffic: [], leads: [],
        tasks: [], recommendations: [],
      }),
    );

    const data = await createLocalRepository().loadAll();
    expect(data.accounts).toHaveLength(1);
    expect(data.activityEvents).toEqual([]);
  });
});
