/**
 * Follow-up rules: the one place day arithmetic about relationships happens.
 *
 * Pipeline, Today, the task scheduler and the Google Sheet mirror all read their
 * numbers from here. Nothing else in the app subtracts dates to decide whether
 * somebody is overdue, because the same question answered in four places
 * eventually gets four answers.
 *
 * WHAT IS A RULE AND WHAT IS A FACT
 *
 * A fact is that somebody was contacted on a particular day. That comes from the
 * activity log and is never invented. A rule is how long is reasonable to leave
 * them after that, which is a judgement, written down once below so it can be
 * argued with and changed in one edit.
 *
 * THE SQL TWIN
 *
 * supabase/migrations/0007_lead_mirror.sql implements the same derivation as
 * lead_follow_up_state(as_of), because the Sheet mirror is written by a server
 * function with no browser involved and future recommendations are meant to read
 * authoritative database state rather than recompute from a spreadsheet.
 * src/test/pg/followUp.test.ts runs both over the same fixtures and fails if they
 * ever disagree, so the duplication is checked rather than trusted.
 *
 * NO AI HERE
 *
 * Every value this module produces is arithmetic on recorded dates. A written
 * suggestion about what to say to somebody can come later; this has to be right
 * first, and it has to be right without a model in the path.
 */

import type {
  ActivityEvent, ActivityType, FollowUpMode, Lead, LeadStage, Task,
} from '../types/domain';
import { addDays, daysBetween } from '../lib/dates';

export const FOLLOW_UP_MODE_LABELS: Record<FollowUpMode, string> = {
  auto: 'Follow up on the usual rhythm',
  none: 'No follow-up planned, on purpose',
  hold: 'On hold, waiting on them',
  archived: 'Archived, kept for history',
};

/** What the follow-up state of a lead can be. Ordered worst-first for sorting. */
export type FollowUpStatus =
  | 'overdue' | 'due_today' | 'due_soon' | 'scheduled'
  | 'not_scheduled' | 'on_hold' | 'archived' | 'closed';

export const FOLLOW_UP_STATUS_LABELS: Record<FollowUpStatus, string> = {
  overdue: 'Overdue',
  due_today: 'Due today',
  due_soon: 'Due soon',
  scheduled: 'Scheduled',
  not_scheduled: 'Not scheduled',
  on_hold: 'On hold',
  archived: 'Archived',
  closed: 'Closed',
};

/**
 * The same states as the Google Sheet mirror has always spelled them.
 *
 * The mirror's Follow-up status column existed before this module did, and people
 * read it. Its wording is preserved exactly rather than quietly restyled, with
 * the states the Sheet had no word for added in the same voice.
 */
export const FOLLOW_UP_STATUS_SHEET_LABELS: Record<FollowUpStatus, string> = {
  overdue: 'OVERDUE',
  due_today: 'DUE TODAY',
  due_soon: 'DUE SOON',
  scheduled: 'SCHEDULED',
  not_scheduled: 'NOT SCHEDULED',
  on_hold: 'ON HOLD',
  archived: 'ARCHIVED',
  closed: 'CLOSED',
};

/** Worst first, for putting a pipeline in the order it should be worked. */
export const FOLLOW_UP_STATUS_ORDER: FollowUpStatus[] = [
  'overdue', 'due_today', 'due_soon', 'scheduled',
  'not_scheduled', 'on_hold', 'archived', 'closed',
];

/** The statuses that mean somebody is waiting on you right now. */
export const NEEDS_ACTION_STATUSES: FollowUpStatus[] = ['overdue', 'due_today'];

/**
 * How many days before a follow-up date it starts reading as "due soon".
 *
 * Three. Long enough to plan the day around, short enough that a list of "due
 * soon" leads is still a list of things to actually do this week. Kept in step
 * with the literal in lead_follow_up_state by src/test/pg/followUp.test.ts.
 */
export const DUE_SOON_DAYS = 3;

/**
 * The colour each status earns, using the four tones the app already has.
 *
 * Overdue is the only crimson: if everything is a warning then nothing is. Due
 * today and due soon are amber, anything scheduled is violet, and the deliberate
 * states are quiet, because a lead on hold is not a problem to be solved.
 */
export const FOLLOW_UP_STATUS_TONES: Record<
  FollowUpStatus,
  'violet' | 'amber' | 'crimson' | 'quiet'
> = {
  overdue: 'crimson',
  due_today: 'amber',
  due_soon: 'amber',
  scheduled: 'violet',
  not_scheduled: 'quiet',
  on_hold: 'quiet',
  archived: 'quiet',
  closed: 'quiet',
};

