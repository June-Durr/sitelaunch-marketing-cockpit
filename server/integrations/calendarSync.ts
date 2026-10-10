/**
 * Putting open follow-ups on each connected person's own Google Calendar.
 *
 * WHY THIS IS A MODULE AND NOT JUST THE EDGE FUNCTION
 *
 * Because the rules worth testing are the ones about more than one person.
 * Whether one owner's expired authorization stops everybody else's follow-ups
 * reaching their calendars is not a question a mock of Google can answer from
 * inside a handler that also parses requests and reads environment variables. The
 * decisions live here, behind two injected seams, and the Edge Function is the
 * thin part that supplies them.
 *
 * THE TWO SEAMS
 *
 * CalendarSyncStore is everything that touches the database. refreshFor is how a
 * stored authorization becomes a usable access token. Both are interfaces, so the
 * tests supply fakes and nothing in here reaches a network or a Postgres.
 *
 * WHOSE CALENDAR
 *
 * Each owner's own primary calendar, under their own authorization. There is no
 * configured calendar id and no service account anywhere in this path. See
 * googleCalendar.ts for why 'primary' is acceptable here and refused there.
 */

import { UserRefreshTokenSource } from './googleAuth.ts';
import {
  PRIMARY_CALENDAR_ID, pushFollowUpEvent, type CalendarDeps, type FollowUpEventInput,
} from './googleCalendar.ts';
import { sanitizeError } from './sanitize.ts';

/** One run record, in the shape sync_runs wants. */
export interface CalendarRunToSave {
  ownerId: string;
  connectionId: string | null;
  idempotencyKey: string;
  startedAt: string;
  completedAt: string;
  status: 'succeeded' | 'failed';
  rowsRead: number | null;
  rowsWritten: number | null;
  errorSummary: string | null;
  details: Record<string, unknown>;
}

/** Everything the sync needs from the database, and nothing more. */
export interface CalendarSyncStore {
  /** Owners with a stored authorization. What the scheduled sweep walks. */
  connectedOwners(): Promise<string[]>;
  /** This owner's refresh token, or null when they have not connected. */
  readRefreshToken(ownerId: string): Promise<string | null>;
  /** Their open follow-up tasks, with the lead details the event needs. */
  pushableTasks(ownerId: string): Promise<FollowUpEventInput[]>;
  markTaskSynced(
    ownerId: string, taskId: string, calendarId: string, eventId: string,
  ): Promise<void>;
  markTaskSyncFailed(ownerId: string, taskId: string, message: string): Promise<void>;
  connectionId(ownerId: string): Promise<string | null>;
  markConnectionSynced(ownerId: string): Promise<void>;
  markConnectionError(ownerId: string, message: string): Promise<void>;
  /** Fill in the connected Google address, if it is not already known. */
  rememberGoogleAccount(ownerId: string, email: string): Promise<void>;
  saveRun(run: CalendarRunToSave): Promise<void>;
}

export interface AccessToken {
  accessToken: string;
  expiresInSeconds: number;
}

export interface CalendarSyncDeps {
  store: CalendarSyncStore;
  /** Swap a stored refresh token for a short lived access token. */
  refreshFor: (refreshToken: string) => Promise<AccessToken>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /**
   * Stop after this many tasks. Undefined means all of them.
   *
   * What a canary is: push one, look at what came back, then decide. The first
   * live run had no way to do that, so a payload Google was always going to
   * refuse was sent nineteen times before anybody saw the first answer.
   */
  limit?: number;
}

/**
 * Give up after this many consecutive failures with the same reason.
 *
 * Nineteen identical 400s teach nobody anything the first one did not, and they
 * are nineteen chances to be rate limited for it. A run that stops early says so
 * in its details, so a short run is never mistaken for a complete one.
 */
export const IDENTICAL_FAILURE_LIMIT = 3;

export interface OwnerResult {
  ownerId: string;
  status: 'succeeded' | 'failed' | 'not_connected';
  created: number;
  updated: number;
  failed: number;
  tasks: number;
  error: string | null;
  /** Set when the run stopped before reaching every task it could have. */
  stoppedEarly: 'limit' | 'repeated_failure' | null;
}

export interface SweepResult {
  owners: number;
  brokenOwners: number;
  created: number;
  updated: number;
  failed: number;
  tasks: number;
  results: OwnerResult[];
}

/**
 * Sync one owner, and never throw.
 *
 * Returning the failure instead of raising it is what lets the scheduled sweep
 * cover everybody: one person's expired authorization is their problem to fix and
 * must not stop the next person's follow-ups reaching their calendar. The failure
 * is still recorded against that owner's own connection row, so it appears on
 * their screen and on nobody else's.
 */
