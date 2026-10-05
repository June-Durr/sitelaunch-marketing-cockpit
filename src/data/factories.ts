import type { CalendarSyncStatus } from '../types/domain';

/**
 * The calendar fields every task and activity carries.
 *
 * Nothing is connected to a calendar yet, so a new record starts unsynced with no
 * external ids. Kept in one place so adding a row somewhere new cannot accidentally
 * leave these undefined, which would read as "synced" to a future sync job.
 */
export function blankCalendarSync(): {
  external_calendar_id: string | null;
  external_event_id: string | null;
  calendar_sync_status: CalendarSyncStatus;
  last_synced_at: string | null;
  sync_error: string | null;
} {
  return {
    external_calendar_id: null,
    external_event_id: null,
    calendar_sync_status: 'not_synced',
    last_synced_at: null,
    sync_error: null,
  };
}

/**
 * The touch fields every activity carries.
 *
 * channel and evidence_source are blank unless somebody said how the contact
 * happened and where the proof is, and external_source is set only by whatever
 * imported the record. Kept in one place for the same reason as the calendar
 * fields above: a new call site that left them undefined would read as "imported
 * from somewhere" to the mirror's own idempotency check.
 */
export function blankTouchFields(): {
  external_source: string | null;
  channel: string | null;
  evidence_source: string | null;
} {
  return { external_source: null, channel: null, evidence_source: null };
}
