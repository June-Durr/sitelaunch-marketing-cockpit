/**
 * Turning calculated lead follow-up dates into actual tasks to do.
 *
 * src/config/followUp.ts decides *when* somebody should be chased. This decides
 * what that means for the task list: which leads should have a follow-up task,
 * what it should say, and what to do about the ones that already exist.
 *
 * Pure. In go leads and tasks, out comes a list of operations and the reason for
 * each. Nothing here writes, fetches or reads a clock it was not given, so the
 * whole thing is testable without a database, and the same plan can be printed
 * before it is applied.
 *
 * THE INVARIANT
 *
 * An eligible lead has exactly one follow-up task that the rule owns, and it
 * recurs. It is never duplicated, never deleted, and reopened rather than
 * replaced. supabase/migrations/0009_follow_up_tasks.sql enforces the "exactly
 * one" half of that with a unique index, and implements this same plan in SQL so
 * the server can run it without a browser. src/test/pg/followUpTasks.test.ts runs
 * both over the same fixtures and fails if they ever disagree.
 *
 * WHAT IT WILL NOT TOUCH
 *
 * Any task that is not a follow-up task belonging to a lead. Measurement checks,
 * publishing, marketing actions and admin tasks are somebody else's business, and
 * a reconciliation that edited them would be editing a plan it does not own.
 */

import type { CalendarSyncStatus, Lead, Task, TaskStatus } from '../types/domain';
import {
  followUpTaskEligibility, followUpTaskNotes, followUpTaskTitle, openFollowUpTask,
} from './followUp';

/**
 * What the notes say when there is nothing better to put in them.
 *
 * Fixed wording on purpose. A sentence that varied with the date or the run would
 * make every reconciliation look like a change, which would mark every task as
 * needing a calendar update, forever.
 */
export const NO_NEXT_ACTION_NOTE =
  'Kept by the follow-up rule. No next action has been recorded for this lead.';

export type FollowUpTaskAction = 'create' | 'update' | 'unchanged' | 'close';

/** The columns the rule owns on a follow-up task. */
export interface FollowUpTaskFields {
  title: string;
  notes: string;
  due_date: string;
  status: TaskStatus;
  completed_at: string | null;
  calendar_sync_status: CalendarSyncStatus;
  sync_error: string | null;
  follow_up_rule_managed: boolean;
}

export interface FollowUpTaskEntry {
  lead: Lead;
  action: FollowUpTaskAction;
  /** The task to change. Null only when creating. */
  taskId: string | null;
  /** What the task should look like. Null when closing. */
  fields: FollowUpTaskFields | null;
  /** Which of those fields actually differ from what is stored. */
  changed: string[];
  reason: string;
}

export interface ExcludedLead {
  lead: Lead;
  reason: string;
}

export interface FollowUpTaskPlan {
  entries: FollowUpTaskEntry[];
  /** Leads the rule deliberately keeps no task for, and why. */
  excluded: ExcludedLead[];
  eligible: number;
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  toClose: number;
  /** True by construction: nothing in this plan deletes anything. */
  nondestructive: boolean;
}

/** The task the rule owns for this lead, if it owns one. Never a manual task. */
export function managedFollowUpTask(
  tasks: readonly Task[],
  leadId: string,
): Task | null {
  return (
    tasks.find(
      (t) =>
        t.lead_id === leadId && t.task_type === 'follow_up' && t.follow_up_rule_managed,
    ) ?? null
  );
}

/**
 * The task this lead's follow-up should be written on.
 *
 * The rule's own task first. Failing that, a follow-up task somebody made by hand
 * and left open, which is adopted rather than duplicated: two open follow-ups for
 * one person is exactly the noise this whole module exists to prevent. Adoption
 * keeps their wording, because followUpTaskNotes prefers what is already there
 * over anything generated.
 */
export function adoptableFollowUpTask(
  tasks: readonly Task[],
  leadId: string,
): Task | null {
  return managedFollowUpTask(tasks, leadId) ?? openFollowUpTask(tasks, leadId);
}

/** What the rule wants this lead's follow-up task to say. */
export function desiredFollowUpTask(
  lead: Lead,
  existing: Task | null,
): FollowUpTaskFields {
  return {
    title: followUpTaskTitle(lead),
    notes: followUpTaskNotes(lead, existing?.notes ?? null, NO_NEXT_ACTION_NOTE),
    // Eligibility has already guaranteed this is not null.
    due_date: lead.next_action_date as string,
    status: 'open',
    completed_at: null,
    calendar_sync_status: 'pending',
    sync_error: null,
    follow_up_rule_managed: true,
  };
}

