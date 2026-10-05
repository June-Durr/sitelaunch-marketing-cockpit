/**
 * The part of a sync that is the same for every provider.
 *
 * Fetching differs between GA4 and Search Console. Everything around it does not:
 * decide the window, refuse to store an unfinished day, upsert rather than insert,
 * never delete, write down what happened either way. That shared part lives here
 * once, with the provider-specific work passed in, so a second provider cannot
 * quietly acquire different safety rules.
 *
 * WHY NOTHING HERE TOUCHES A DATABASE DIRECTLY
 *
 * The store is an argument. In production it is a Supabase service-role client; in
 * the tests it is an in-memory double that enforces the same unique keys. That is
 * what lets the tests prove the behaviour that actually matters, that running the
 * same window three times does not change the row count, without a live project.
 */

import { sanitizeError } from './sanitize.ts';
import { clampToCompleteDays, isCompleteDay } from './syncWindow.ts';
import type { Ga4DailyRow, SearchConsoleDailyRow } from './analytics.ts';
import type {
  DateWindow, IntegrationProvider, SyncResult, SyncStatus,
} from './types.ts';

/** One attempt, as sync_runs stores it. */
export interface SyncRunRecord {
  ownerId: string;
  connectionId: string | null;
  provider: IntegrationProvider;
  idempotencyKey: string;
  startedAt: string;
  completedAt: string | null;
  status: SyncStatus;
  rowsRead: number | null;
  rowsWritten: number | null;
  errorSummary: string | null;
  /**
   * Counts a provider has that rows read and rows written cannot carry, such as
   * a reconciliation's created, updated, unchanged and ambiguous tallies. Must be
   * sanitized before it gets here: the owner can read this column.
   */
  details?: Record<string, unknown>;
}

/**
 * Everything a sync is allowed to do to the database.
 *
 * Note what is missing: there is no delete. A provider omitting a row is not
 * evidence the row is wrong, so the sync has no way to act on that even by
 * mistake.
 */
export interface SyncStore {
  upsertGa4Rows(
    ownerId: string, connectionId: string | null, rows: Ga4DailyRow[],
  ): Promise<number>;
  upsertSearchConsoleRows(
    ownerId: string, connectionId: string | null, rows: SearchConsoleDailyRow[],
  ): Promise<number>;
  /** Insert, or update the row already carrying this idempotency key. */
  saveSyncRun(run: SyncRunRecord): Promise<void>;
}

export interface RunSyncOptions<Row extends { date: string }> {
  ownerId: string;
  connectionId: string | null;
  provider: IntegrationProvider;
  idempotencyKey: string;
  window: DateWindow;
  now: Date;
  store: SyncStore;
  fetchRows: (window: DateWindow) => Promise<Row[]>;
  writeRows: (rows: Row[]) => Promise<number>;
}

/**
 * Run one sync, and write down what happened whatever that was.
 *
 * Never throws. A sync that failed is a fact to record, not an exception for the
 * scheduler to swallow, and a run that could not even be recorded is the only
 * thing that propagates.
 */
export async function runSync<Row extends { date: string }>(
  options: RunSyncOptions<Row>,
): Promise<SyncResult> {
  const { ownerId, connectionId, provider, idempotencyKey, now, store } = options;
  const startedAt = now.toISOString();

  const base = {
    ownerId, connectionId, provider, idempotencyKey, startedAt,
  } as const;

  const window = clampToCompleteDays(options.window, now);
  if (!window) {
    // Asked for a window that is entirely today or later. Nothing to do, and
    // saying so is not a failure.
    const result: SyncResult = {
      status: 'skipped',
      rowsRead: 0,
      rowsWritten: 0,
      errorSummary: null,
    };
    await store.saveSyncRun({
      ...base,
      completedAt: new Date().toISOString(),
      status: 'skipped',
      rowsRead: 0,
      rowsWritten: 0,
      errorSummary: null,
    });
    return result;
  }

  await store.saveSyncRun({
    ...base,
    completedAt: null,
    status: 'running',
    rowsRead: null,
    rowsWritten: null,
    errorSummary: null,
  });

  try {
    const fetched = await options.fetchRows(window);

    // Second guard, after the window clamp. A provider can return a day outside
    // what was asked for, and an unfinished day must not be stored even then.
    const storable = fetched.filter((row) => isCompleteDay(row.date, now));
    const written = storable.length === 0 ? 0 : await options.writeRows(storable);

    await store.saveSyncRun({
      ...base,
      completedAt: new Date().toISOString(),
      status: 'succeeded',
      rowsRead: fetched.length,
      rowsWritten: written,
      errorSummary: null,
    });

    return {
      status: 'succeeded',
      rowsRead: fetched.length,
      rowsWritten: written,
      errorSummary: null,
    };
  } catch (error) {
    const errorSummary = sanitizeError(error);
    await store.saveSyncRun({
      ...base,
      completedAt: new Date().toISOString(),
      status: 'failed',
      rowsRead: null,
      rowsWritten: null,
      // The table's own constraint requires this, and a failure with no reason
      // is not worth recording.
      errorSummary,
    });

    return { status: 'failed', rowsRead: 0, rowsWritten: 0, errorSummary };
  }
}
