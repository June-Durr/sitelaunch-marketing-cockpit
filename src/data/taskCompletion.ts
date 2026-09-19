/**
 * Finishing a task, and the activity record it leaves behind.
 *
 * One implementation, used by every screen with a Done button, so the behaviour
 * cannot drift between Today and Tasks. Skipping a task deliberately creates
 * nothing: skipping means it did not happen.
 */

import type { Dataset, Task } from '../types/domain';
import type { DataContextValue } from './context';
import { activityFromTask, existingTaskActivity } from '../lib/activity';

export interface CompletionResult {
  /** True when this call wrote a new activity record. */
  activityCreated: boolean;
  /** True when one already existed, so nothing was written a second time. */
  alreadyLogged: boolean;
}

/**
 * Mark a task done and log that it happened.
 *
 * Deduplicated on the task id, so finishing a task twice, or reopening it and
 * finishing it again, still leaves exactly one automatic activity record. The
 * existing record keeps its original timestamp rather than being moved, because
 * the first completion is when the work actually happened.
 */
export async function completeTask(
  ctx: Pick<DataContextValue, 'insert' | 'update'>,
  data: Dataset,
  task: Task,
  now: string = new Date().toISOString(),
): Promise<CompletionResult> {
  await ctx.update('tasks', task.id, { status: 'done', completed_at: now });

  if (existingTaskActivity(data.activityEvents, task.id)) {
    return { activityCreated: false, alreadyLogged: true };
  }

  await ctx.insert('activity_events', activityFromTask(task, now));
  return { activityCreated: true, alreadyLogged: false };
}

/** Skip a task. Nothing happened, so nothing is logged. */
export async function skipTask(
  ctx: Pick<DataContextValue, 'update'>,
  task: Task,
  now: string = new Date().toISOString(),
): Promise<void> {
  await ctx.update('tasks', task.id, { status: 'skipped', completed_at: now });
}