/**
 * Which of the owned columns differ from what is stored.
 *
 * calendar_sync_status and sync_error are deliberately not compared. They are
 * consequences of a change rather than part of what the rule wants, so comparing
 * them would make a task that is merely waiting to be synced look like a task
 * that needs changing, and every run would mark everything pending again.
 */
export function followUpTaskChanges(
  existing: Task,
  desired: FollowUpTaskFields,
): string[] {
  const changed: string[] = [];
  if (existing.title !== desired.title) changed.push('title');
  if ((existing.notes ?? null) !== desired.notes) changed.push('notes');
  if (existing.due_date !== desired.due_date) changed.push('due_date');
  if (existing.status !== desired.status) changed.push('status');
  if (existing.completed_at !== null) changed.push('completed_at');
  if (existing.follow_up_rule_managed !== true) changed.push('follow_up_rule_managed');
  return changed;
}

/**
 * Decide what the task list should become, without changing anything.
 *
 * Four outcomes, and a lead lands in exactly one:
 *
 *   create     Eligible, and the rule keeps no task for them yet.
 *   update     Eligible, and the task it keeps says the wrong thing. Reopened and
 *              moved in place, which is what makes the follow-up recurring rather
 *              than a trail of finished tasks.
 *   unchanged  Eligible and already correct. Nothing is written, so a task that
 *              is already on the calendar stays synced.
 *   close      Not eligible any more, but the rule's task is still open. Marked
 *              skipped, because the decision was not to chase them. Never
 *              deleted, and never applied to a task somebody made by hand.
 */
export function planFollowUpTasks(
  leads: readonly Lead[],
  tasks: readonly Task[],
): FollowUpTaskPlan {
  const entries: FollowUpTaskEntry[] = [];
  const excluded: ExcludedLead[] = [];

  for (const lead of leads) {
    const eligibility = followUpTaskEligibility(lead);

    if (!eligibility.eligible) {
      excluded.push({ lead, reason: eligibility.reason });

      // Only the rule's own task is ever closed. An open follow-up somebody made
      // by hand for a lead the rule has stopped chasing is their decision.
      const owned = managedFollowUpTask(tasks, lead.id);
      if (owned && owned.status === 'open') {
        entries.push({
          lead,
          action: 'close',
          taskId: owned.id,
          fields: null,
          changed: ['status'],
          reason: `${eligibility.reason} The follow-up the rule was keeping is marked skipped rather than deleted, so the history of it stays.`,
        });
      }
      continue;
    }

    const existing = adoptableFollowUpTask(tasks, lead.id);
    const desired = desiredFollowUpTask(lead, existing);

    if (!existing) {
      entries.push({
        lead,
        action: 'create',
        taskId: null,
        fields: desired,
        changed: [],
        reason: `Due ${desired.due_date}, from this lead's own follow-up date.`,
      });
      continue;
    }

    const changed = followUpTaskChanges(existing, desired);
    entries.push({
      lead,
      action: changed.length === 0 ? 'unchanged' : 'update',
      taskId: existing.id,
      fields: desired,
      changed,
      reason:
        changed.length === 0
          ? 'Already says the right thing.'
          : `Moved to ${desired.due_date}: ${changed.join(', ')}.`,
    });
  }

  const count = (action: FollowUpTaskAction) =>
    entries.filter((e) => e.action === action).length;

  return {
    entries,
    excluded,
    eligible: leads.filter((l) => followUpTaskEligibility(l).eligible).length,
    toCreate: count('create'),
    toUpdate: count('update'),
    unchanged: count('unchanged'),
    toClose: count('close'),
    // There is no delete anywhere in this module, and closing is a status change.
    nondestructive: true,
  };
}

/** The counts, flat, for storing against a run and showing on a screen. */
export function followUpTaskCounts(plan: FollowUpTaskPlan): Record<string, number> {
  return {
    // Every lead considered: one entry each for the eligible, one excluded
    // record each for the rest. A close entry belongs to an excluded lead and
    // must not be counted twice.
    leadsRead: plan.eligible + plan.excluded.length,
    eligibleLeads: plan.eligible,
    excludedLeads: plan.excluded.length,
    tasksToCreate: plan.toCreate,
    tasksToUpdate: plan.toUpdate,
    tasksUnchanged: plan.unchanged,
    tasksToClose: plan.toClose,
  };
}
