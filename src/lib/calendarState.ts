/**
 * What the calendar knows about a follow-up, in words a person can act on.
 *
 * Kept apart from the component that renders it so there is one definition of
 * each state and one place to change the wording. Nothing here talks to Google:
 * it reads the status the server already wrote onto the task.
 */

import type { CalendarSyncStatus, Task } from '../types/domain';

export type CalendarState = 'synced' | 'pending' | 'error' | 'unavailable';

export const CALENDAR_STATE_LABELS: Record<CalendarState, string> = {
  synced: 'On the calendar',
  pending: 'Waiting to sync',
  error: 'Calendar sync failed',
  unavailable: 'Not on a calendar',
};

export const CALENDAR_STATE_EXPLANATIONS: Record<CalendarState, string> = {
  synced: 'This follow-up has an event on the SiteLaunch calendar.',
  pending: 'The date changed, so the calendar has not caught up with it yet.',
  error: 'The last attempt to write this to the calendar failed. The reason is on the task.',
  unavailable: 'Nothing has been put on a calendar for this one.',
};

export const CALENDAR_STATE_TONES: Record<
  CalendarState,
  'violet' | 'amber' | 'crimson' | 'quiet'
> = {
  synced: 'violet',
  pending: 'amber',
  error: 'crimson',
  unavailable: 'quiet',
};

/**
 * Read the calendar state off the task the follow-up rule keeps.
 *
 * No task means nothing could ever have been pushed, which is 'unavailable'
 * rather than an error: a lead with no follow-up task is not a calendar failure.
 * 'not_synced' says the same thing, because that is what a task carries when
 * nothing has tried to send it.
 */
export function calendarStateFor(task: Task | null): CalendarState {
  if (!task) return 'unavailable';
  const status: CalendarSyncStatus = task.calendar_sync_status;
  if (status === 'synced') return 'synced';
  if (status === 'pending') return 'pending';
  if (status === 'error') return 'error';
  return 'unavailable';
}
