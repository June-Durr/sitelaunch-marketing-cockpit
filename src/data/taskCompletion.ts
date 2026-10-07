/**
 * Finishing a task, and the activity record it leaves behind.
 *
 * One implementation, used by every screen with a Done button, so the behaviour
 * cannot drift between Today and Tasks. Skipping a task deliberately creates
 * nothing: skipping means it did not happen.
 *
 * WHY A RECURRING FOLLOW-UP IS NOT MARKED DONE
 *
 * The first version of this did two contradictory things. It marked the task done
 * and then asked the follow-up rule what to do next, which moved that same task to
 * a new date without reopening it. The lead came out with a follow-up date in the
 * future and no open task to act on, so it vanished from the queue and the
 * calendar. Worse, the rule was handed the dataset as it was *before* the task was
 * marked done, so whether it found anything at all depended on how stale that copy
 * happened to be.
 *
 * Finishing a follow-up does not end it. It moves it on. So the order is: check
 * whether this was already recorded, write the one activity, then let the rule
 * decide, and only mark the task done when the rule is not going to reopen it.
 */

import type { Dataset, Task } from '../types/domain';
import type { DataContextValue } from './context';
import { activityFromTask, existingTaskActivity } from '../lib/activity';
import { recordContactIfRelevant, type FollowUpOutcome } from './leadFollowUp';

export interface CompletionResult {
  /** True when this call wrote a new activity record. */
  activityCreated: boolean;
  /** True when one already existed, so nothing at all was written a second time. */
  alreadyLogged: boolean;
  /** True when the task was closed rather than moved on to its next date. */
  markedDone: boolean;
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
 *
 * A second call writes nothing whatsoever. It does not re-mark the task, which is
 * what previously undid the reschedule the first call had just made.
 */
export async function completeTask(
  ctx: Pick<DataContextValue, 'insert' | 'update'>,
  data: Dataset,
  task: Task,
  now: string = new Date().toISOString(),
): Promise<CompletionResult> {
  if (existingTaskActivity(data.activityEvents, task.id)) {
    return {
      activityCreated: false,
      alreadyLogged: true,
      markedDone: false,
      followUp: null,
    };
  }

  const activity = activityFromTask(task, now);
  await ctx.insert('activity_events', activity);

  /**
   * Finishing a follow-up is contact, so the next one moves.
   *
   * This is what stops a chased lead sitting on the queue forever: the task the
   * rule already keeps is reopened on the next date rather than a second one
   * being created, and the lead's own follow-up date moves with it.
   */
  const followUp = await recordContactIfRelevant(ctx, data, {
    leadId: task.lead_id,
    activityType: activity.activity_type,
    occurredAt: now,
  });

  // The rule has just reopened this very task on a new date. Marking it done now
  // would close the thing that was reopened, which is the defect this guards.
  const reopened =
    followUp !== null &&
    followUp.plan.kind === 'reschedule' &&
    followUp.plan.taskId === task.id;

  if (!reopened) {
    await ctx.update('tasks', task.id, { status: 'done', completed_at: now });
  }

  return {
    activityCreated: true,
    alreadyLogged: false,
    markedDone: !reopened,
    followUp,
  };
}

/** Skip a task. Nothing happened, so nothing is logged. */
export async function skipTask(
  ctx: Pick<DataContextValue, 'update'>,
  task: Task,
  now: string = new Date().toISOString(),
): Promise<void> {
  await ctx.update('tasks', task.id, { status: 'skipped', completed_at: now });
}
