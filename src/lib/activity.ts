/**
 * Activity helpers.
 *
 * Tasks and activity answer different questions. A task says "I mean to do this".
 * An activity says "this happened". The app never turns one into the other behind
 * your back, and it never invents activity from old records: if nobody wrote it
 * down at the time, the honest answer is that we do not know what happened.
 *
 * The one automatic bridge is finishing a task, which can leave an activity record
 * behind. That bridge is deduplicated here, so ticking a task off twice, or ticking
 * it, reopening it and ticking it again, still leaves exactly one record.
 */

import type {
  ActivityEvent, ActivityType, Dataset, Task, TaskType,
} from '../types/domain';
import { MEANINGFUL_ACTIVITY } from '../types/domain';
import { blankCalendarSync } from '../data/factories';

/** What kind of activity finishing a given task represents. */
export const TASK_TO_ACTIVITY: Record<TaskType, ActivityType> = {
  publish: 'content_published',
  follow_up: 'follow_up_sent',
  measurement_check: 'analytics_check',
  marketing_action: 'other',
  admin: 'other',
};

/** The activity record that finishing this task would leave behind. */
export function activityFromTask(
  task: Task,
  completedAt: string = new Date().toISOString(),
): Omit<ActivityEvent, 'id' | 'created_at' | 'updated_at'> {
  return {
    occurred_at: completedAt,
    activity_type: TASK_TO_ACTIVITY[task.task_type],
    title: task.title,
    details: task.notes,
    source: 'task_completion',
    external_id: null,
    content_item_id: task.content_item_id,
    lead_id: task.lead_id,
    task_id: task.id,
    ...blankCalendarSync(),
    is_seed: false,
  };
}

/**
 * The activity already logged for finishing this task, if there is one.
 *
 * Matching is on task_id plus the task_completion source. A hand written activity
 * that happens to mention the same task does not count, because deleting the
 * automatic one should never take somebody's own note with it.
 */
export function existingTaskActivity(
  activityEvents: ActivityEvent[],
  taskId: string,
): ActivityEvent | null {
  return (
    activityEvents.find(
      (a) => a.task_id === taskId && a.source === 'task_completion',
    ) ?? null
  );
}

/** Would finishing this task create a new record, or has one already been logged? */
export function needsTaskActivity(data: Dataset, taskId: string): boolean {
  return existingTaskActivity(data.activityEvents, taskId) === null;
}

/** Most recent activity first. */
export function sortActivity(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

/**
 * Recent activity worth putting on the Today screen.
 *
 * Filtered to the types that represent real movement, so the summary does not fill
 * up with routine number checking while an enquiry scrolls off the bottom.
 */
export function recentMeaningfulActivity(
  data: Dataset,
  limit = 5,
  now: string = new Date().toISOString(),
): ActivityEvent[] {
  return sortActivity(
    data.activityEvents.filter(
      (a) =>
        a.occurred_at <= now && MEANINGFUL_ACTIVITY.includes(a.activity_type),
    ),
  ).slice(0, limit);
}

/** Activity inside a date range, both ends included. Dates are YYYY-MM-DD. */
export function activityInRange(
  events: ActivityEvent[],
  start: string,
  end: string,
): ActivityEvent[] {
  return events.filter((a) => {
    const day = a.occurred_at.slice(0, 10);
    return day >= start && day <= end;
  });
}
