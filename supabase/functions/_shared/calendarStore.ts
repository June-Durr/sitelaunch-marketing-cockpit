/**
 * The database side of the calendar sync.
 *
 * Runs under the service role, which bypasses row level security, so every read
 * filters on owner_id explicitly and every write is scoped to it. With the
 * service role there is no auth.uid(), so a query that forgot the owner would
 * quietly put somebody else's follow-ups on this calendar.
 *
 * There is no delete here, and nothing that clears an external id. A task that
 * failed to sync keeps the ids it already had, so the next attempt updates the
 * event it was always meant to be updating rather than creating a second one.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import type { FollowUpEventInput } from '../../../server/integrations/googleCalendar.ts';
import type { SyncStatus } from '../../../server/integrations/types.ts';

/** One open follow-up, with the lead details the event description needs. */
export interface PushableTask extends FollowUpEventInput {
  externalEventId: string | null;
  externalCalendarId: string | null;
  calendarSyncStatus: string;
}

interface TaskRow {
  id: string;
  due_date: string;
  title: string;
  notes: string | null;
  external_event_id: string | null;
  external_calendar_id: string | null;
  calendar_sync_status: string;
  leads: {
    prospect_name: string | null;
    organization: string | null;
    preferred_channel: string | null;
    relationship: string | null;
    project: string | null;
  } | null;
}

/**
 * Every open follow-up task, with its lead.
 *
 * Only follow-up tasks, and only open ones. A measurement check or an admin task
 * is not something anybody wants on a shared calendar, and a finished follow-up
 * is not something to put in the future.
 *
 * Ordered by due date then id so two runs do the same work in the same order,
 * which makes a partial failure resumable and a log readable.
 */
export async function fetchPushableTasks(
  client: SupabaseClient,
  ownerId: string,
): Promise<PushableTask[]> {
  const { data, error } = await client
    .from('tasks')
    .select(
      'id, due_date, title, notes, external_event_id, external_calendar_id,' +
        ' calendar_sync_status,' +
        ' leads ( prospect_name, organization, preferred_channel, relationship, project )',
    )
    .eq('owner_id', ownerId)
    .eq('task_type', 'follow_up')
    .eq('status', 'open')
    .order('due_date', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw new Error(`tasks read failed: ${error.message}`);

  return ((data ?? []) as unknown as TaskRow[]).map((row) => ({
    taskId: row.id,
    dueDate: row.due_date,
    taskTitle: row.title,
    taskNotes: row.notes,
    prospectName: row.leads?.prospect_name ?? null,
    organization: row.leads?.organization ?? null,
    preferredChannel: row.leads?.preferred_channel ?? null,
    relationship: row.leads?.relationship ?? null,
    project: row.leads?.project ?? null,
    externalEventId: row.external_event_id,
    externalCalendarId: row.external_calendar_id,
    calendarSyncStatus: row.calendar_sync_status,
  }));
}

/** Record that a task is now on the calendar. */
export async function markTaskSynced(
  client: SupabaseClient,
  ownerId: string,
  taskId: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const { error } = await client
    .from('tasks')
    .update({
      external_calendar_id: calendarId,
      external_event_id: eventId,
      calendar_sync_status: 'synced',
      last_synced_at: new Date().toISOString(),
      sync_error: null,
    })
    .eq('id', taskId)
    .eq('owner_id', ownerId);

  if (error) throw new Error(`task sync state failed: ${error.message}`);
}

/**
 * Record that a task could not be written, without losing where it lives.
 *
 * The external ids are deliberately left exactly as they were. Clearing them on
 * failure would mean the next successful run created a second event instead of
 * updating the one that is already in somebody's week.
 */
export async function markTaskSyncFailed(
  client: SupabaseClient,
  ownerId: string,
  taskId: string,
  message: string,
): Promise<void> {
  const { error } = await client
    .from('tasks')
    .update({ calendar_sync_status: 'error', sync_error: message })
    .eq('id', taskId)
    .eq('owner_id', ownerId);

  if (error) throw new Error(`task sync state failed: ${error.message}`);
}

/* -------------------------------------------------------------- run records --- */

export interface CalendarRunRecord {
  ownerId: string;
  connectionId: string | null;
  idempotencyKey: string;
  startedAt: string;
  completedAt: string | null;
  status: SyncStatus;
  rowsRead: number | null;
  rowsWritten: number | null;
  errorSummary: string | null;
  details: Record<string, unknown>;
}

export async function saveCalendarRun(
  client: SupabaseClient,
  run: CalendarRunRecord,
): Promise<void> {
  const { error } = await client.from('sync_runs').upsert(
    {
      owner_id: run.ownerId,
      connection_id: run.connectionId,
      provider: 'google_calendar',
      started_at: run.startedAt,
      completed_at: run.completedAt,
      status: run.status,
      rows_read: run.rowsRead,
      rows_written: run.rowsWritten,
      error_summary: run.errorSummary,
      idempotency_key: run.idempotencyKey,
      details: run.details,
    },
    { onConflict: 'owner_id,idempotency_key', ignoreDuplicates: false },
  );

  if (error) throw new Error(`sync_runs upsert failed: ${error.message}`);
}
