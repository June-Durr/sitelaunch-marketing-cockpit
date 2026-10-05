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
import { recordContactIfRelevant, type FollowUpOutcome } from './leadFollowUp';

export interface CompletionResult {
  /** True when this call wrote a new activity record. */
  activityCreated: boolean;
  /** True when one already existed, so nothing was written a second time. */
  alreadyLogged: boolean;
  /**
   * What the follow-up rule did about the lead, when the task named one.
   *
   * Null when the task was not about a person, or when finishing it does not
   * count as contact. Carries the reason either way, so a screen can say what
   * happened rather than silently moving a date.
   */
  followUp: FollowUpOutcome | null;
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
    return { activityCreated: false, alreadyLogged: true, followUp: null };
  }

  const activity = activityFromTask(task, now);
  await ctx.insert('activity_events', activity);

  /**
   * Finishing a follow-up is contact, so the next one moves.
   *
   * This is what stops a chased lead sitting on the Today screen forever: the
   * task that was open is reused rather than a second one being created, and the
   * lead's own follow-up date moves with it.
   */
  const followUp = await recordContactIfRelevant(ctx, data, {
    leadId: task.lead_id,
    activityType: activity.activity_type,
    occurredAt: now,
  });

  return { activityCreated: true, alreadyLogged: false, followUp };
}

/** Skip a task. Nothing happened, so nothing is logged. */
export async function skipTask(
  ctx: Pick<DataContextValue, 'update'>,
  task: Task,
  now: string = new Date().toISOString(),
): Promise<void> {
  await ctx.update('tasks', task.id, { status: 'skipped', completed_at: now });
}
