/**
 * Google Calendar sync contract.
 *
 * NOT CONNECTED. This file describes the behaviour a future implementation has to
 * honour. It holds no credentials, no OAuth flow and no stubbed responses. A stub
 * that returns invented data is worse than nothing, because it looks like it works.
 *
 * THE RULES, which exist because a calendar is often shared with other people
 *
 * 1. A Cockpit task may become a calendar event. Writing it stores
 *    external_calendar_id and external_event_id on the task.
 * 2. Pushing the same task again UPDATES that event. It never creates a second
 *    one. The stored external_event_id is what makes this idempotent.
 * 3. A calendar event may become a Cockpit activity, because an event that already
 *    happened is a record rather than a plan. Matching is on
 *    (owner_id, external_calendar_id, external_event_id), which the database
 *    enforces as unique, so a repeated pull updates rather than duplicates.
 * 4. Deleting a Cockpit task or activity NEVER deletes the calendar event. The
 *    calendar may be shared with people who do not use this app, and a silent
 *    deletion from their week is not ours to make. The local record goes, the
 *    external event stays, and the link is dropped.
 * 5. Any destructive action against the external calendar needs explicit
 *    confirmation naming the specific event. No bulk deletes, no implicit
 *    cleanups, no reconciliation that removes whatever it did not recognise.
 * 6. A failed sync sets calendar_sync_status to error and writes sync_error. It
 *    does not retry silently, and it does not clear the stored ids, so a later
 *    successful run can still find the event it was meant to be updating.
 */

import type { SyncContext, SyncResult } from './types.ts';

/** One direction of travel. A deployment may choose to do only one. */
export type CalendarDirection = 'push_tasks' | 'pull_events' | 'both';

export interface CalendarSyncOptions {
  direction: CalendarDirection;
  /** Which calendar to write into. Required before any push is attempted. */
  calendarId: string;
  /**
   * When true the sync reports what it would do and writes nothing. The first run
   * against a real calendar should always use this.
   */
  dryRun: boolean;
}

/** A local record as it would be expressed on a calendar. */
export interface CalendarEventDraft {
  /** The Cockpit task this came from. */
  taskId: string;
  title: string;
  /** These are all day entries, so a date rather than a timestamp. */
  date: string;
  description: string | null;
  /** Set once this task has been pushed, which turns a create into an update. */
  existingEventId: string | null;
}

/**
 * Calendar deliberately does not implement ProviderSync.
 *
 * Every other provider pulls data in one direction and needs nothing but a window.
 * Calendar writes to somebody else's data, so it requires an explicit target
 * calendar and a dry run flag on every call. Forcing it into the one argument
 * shape would mean carrying those somewhere less visible, which is exactly how a
 * destructive default slips through.
 */
export interface CalendarSync {
  readonly provider: 'google_calendar';
  run(context: SyncContext, options: CalendarSyncOptions): Promise<SyncResult>;
}

/**
 * Whether pushing this draft creates or updates, decided only by whether an
 * external id is already stored. Pure, so the rule is testable without a network.
 */
export function plannedCalendarAction(draft: CalendarEventDraft): 'create' | 'update' {
  return draft.existingEventId ? 'update' : 'create';
}

/**
 * What happens to the external event when the local record is deleted.
 *
 * Always keep. Written as a function rather than a comment so the decision is
 * covered by a test and cannot be quietly reversed later.
 */
export function externalEventOnLocalDelete(): 'keep' {
  return 'keep';
}

/**
 * Whether an external action needs the user to confirm it first.
 *
 * Anything that changes or removes something on a calendar somebody else can see
 * needs a yes. Reading never does.
 */
export function needsUserConfirmation(
  action: 'read' | 'create' | 'update' | 'delete',
): boolean {
  return action === 'delete' || action === 'update';
}