/** One line explaining each status, for a tooltip rather than a manual. */
export const FOLLOW_UP_STATUS_EXPLANATIONS: Record<FollowUpStatus, string> = {
  overdue: 'The follow-up date has passed and nothing has been logged since.',
  due_today: 'The follow-up is today.',
  due_soon: `The follow-up is within ${DUE_SOON_DAYS} days.`,
  scheduled: 'A follow-up date is set and it is further out than a few days.',
  not_scheduled: 'No follow-up date. Either nothing was set, or none is wanted.',
  on_hold: 'Paused on purpose, waiting on them. Not chased, not forgotten.',
  archived: 'Archived on purpose, kept for history.',
  closed: 'Won or lost. There is nothing left to chase.',
};

/**
 * How long a lead at each stage can reasonably be left before the next contact.
 *
 * These are judgements, not measurements, and they are deliberately boring:
 *
 *   new_contact     30  Somebody met once. Monthly is friendly; weekly is odd.
 *   follow_up        7  An open thread. A week is long enough to not pester and
 *                       short enough that the conversation is still warm.
 *   qualified        7  Same thread, more at stake.
 *   call_scheduled   3  A call is imminent or just happened. Days, not weeks.
 *   proposal         5  Money is on the table. Leaving it a fortnight reads as
 *                       indifference, chasing daily reads as desperation.
 *   waiting         14  They owe you something. Chasing weekly for a thing you
 *                       asked for is nagging.
 *   won            null Nothing to chase. Upsells are a new decision, not a rule.
 *   lost           null Nothing to chase.
 *
 * null means the rule declines to schedule anything, which is different from
 * scheduling zero days away.
 */
export const FOLLOW_UP_CADENCE_DAYS: Record<LeadStage, number | null> = {
  new_contact: 30,
  follow_up: 7,
  qualified: 7,
  call_scheduled: 3,
  proposal: 5,
  waiting: 14,
  won: null,
  lost: null,
};

/**
 * Activity types that are not contact with a person.
 *
 * A deny-list on purpose. An activity label this app has never seen is far more
 * likely to be a conversation than not, and treating an unknown touch as no touch
 * would overstate how long somebody has been left waiting, which is the one error
 * this whole module exists to prevent.
 *
 * Mirrors the exclusion list in lead_follow_up_state.
 */
export const NON_TOUCH_ACTIVITY: ActivityType[] = [
  'content_published', 'website_update', 'analytics_check',
  'revenue_received', 'unavailable', 'client_work', 'decision',
];

/** Does this activity count as having been in touch with the person? */
export function isTouch(event: ActivityEvent): boolean {
  return event.lead_id !== null && !NON_TOUCH_ACTIVITY.includes(event.activity_type);
}

/** Where a last-touch date came from. Always reported, never implied. */
export type LastTouchBasis = 'activity' | 'reported' | 'none';

export interface LastTouch {
  /** The newest confirmed contact activity, or null when there is none. */
  at: string | null;
  /** The day of that activity. */
  on: string | null;
  /** Confirmed activity if any exists, otherwise whatever the source asserted. */
  effectiveOn: string | null;
  basis: LastTouchBasis;
  /** How many contact activities are on file for this lead. */
  count: number;
}

export const LAST_TOUCH_BASIS_LABELS: Record<LastTouchBasis, string> = {
  activity: 'From a logged activity',
  reported: 'Reported in the imported mirror, with no activity record behind it',
  none: 'Never recorded',
};

/**
 * The newest confirmed touch for a lead, and what it rests on.
 *
 * Confirmed activity always wins. Only when there is none does the date a source
 * asserted get used, and the basis says so, so a screen can show the difference
 * rather than presenting a spreadsheet's claim as a logged event.
 *
 * Dates are compared as ISO strings, which sorts correctly, and the day is taken
 * from the first ten UTC characters. Date-only imports are stored at noon UTC
 * precisely so that this and the SQL twin pick the same calendar day.
 */
export function deriveLastTouch(lead: Lead, events: readonly ActivityEvent[]): LastTouch {
  let newest: string | null = null;
  let count = 0;

  for (const event of events) {
    if (event.lead_id !== lead.id || !isTouch(event)) continue;
    count += 1;
    if (newest === null || event.occurred_at > newest) newest = event.occurred_at;
  }

  const on = newest === null ? null : newest.slice(0, 10);
  const reported = lead.reported_last_touch_at;

  return {
    at: newest,
    on,
    effectiveOn: on ?? reported ?? null,
    basis: on !== null ? 'activity' : reported !== null ? 'reported' : 'none',
    count,
  };
}

/** Whole days from the last touch to `asOf`. Null when there has never been one. */
export function daysSinceTouch(lastTouchOn: string | null, asOf: string): number | null {
  return lastTouchOn === null ? null : daysBetween(lastTouchOn, asOf);
}