export async function syncOneOwner(
  deps: CalendarSyncDeps,
  ownerId: string,
): Promise<OwnerResult> {
  const clock = deps.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const asOf = startedAt.slice(0, 10);
  const idempotencyKey = `google_calendar:export:${asOf}`;
  const nothing = { created: 0, updated: 0, failed: 0, tasks: 0, stoppedEarly: null };

  let calendar: CalendarDeps;
  try {
    const refreshToken = await deps.store.readRefreshToken(ownerId);
    if (!refreshToken) {
      /**
       * Nobody connected, so nothing was supposed to happen.
       *
       * Deliberately not a run record and not an error. Writing a failed run
       * every night for an owner who never asked for a calendar would fill their
       * screen with a problem they do not have.
       */
      return { ownerId, status: 'not_connected', ...nothing, error: null };
    }
    calendar = {
      tokenSource: new UserRefreshTokenSource(refreshToken, deps.refreshFor),
      calendarId: PRIMARY_CALENDAR_ID,
      mode: 'user_oauth',
      fetchImpl: deps.fetchImpl,
    };
  } catch (error) {
    const summary = sanitizeError(error);
    await deps.store.markConnectionError(ownerId, summary);
    return { ownerId, status: 'failed', ...nothing, error: summary };
  }

  let connectionId: string | null = null;
  try {
    connectionId = await deps.store.connectionId(ownerId);
  } catch {
    // Not having a connection row id makes a run record less useful, not wrong.
    connectionId = null;
  }

  try {
    const everyTask = await deps.store.pushableTasks(ownerId);
    const tasks = deps.limit === undefined ? everyTask : everyTask.slice(0, deps.limit);

    let created = 0;
    let updated = 0;
    let failed = 0;
    let organizer: string | null = null;
    let repeated = 0;
    let lastFailure: string | null = null;
    let stoppedEarly: 'limit' | 'repeated_failure' | null =
      tasks.length < everyTask.length ? 'limit' : null;
    const failures: string[] = [];

    for (const task of tasks) {
      /**
       * The same answer three times running is the answer.
       *
       * It means the payload is wrong rather than the row, and continuing only
       * repeats a request Google has already refused.
       */
      if (repeated >= IDENTICAL_FAILURE_LIMIT) {
        stoppedEarly = 'repeated_failure';
        break;
      }

      try {
        const result = await pushFollowUpEvent(calendar, task);
        organizer = organizer ?? result.organizerEmail;
        await deps.store.markTaskSynced(
          ownerId, task.taskId, PRIMARY_CALENDAR_ID, result.eventId,
        );
        if (result.outcome === 'created') created += 1;
        else updated += 1;
        repeated = 0;
        lastFailure = null;
      } catch (error) {
        /**
         * One task failing does not stop the rest.
         *
         * The stored event id is left alone, so the next run updates the event
         * this one could not reach rather than creating a second.
         */
        const summary = sanitizeError(error);
        failed += 1;
        repeated = summary === lastFailure ? repeated + 1 : 1;
        lastFailure = summary;
        if (failures.length < 5) failures.push(summary);
        await deps.store.markTaskSyncFailed(ownerId, task.taskId, summary);
      }
    }

    const attempted = created + updated + failed;
    const status: 'succeeded' | 'failed' =
      failed > 0 && failed === attempted ? 'failed' : 'succeeded';
    const errorSummary =
      failed === 0 ? null : `${failed} of ${attempted} failed. ${failures.join(' ')}`;

    await deps.store.saveRun({
      ownerId,
      connectionId,
      idempotencyKey,
      startedAt,
      completedAt: clock().toISOString(),
      status,
      rowsRead: attempted,
      rowsWritten: created + updated,
      // The table's own constraint requires a reason on a failed run.
      errorSummary: status === 'failed' ? (errorSummary ?? 'Every event failed') : null,
      details: {
        action: 'export', created, updated, failed,
        tasks: attempted, openTasks: everyTask.length, stoppedEarly, asOf,
      },
    });

    if (failed === 0) await deps.store.markConnectionSynced(ownerId);
    else await deps.store.markConnectionError(ownerId, errorSummary ?? 'Some events failed');

    /**
     * Learn whose account this is from work that already succeeded.
     *
     * Google puts the owning address on an event it accepted. Reading it there
     * costs nothing and is the only way to show somebody which account is
     * connected without asking for an identity scope the Cockpit has no other use
     * for.
     */
    if (organizer) {
      try {
        await deps.store.rememberGoogleAccount(ownerId, organizer);
      } catch {
        // A missing display name is cosmetic. It must not fail a good sync.
      }
    }

    return {
      ownerId, status, created, updated, failed, tasks: attempted,
      error: errorSummary, stoppedEarly,
    };
  } catch (error) {
    /**
     * A failed calendar sync must leave the Cockpit working.
     *
     * Nothing in this catch touches a lead, an activity or a task's own plan. The
     * worst case is a calendar that is out of date, and Supabase is untouched.
     */
    const summary = sanitizeError(error);
    await deps.store.markConnectionError(ownerId, summary);
    try {
      await deps.store.saveRun({
        ownerId,
        connectionId,
        idempotencyKey,
        startedAt,
        completedAt: clock().toISOString(),
        status: 'failed',
        rowsRead: null,
        rowsWritten: null,
        errorSummary: summary,
        details: { action: 'export' },
      });
    } catch {
      // Could not even record the failure. The failure is still returned.
    }
    return { ownerId, status: 'failed', ...nothing, error: summary };
  }
}

/**
 * Sync every owner who has connected, independently.
 *
 * Sequential on purpose rather than in parallel: these are outbound requests to
 * one API, and a nightly job that fans out across every customer at once is how
 * a rate limit turns into an outage for all of them instead of a slow night for
 * one. Order is the order the store returns, which is stable.
 */
export async function syncEveryConnectedOwner(deps: CalendarSyncDeps): Promise<SweepResult> {
  const owners = await deps.store.connectedOwners();
  const results: OwnerResult[] = [];

  for (const ownerId of owners) {
    // syncOneOwner does not throw, so this loop cannot be ended by one person's
    // broken authorization. That is the whole contract between these two.
    results.push(await syncOneOwner(deps, ownerId));
  }

  const totals = results.reduce(
    (sum, r) => ({
      created: sum.created + r.created,
      updated: sum.updated + r.updated,
      failed: sum.failed + r.failed,
      tasks: sum.tasks + r.tasks,
    }),
    { created: 0, updated: 0, failed: 0, tasks: 0 },
  );

  return {
    owners: owners.length,
    brokenOwners: results.filter((r) => r.status === 'failed').length,
    ...totals,
    results,
  };
}
