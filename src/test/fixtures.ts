/**
 * Deterministic test records.
 *
 * Every test that needs a lead, a task or an activity builds it here rather than
 * writing the object out. Two reasons, and the second is the important one:
 *
 *   A column added to the schema needs one edit, not thirty. Before this existed,
 *   adding a field to Lead broke every test file that happened to construct one,
 *   and the fix was mechanical noise in a diff that was supposed to be about
 *   something else.
 *
 *   Nothing here is production data. These are invented people with invented
 *   dates, so a test can be read, reasoned about and changed without anybody
 *   having to look at the real pipeline to understand what it is asserting.
 *
 * Dates are fixed strings. Nothing in this file reads the clock, because a test
 * whose result depends on what day it is run is a test that fails on a Tuesday in
 * six months and nobody knows why.
 */

import type {
  ActivityEvent, Lead, LeadStage, Task,
} from '../types/domain';
import { blankCalendarSync, blankTouchFields } from '../data/factories';

/** The timestamp everything defaults to, so comparisons are stable. */
export const FIXTURE_TIME = '2026-09-19T12:00:00.000Z';

/** The day everything defaults to. */
export const FIXTURE_DAY = '2026-09-19';

export function makeLead(over: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    content_item_id: null,
    prospect_name: 'Rivera Roofing',
    organization: null,
    email: null,
    phone: null,
    project: null,
    source: null,
    related_campaign: null,
    stage: 'new_contact' as LeadStage,
    next_action: null,
    next_action_date: null,
    proposed_value: null,
    closed_value: null,
    attribution_note: null,
    notes: null,
    external_source: null,
    external_key: null,
    relationship: null,
    current_status: null,
    preferred_channel: null,
    record_confidence: null,
    follow_up_mode: 'auto',
    reported_last_touch_at: null,
    is_seed: false,
    first_contact_at: null,
    closed_at: null,
    created_at: FIXTURE_TIME,
    updated_at: FIXTURE_TIME,
    ...over,
  };
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    content_item_id: null,
    lead_id: null,
    title: 'Send the revised proposal',
    task_type: 'follow_up',
    status: 'open',
    due_date: FIXTURE_DAY,
    window_type: null,
    notes: null,
    completed_at: null,
    // A task is somebody's own until the follow-up rule says otherwise, so the
    // default here matches the column default rather than the common case in
    // any one test.
    follow_up_rule_managed: false,
    ...blankCalendarSync(),
    is_seed: false,
    created_at: FIXTURE_TIME,
    updated_at: FIXTURE_TIME,
    ...over,
  };
}

export function makeActivity(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'activity-1',
    occurred_at: FIXTURE_TIME,
    activity_type: 'other',
    title: 'Something happened',
    details: null,
    source: 'manual',
    external_id: null,
    content_item_id: null,
    lead_id: null,
    task_id: null,
    ...blankTouchFields(),
    ...blankCalendarSync(),
    is_seed: false,
    created_at: FIXTURE_TIME,
    updated_at: FIXTURE_TIME,
    ...over,
  };
}

/**
 * A lead and an activity shaped as the repository wants them for an insert.
 *
 * NewRow omits the id and the timestamps, which the database fills in. Tests that
 * insert through a repository need that shape rather than a whole row.
 */
export function newLead(over: Partial<Lead> = {}): Omit<Lead, 'id' | 'created_at' | 'updated_at'> {
  const { id: _id, created_at: _c, updated_at: _u, ...rest } = makeLead(over);
  return rest;
}

export function newActivity(
  over: Partial<ActivityEvent> = {},
): Omit<ActivityEvent, 'id' | 'created_at' | 'updated_at'> {
  const { id: _id, created_at: _c, updated_at: _u, ...rest } = makeActivity(over);
  return rest;
}

export function newTask(over: Partial<Task> = {}): Omit<Task, 'id' | 'created_at' | 'updated_at'> {
  const { id: _id, created_at: _c, updated_at: _u, ...rest } = makeTask(over);
  return rest;
}

/* ------------------------------------------------------------------------- */

/**
 * A pipeline shaped like the one the mirror import produced: 21 relationships,
 * of which 19 are followed up and 2 are deliberately left alone.
 *
 * Invented people, fixed dates. It exists so the follow-up reconciliation can be
 * tested against the same *shape* as the real data without any real data being
 * copied into the repository. The two excluded leads are the interesting part:
 * one is set to no follow-up on purpose and one is on hold, which are the two
 * ways a real lead opts out, and neither should ever receive a task.
 */
export function twentyOneLeads(): Lead[] {
  const stages: LeadStage[] = [
    'follow_up', 'waiting', 'new_contact', 'qualified', 'proposal', 'call_scheduled',
  ];

  // 19 that the rule follows up, with a spread of stages and dates.
  const followed = Array.from({ length: 19 }, (_, i) =>
    makeLead({
      id: `lead-${String(i + 1).padStart(2, '0')}`,
      external_key: `relationship-${String(i + 1).padStart(2, '0')}`,
      external_source: 'google_sheets',
      prospect_name: `Prospect ${i + 1}`,
      organization: i % 3 === 0 ? null : `Organization ${i + 1}`,
      stage: stages[i % stages.length],
      follow_up_mode: 'auto',
      // Spread across overdue, today and the next fortnight.
      next_action_date: addFixtureDays('2026-10-01', i),
      next_action: i % 4 === 0 ? null : `Send the ${i + 1} follow-up`,
      preferred_channel: i % 2 === 0 ? 'Email' : 'Phone',
      reported_last_touch_at: addFixtureDays('2026-09-01', i),
    }),
  );

  // 2 that opt out, one each way.
  const excluded = [
    makeLead({
      id: 'lead-20',
      external_key: 'relationship-20',
      external_source: 'google_sheets',
      prospect_name: 'Prospect 20',
      organization: 'Organization 20',
      stage: 'waiting',
      follow_up_mode: 'none',
      next_action: 'No action unless they re-engage',
    }),
    makeLead({
      id: 'lead-21',
      external_key: 'relationship-21',
      external_source: 'google_sheets',
      prospect_name: 'Prospect 21',
      organization: 'Organization 21',
      stage: 'waiting',
      follow_up_mode: 'hold',
      next_action: 'Hold until they come back',
    }),
  ];

  return [...followed, ...excluded];
}

/** Day arithmetic for the fixtures, so none of them reads a clock. */
function addFixtureDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