/**
 * Where a lead stands on following up, as at a given day.
 *
 * Explicit intent is checked before any arithmetic: a decision to archive, to
 * hold, or to deliberately plan nothing is a fact about what the operator wants,
 * and no date subtraction should be able to override it.
 */
export function followUpStatus(lead: Lead, asOf: string): FollowUpStatus {
  if (lead.follow_up_mode === 'archived') return 'archived';
  if (lead.stage === 'won' || lead.stage === 'lost') return 'closed';
  if (lead.follow_up_mode === 'hold') return 'on_hold';
  if (lead.follow_up_mode === 'none') return 'not_scheduled';

  const due = lead.next_action_date;
  if (due === null) return 'not_scheduled';

  const diff = daysBetween(asOf, due);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'due_today';
  if (diff <= DUE_SOON_DAYS) return 'due_soon';
  return 'scheduled';
}

/** Everything a screen needs to say about one lead's follow-up, in one object. */
export interface FollowUpState {
  lead: Lead;
  lastTouch: LastTouch;
  daysSince: number | null;
  nextFollowUp: string | null;
  status: FollowUpStatus;
}

export function followUpState(
  lead: Lead,
  events: readonly ActivityEvent[],
  asOf: string,
): FollowUpState {
  const lastTouch = deriveLastTouch(lead, events);
  return {
    lead,
    lastTouch,
    daysSince: daysSinceTouch(lastTouch.effectiveOn, asOf),
    nextFollowUp: lead.next_action_date,
    status: followUpStatus(lead, asOf),
  };
}

/** Every lead's follow-up state, worst first then soonest first. */
export function followUpStates(
  leads: readonly Lead[],
  events: readonly ActivityEvent[],
  asOf: string,
): FollowUpState[] {
  return leads
    .map((lead) => followUpState(lead, events, asOf))
    .sort((a, b) => {
      const byStatus =
        FOLLOW_UP_STATUS_ORDER.indexOf(a.status) - FOLLOW_UP_STATUS_ORDER.indexOf(b.status);
      if (byStatus !== 0) return byStatus;
      // Within a status, whoever has waited longest comes first.
      return (b.daysSince ?? -1) - (a.daysSince ?? -1);
    });
}

/** Leads that need something done about them today. */
export function needsActionToday(
  leads: readonly Lead[],
  events: readonly ActivityEvent[],
  asOf: string,
): FollowUpState[] {
  return followUpStates(leads, events, asOf).filter((s) =>
    NEEDS_ACTION_STATUSES.includes(s.status),
  );
}

/**
 * The day the rule would next chase this stage, counting from a given day.
 *
 * Null when the rule declines to schedule, which is not the same as scheduling
 * today. A stage with no cadence is a stage where the next move is a decision
 * rather than a reminder.
 */
export function nextFollowUpDate(stage: LeadStage, fromDay: string): string | null {
  const cadence = FOLLOW_UP_CADENCE_DAYS[stage];
  return cadence === null ? null : addDays(fromDay, cadence);
}

/* ------------------------------------------------------------------------- */

/**
 * Should the rule be keeping a follow-up task for this lead at all?
 *
 * The same four refusals as followUpStatus, in the same order, plus the one extra
 * condition a task needs that a status does not: a date to be due on. A lead the
 * rule is willing to chase but that nobody has given a date is not an error, it
 * simply has nothing to put on a task.
 */
export function followUpTaskEligibility(
  lead: Lead,
): { eligible: boolean; reason: string } {
  if (lead.follow_up_mode === 'archived') {
    return { eligible: false, reason: 'Archived, so the rule keeps no task for them.' };
  }
  if (lead.stage === 'won' || lead.stage === 'lost') {
    return {
      eligible: false,
      reason: `${lead.stage === 'won' ? 'Won' : 'Lost'}, so there is nothing left to chase.`,
    };
  }
  if (lead.follow_up_mode === 'hold') {
    return { eligible: false, reason: 'On hold, waiting on them, so nothing is scheduled.' };
  }
  if (lead.follow_up_mode === 'none') {
    return { eligible: false, reason: 'Set to no follow-up on purpose.' };
  }
  if (lead.next_action_date === null) {
    return { eligible: false, reason: 'No follow-up date set, so there is nothing to be due.' };
  }
  return { eligible: true, reason: 'Followed up on the usual rhythm.' };
}

export function isEligibleForFollowUpTask(lead: Lead): boolean {
  return followUpTaskEligibility(lead).eligible;
}

/** What the rule calls a follow-up task. One format, used everywhere. */
export function followUpTaskTitle(lead: Lead): string {
  return `Follow up with ${lead.prospect_name}`;
}

