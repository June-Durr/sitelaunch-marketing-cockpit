/**
 * Shared types for server side syncs. No credentials, no implementations.
 *
 * Mirrors the enums in supabase/migrations/0005_integrations.sql.
 */

export type IntegrationProvider =
  | 'ga4' | 'search_console' | 'google_calendar' | 'instagram'
  | 'facebook' | 'linkedin' | 'tiktok' | 'website_forms';

export type IntegrationStatus =
  | 'not_configured' | 'ready' | 'connected' | 'syncing' | 'error';

export type SyncStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

/** A closed date range, both ends included. */
export interface DateWindow {
  start: string;
  end: string;
}

/**
 * Everything a sync needs, and nothing it does not.
 *
 * There is no token on this object on purpose. A sync resolves its own credentials
 * from the server secret store using the connection id. Passing a token around as a
 * plain value is how it ends up in a log.
 */
export interface SyncContext {
  ownerId: string;
  connectionId: string;
  provider: IntegrationProvider;
  window: DateWindow;
  /**
   * Stable key for this logical run, for example 'ga4:2026-09-01:2026-09-19'.
   * A second run with the same key must not repeat the work.
   */
  idempotencyKey: string;
}

export interface SyncResult {
  status: SyncStatus;
  rowsRead: number;
  rowsWritten: number;
  errorSummary: string | null;
}

/**
 * What every provider sync looks like from the outside.
 *
 * Implementations live server side only. Each one must be safe to run twice over
 * the same window: write with an upsert against the unique key, never a plain
 * insert, and never delete rows the provider simply did not mention this time.
 */
export interface ProviderSync {
  readonly provider: IntegrationProvider;
  run(context: SyncContext): Promise<SyncResult>;
}
