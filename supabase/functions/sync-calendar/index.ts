/**
 * Putting open follow-ups on a dedicated Google Calendar.
 *
 * POST with no body, or {"action":"export"}. Callers are the Cockpit's Sync now
 * button with the signed in user's session, or the scheduler with the
 * x-sync-cron-secret header. There is nothing else it can be asked to do.
 *
 * ONE DIRECTION
 *
 * Out. No calendar event is ever read back and turned into activity, because an
 * appointment is not evidence that business contact happened and classifying one
 * as outreach would invent history.
 *
 * WHAT IT WILL NOT DO
 *
 * Delete an event, ever. Write to a calendar that was not explicitly configured.
 * Clear a task's stored event id when a write fails. Touch a lead, an activity,
 * or any task that is not an open follow-up.
 *
 * WHAT NEVER LEAVES
 *
 * The Google credential and the calendar id. Both are read from the environment,
 * held for the request and never returned or logged. The response carries counts,
 * a status and sanitized text, because the response reaches a browser.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

import {
  parseServiceAccountKey, ServiceAccountTokenSource,
} from '../../../server/integrations/googleAuth.ts';
import { sanitizeError, safeLog } from '../../../server/integrations/sanitize.ts';
import { resolveCaller } from '../../../server/integrations/requestAuth.ts';
import {
  CALENDAR_SCOPE, isWritableCalendarId, pushFollowUpEvent, type CalendarDeps,
} from '../../../server/integrations/googleCalendar.ts';
import {
  createServiceClient, ensureConnection, markConnectionError, markConnectionSynced,
} from '../_shared/supabaseStore.ts';
import {
  fetchPushableTasks, markTaskSyncFailed, markTaskSynced, saveCalendarRun,
} from '../_shared/calendarStore.ts';

const PROVIDER = 'google_calendar' as const;

function env(name: string): string | null {
  const value = Deno.env.get(name);
  return value === undefined || value.trim() === '' ? null : value;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-sync-cron-secret',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
  return response;
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    const response = new Response(null, { status: 204 });
    for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
    return response;
  }
  if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: 'Function is not configured' }, 500);
  }

  const verifyJwt = async (token: string): Promise<string | null> => {
    try {
      const anon = createClient(supabaseUrl, env('SUPABASE_ANON_KEY') ?? serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await anon.auth.getUser(token);
      return error ? null : (data.user?.id ?? null);
    } catch {
      return null;
    }
  };

  const caller = await resolveCaller(
    request.headers,
    { cronSecret: env('SYNC_CRON_SECRET'), cronOwnerId: env('SYNC_OWNER_ID') },
    verifyJwt,
  );
  // One answer for every kind of refusal, so probing learns nothing.
  if (!caller) return json({ error: 'Not authorised' }, 401);

  /**
   * The calendar has to be named, and it must not be the default one.
   *
   * Falling back to 'primary' would write into whatever diary the credential
   * happens to own, which is exactly the surprise this refuses to cause.
   */
  const calendarId = env('GOOGLE_CALENDAR_ID');
  if (!isWritableCalendarId(calendarId)) {
    return json(
      {
        status: 'not_configured',
        error:
          'No dedicated calendar is configured. Set GOOGLE_CALENDAR_ID to the id of a '
          + 'calendar made for this, and share it with the service account. The primary '
          + 'calendar is deliberately refused.',
      },
      503,
    );
  }

  const client = createServiceClient(supabaseUrl, serviceRoleKey);
  const startedAt = new Date().toISOString();
  const asOf = startedAt.slice(0, 10);
  const idempotencyKey = `google_calendar:export:${asOf}`;

  let deps: CalendarDeps;
  try {
    const rawKey = env('GOOGLE_SERVICE_ACCOUNT_KEY');
    if (!rawKey) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
    deps = {
      tokenSource: new ServiceAccountTokenSource(parseServiceAccountKey(rawKey)),
      calendarId: calendarId as string,
    };
  } catch (error) {
    const summary = sanitizeError(error);
    safeLog('calendar: credentials unusable', summary);
    await markConnectionError(client, caller.ownerId, PROVIDER, summary);
    return json({ status: 'failed', error: summary }, 500);
  }

  let connectionId: string | null = null;
  try {
    connectionId = await ensureConnection(
      client,
      caller.ownerId,
      PROVIDER,
      // Shown on screen. A calendar id is configuration, not a credential, and
      // seeing which calendar is being written to is the point of the panel.
      calendarId as string,
      deps.tokenSource.describe(),
      [CALENDAR_SCOPE],
    );
  } catch (error) {
    safeLog('calendar: could not record the connection', sanitizeError(error));
  }

  try {
    const tasks = await fetchPushableTasks(client, caller.ownerId);

    let created = 0;
    let updated = 0;
    let failed = 0;
    const failures: string[] = [];

    for (const task of tasks) {
      try {
        const result = await pushFollowUpEvent(deps, task);
        await markTaskSynced(
          client, caller.ownerId, task.taskId, calendarId as string, result.eventId,
        );
        if (result.outcome === 'created') created += 1;
        else updated += 1;
      } catch (error) {
        /**
         * One task failing does not stop the rest.
         *
         * The stored event id is left alone, so the next run updates the event
         * this one could not reach rather than creating a second.
         */
        const summary = sanitizeError(error);
        failed += 1;
        if (failures.length < 5) failures.push(summary);
        await markTaskSyncFailed(client, caller.ownerId, task.taskId, summary);
      }
    }

    const status = failed === 0 ? 'succeeded' : tasks.length === failed ? 'failed' : 'succeeded';
    const errorSummary =
      failed === 0 ? null : `${failed} of ${tasks.length} failed. ${failures.join(' ')}`;

    await saveCalendarRun(client, {
      ownerId: caller.ownerId,
      connectionId,
      idempotencyKey,
      startedAt,
      completedAt: new Date().toISOString(),
      status,
      rowsRead: tasks.length,
      rowsWritten: created + updated,
      // The table's own constraint requires a reason on a failed run.
      errorSummary: status === 'failed' ? (errorSummary ?? 'Every event failed') : null,
      details: { action: 'export', created, updated, failed, tasks: tasks.length, asOf },
    });

    if (failed === 0) {
      await markConnectionSynced(client, caller.ownerId, PROVIDER);
    } else {
      await markConnectionError(
        client, caller.ownerId, PROVIDER, errorSummary ?? 'Some events failed',
      );
    }

    safeLog(
      `calendar: ${created} created, ${updated} updated, ${failed} failed via ${caller.via}`,
    );

    return json({
      status,
      created,
      updated,
      failed,
      tasks: tasks.length,
      error: errorSummary,
      asOf,
    });
  } catch (error) {
    /**
     * A failed calendar sync must leave the Cockpit working.
     *
     * Nothing in this catch touches a lead, an activity or a task's own plan. The
     * worst case is a calendar that is out of date, and Supabase is untouched.
     */
    const summary = sanitizeError(error);
    safeLog('calendar: export failed', summary);
    await markConnectionError(client, caller.ownerId, PROVIDER, summary);
    try {
      await saveCalendarRun(client, {
        ownerId: caller.ownerId,
        connectionId,
        idempotencyKey,
        startedAt,
        completedAt: new Date().toISOString(),
        status: 'failed',
        rowsRead: null,
        rowsWritten: null,
        errorSummary: summary,
        details: { action: 'export' },
      });
    } catch (recordError) {
      safeLog('calendar: could not even record the failure', sanitizeError(recordError));
    }
    return json({ status: 'failed', error: summary }, 502);
  }
});
