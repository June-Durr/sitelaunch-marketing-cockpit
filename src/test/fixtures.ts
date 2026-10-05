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