/**
 * What goes in the task's notes.
 *
 * The lead's own recorded next action first, because somebody wrote it and it is
 * about this particular person. Then whatever the task already said, so adopting
 * a task a person made by hand does not throw their wording away. The rule's own
 * explanation only when there is nothing better, which is the one case where
 * generated copy is an improvement on a blank.
 */
export function followUpTaskNotes(
  lead: Lead,
  existingNotes: string | null,
  reason: string,
): string {
  return lead.next_action ?? existingNotes ?? reason;
}

/**
 * What logging a contact should do to the lead's next action.
 *
 * Deterministic and total: the same lead, the same touch day and the same tasks
 * always produce the same plan, and every branch says why.
 *
 *   'none'        The lead's mode or stage says not to schedule anything.
 *   'create'      The rule keeps no task for this lead yet, so make one.
 *   'reschedule'  It already keeps one, so reopen and move it. Never a second.
 */
export type NextActionKind = 'none' | 'create' | 'reschedule';

export interface NextActionPlan {
  kind: NextActionKind;
  /** The day the follow-up should land. Null when nothing is being scheduled. */
  dueDate: string | null;
  /** The task to move, when rescheduling. */
  taskId: string | null;
  /** The title to give the task. Plain words, no jargon. */
  title: string | null;
  /** What the task's notes should say. */
  notes: string | null;
  /** Why this plan and not another. Shown to the operator, not just logged. */
  reason: string;
}

/** The open follow-up task for a lead, if there is one. */
export function openFollowUpTask(tasks: readonly Task[], leadId: string): Task | null {
  return (
    tasks.find(
      (t) => t.lead_id === leadId && t.task_type === 'follow_up' && t.status === 'open',
    ) ?? null
  );
}

/**
 * The one follow-up task the rule keeps for this lead, whatever state it is in.
 *
 * WHY STATUS IS NOT PART OF THE LOOKUP
 *
 * This task recurs. Finishing it does not end it; it is reopened on the next date,
 * because the thing being modelled is "keep in touch with this person", which has
 * no end. Looking only at open tasks is what caused the original defect: finishing
 * a follow-up marked it done, and the next lookup either found nothing and made a
 * second task, or found a stale copy and moved it without reopening it, leaving a
 * lead with a future date and no task to act on.
 *
 * A task a person made by hand is adopted when the rule keeps none yet, rather
 * than a second one being created alongside it. Their wording survives: see
 * followUpTaskNotes.
 */
export function recurringFollowUpTask(
  tasks: readonly Task[],
  leadId: string,
): Task | null {
  const managed = tasks.find(
    (t) => t.lead_id === leadId && t.task_type === 'follow_up' && t.follow_up_rule_managed,
  );
  return managed ?? openFollowUpTask(tasks, leadId);
}

/**
 * Plan the next action after a contact with this lead.
 *
 * The deliberate decisions come first, in the same order as followUpStatus, so a
 * held or archived lead is never dragged back into the queue by somebody logging
 * a note about them.
 */
export function planNextAction(
  lead: Lead,
  tasks: readonly Task[],
  touchDay: string,
): NextActionPlan {
  const nothing = (reason: string): NextActionPlan => ({
    kind: 'none',
    dueDate: null,
    taskId: null,
    title: null,
    notes: null,
    reason,
  });

  if (lead.follow_up_mode === 'archived') {
    return nothing('This lead is archived, so nothing was scheduled.');
  }
  if (lead.stage === 'won' || lead.stage === 'lost') {
    return nothing(
      `This lead is ${lead.stage}, so nothing was scheduled. More work for them is a new decision, not a reminder.`,
    );
  }
  if (lead.follow_up_mode === 'hold') {
    return nothing('This lead is on hold, waiting on them, so nothing was scheduled.');
  }
  if (lead.follow_up_mode === 'none') {
    return nothing('This lead is set to no follow-up on purpose, so nothing was scheduled.');
  }

  const dueDate = nextFollowUpDate(lead.stage, touchDay);
  if (dueDate === null) {
    return nothing(`There is no follow-up rhythm for the ${lead.stage} stage.`);
  }

  const cadence = FOLLOW_UP_CADENCE_DAYS[lead.stage];
  const title = followUpTaskTitle(lead);
  const existing = recurringFollowUpTask(tasks, lead.id);

  if (existing) {
    const reason = `Moved the follow-up this lead already has to ${cadence} days after the contact, rather than adding a second one.`;
    return {
      kind: 'reschedule',
      dueDate,
      taskId: existing.id,
      title,
      notes: followUpTaskNotes(lead, existing.notes, reason),
      reason,
    };
  }

  const reason = `Scheduled a follow-up ${cadence} days after the contact, which is the rhythm for the ${lead.stage} stage.`;
  return {
    kind: 'create',
    dueDate,
    taskId: null,
    title,
    notes: followUpTaskNotes(lead, null, reason),
    reason,
  };
}
