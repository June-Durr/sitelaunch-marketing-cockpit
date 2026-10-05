/**
 * What happens to a lead's next action when you record contact with them.
 *
 * One implementation, used by every path that can log a touch: the Activity
 * screen's form, finishing a task with a lead attached, and whatever logs a touch
 * next. The behaviour cannot drift between them because there is only one of it.
 *
 * WHY THIS IS NOT IN THE FORM
 *
 * The long-term shape of this product is conversational: somebody says "I emailed
 * Taylor today" and a server-side tool call records the touch, moves the follow-up
 * and reschedules the calendar item from that one sentence. That only works if
 * "record a touch" is a function rather than a side effect of a particular screen's
 * submit handler. This is that function, on the client for now.
 *
 * THE RULE ITSELF IS NOT HERE
 *
 * src/config/followUp.ts decides what should happen. This decides how to carry it
 * out. Keeping them apart is what lets the cadence be argued about and changed
 * without touching anything that writes to a database.
 */

import type { ActivityType, Dataset, Lead } from '../types/domain';
import type { DataContextValue } from './context';
import { NON_TOUCH_ACTIVITY, planNextAction, type NextActionPlan } from '../config/followUp';
import { blankCalendarSync } from './factories';
import { dayOf } from '../lib/dates';

/** Does logging this activity type against a lead count as contact with them? */
export function countsAsContact(activityType: ActivityType): boolean {
  return !NON_TOUCH_ACTIVITY.includes(activityType);
}

export interface FollowUpOutcome {
  plan: NextActionPlan;
  /** True when a follow-up task was written or moved. */
  taskChanged: boolean;
  /** True when the lead's own next-action date moved. */
  leadChanged: boolean;
}

/**
 * Move a lead's follow-up on, after contact with them on a given day.
 *
 * Does three things at most, and says which of them it did:
 *
 *   1. Creates one open follow-up task, or moves the one that is already open.
 *      Never a second. The task table enforces this too, with a partial unique
 *      index, so a bug here cannot produce a duplicate.
 *   2. Sets the lead's next follow-up date to match.
 *   3. Fills in the lead's next action text, but only when it is empty. If
 *      somebody wrote what they intend to do next, that is better than anything
 *      this function would generate, and it is not overwritten.
 *
 * Deliberate decisions are respected: a lead on hold, archived, set to no
 * follow-up, or already won or lost gets nothing scheduled, and planNextAction
 * says why in a sentence the screen can show.
 */
export async function recordContact(
  ctx: Pick<DataContextValue, 'insert' | 'update'>,
  data: Dataset,
  lead: Lead,
  occurredAt: string,
): Promise<FollowUpOutcome> {
  // dayOf, not toDayString: a caller may hand this a timestamp or a bare day,
  // and running a bare day through a timezone would move it backwards.
  const touchDay = dayOf(occurredAt);
  const plan = planNextAction(lead, data.tasks, touchDay);

  if (plan.kind === 'none' || plan.dueDate === null) {
    return { plan, taskChanged: false, leadChanged: false };
  }

  if (plan.kind === 'create') {
    await ctx.insert('tasks', {
      content_item_id: null,
      lead_id: lead.id,
      title: plan.title ?? `Follow up with ${lead.prospect_name}`,
      task_type: 'follow_up',
      status: 'open',
      due_date: plan.dueDate,
      window_type: null,
      notes: plan.reason,
      completed_at: null,
      ...blankCalendarSync(),
      is_seed: false,
    });
  } else {
    await ctx.update('tasks', plan.taskId as string, {
      due_date: plan.dueDate,
      notes: plan.reason,
    });
  }

  await ctx.update('leads', lead.id, {
    next_action_date: plan.dueDate,
    // Only when there is nothing there. Somebody's own words beat a generated line.
    ...(lead.next_action === null ? { next_action: plan.title } : {}),
  });

  return { plan, taskChanged: true, leadChanged: true };
}

/**
 * Record contact only if this activity is contact, and only if it names a person.
 *
 * The convenience wrapper every caller actually wants. An activity with no lead
 * attached, or one that is definitionally not contact such as checking the
 * analytics, changes nobody's follow-up and returns null.
 */
export async function recordContactIfRelevant(
  ctx: Pick<DataContextValue, 'insert' | 'update'>,
  data: Dataset,
  input: { leadId: string | null; activityType: ActivityType; occurredAt: string },
): Promise<FollowUpOutcome | null> {
  if (input.leadId === null) return null;
  if (!countsAsContact(input.activityType)) return null;

  const lead = data.leads.find((l) => l.id === input.leadId);
  if (!lead) return null;

  return recordContact(ctx, data, lead, input.occurredAt);
}
