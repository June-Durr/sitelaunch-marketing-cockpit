/**
 * Putting open follow-ups on each person's own Google Calendar.
 *
 * POST with no body, or {"action":"export"}. Two callers:
 *
 *   a signed in person   syncs that person and nobody else
 *   the scheduler        walks every owner who has connected, one at a time
 *
 * This file is the thin part. Who gets synced, what happens when one person's
 * authorization has expired, and what a run record says all live in
 * server/integrations/calendarSync.ts, where they are tested against fakes. What
 * is here is request handling, environment reading, and a store built over the
 * Supabase client.
 *
 * WHY THERE IS NO SYNC_OWNER_ID HERE
 *
 * The analytics syncs read one GA4 property that belongs to SiteLaunch, so a
 * single configured owner is the honest answer for them. A calendar belongs to
 * whoever authorized it, and there can be any number of those. A fixed owner id
 * would mean the nightly run wrote one person's follow-ups and silently ignored
 * everybody else's, which is worse than not running at all because every screen
 * would still say it succeeded. The list of owners comes from who actually holds
 * a token.
 *
 * ONE DIRECTION, AND ONLY OUR OWN EVENTS
 *
 * Out. No calendar event is ever read back and turned into activity, because an
 * appointment is not evidence that business contact happened. Nothing is
 * enumerated either: every request addresses one event id computed from one
 * Cockpit task id, so an unrelated personal event is not something this can see,
 * let alone change. Nothing is ever deleted.
 *
 * WHAT NEVER LEAVES
 *
 * The OAuth client secret and every refresh token. They are read from the
 * environment or from the Vault helpers, held for the request and never returned
 * or logged. The response carries counts, a status and sanitized text, because
 * the response reaches a browser.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  CALENDAR_OAUTH_SCOPE, refreshAccessToken, type OAuthClient,
} from '../../../server/integrations/googleOAuth.ts';
import {
  syncEveryConnectedOwner, syncOneOwner,
  type CalendarSyncDeps, type CalendarSyncStore,
} from '../../../server/integrations/calendarSync.ts';
import { sanitizeError, safeLog } from '../../../server/integrations/sanitize.ts';
import {
  CRON_SECRET_HEADER, requireUser, secretsMatch,
} from '../../../server/integrations/requestAuth.ts';
import {
  createServiceClient, markConnectionError, markConnectionSynced,
} from '../_shared/supabaseStore.ts';
import {
  fetchPushableTasks, markTaskSyncFailed, markTaskSynced, saveCalendarRun,
} from '../_shared/calendarStore.ts';
import { connectedOwners, readRefreshToken } from '../_shared/calendarOAuthStore.ts';

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

function oauthClient(): OAuthClient | null {
  const clientId = env('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = env('GOOGLE_OAUTH_CLIENT_SECRET');
  const redirectUri = env('GOOGLE_OAUTH_REDIRECT_URI');
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/** The store the sync module asks for, over the real database. */
function storeOver(client: SupabaseClient): CalendarSyncStore {
  return {
    connectedOwners: () => connectedOwners(client),
    readRefreshToken: (ownerId) => readRefreshToken(client, ownerId),
    pushableTasks: (ownerId) => fetchPushableTasks(client, ownerId),
    markTaskSynced: (ownerId, taskId, calendarId, eventId) =>
      markTaskSynced(client, ownerId, taskId, calendarId, eventId),
    markTaskSyncFailed: (ownerId, taskId, message) =>
      markTaskSyncFailed(client, ownerId, taskId, message),
    markConnectionSynced: (ownerId) => markConnectionSynced(client, ownerId, PROVIDER),
    markConnectionError: (ownerId, message) =>
      markConnectionError(client, ownerId, PROVIDER, message),
    saveRun: (run) => saveCalendarRun(client, run),

    async connectionId(ownerId) {
      const { data } = await client
        .from('integration_connections')
        .select('id')
        .eq('owner_id', ownerId)
        .eq('provider', PROVIDER)
        .maybeSingle();
      return (data as { id: string } | null)?.id ?? null;
    },

    /**
     * Written once and not overwritten.
     *
     * The `is('display_name', null)` is what makes it once: a later run that
     * learns nothing cannot blank out a name already on screen, and a person who
     * reconnects with a different Google account gets a fresh row from the
     * callback rather than a stale name patched over.
     */
    async rememberGoogleAccount(ownerId, email) {
      await client
        .from('integration_connections')
        .update({ display_name: email, granted_scopes: [CALENDAR_OAUTH_SCOPE] })
        .eq('owner_id', ownerId)
        .eq('provider', PROVIDER)
        .is('display_name', null);
    },
  };
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

  const client = createServiceClient(supabaseUrl, serviceRoleKey);

  /**
   * How many tasks this run may touch, when the caller says.
   *
   * Not an owner id and not a calendar: a count, clamped, and it can only ever
   * narrow what the run does. A caller cannot use it to reach anybody else's
   * tasks, which is why it is the one thing read from the body.
   */
  let limit: number | null = null;
  try {
    const body = (await request.clone().json()) as { limit?: unknown };
    if (typeof body.limit === 'number' && Number.isFinite(body.limit)) {
      limit = Math.max(1, Math.min(1000, Math.floor(body.limit)));
    }
  } catch {
    limit = null;
  }

  /**
   * Whether this deployment can talk to Google at all.
   *
   * Deliberately checked AFTER the caller is known. Answering "not configured"
   * to an unauthenticated request would tell anybody who asked what state this
   * deployment is in, and the rule everywhere else here is that a refusal
   * teaches a prober nothing.
   */
  function depsOrNotConfigured(): CalendarSyncDeps | Response {
    const oauth = oauthClient();
    if (!oauth) {
      return json(
        {
          status: 'not_configured',
          error:
            'Google Calendar is not set up on this deployment yet. It needs an OAuth '
            + 'client: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and '
            + 'GOOGLE_OAUTH_REDIRECT_URI as Edge Function secrets.',
        },
        503,
      );
    }
    return {
      store: storeOver(client),
      refreshFor: (token) => refreshAccessToken(oauth, token),
      ...(limit === null ? {} : { limit }),
    };
  }

  /* ------------------------------------------------------- the scheduled run --- */

  const presentedSecret = request.headers.get(CRON_SECRET_HEADER);
  if (presentedSecret !== null) {
    if (!secretsMatch(presentedSecret, env('SYNC_CRON_SECRET'))) {
      return json({ error: 'Not authorised' }, 401);
    }

    const deps = depsOrNotConfigured();
    if (deps instanceof Response) return deps;

    try {
      const sweep = await syncEveryConnectedOwner(deps);
      safeLog(
        `calendar: ${sweep.owners} owners, ${sweep.created} created, `
        + `${sweep.updated} updated, ${sweep.failed} failed, ${sweep.brokenOwners} broken`,
      );
      return json({
        // Succeeded means the sweep ran, not that nothing anywhere went wrong.
        // Each owner's own connection row carries theirs.
        status: 'succeeded',
        owners: sweep.owners,
        brokenOwners: sweep.brokenOwners,
        created: sweep.created,
        updated: sweep.updated,
        failed: sweep.failed,
        tasks: sweep.tasks,
        error: null,
      });
    } catch (error) {
      // Only reachable if listing the owners failed. One owner's sync cannot
      // land here, by the contract in calendarSync.ts.
      const summary = sanitizeError(error);
      safeLog('calendar: the sweep could not start', summary);
      return json({ status: 'failed', error: summary }, 500);
    }
  }

  /* ---------------------------------------------------------- one person, now --- */

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

  /**
   * Their own session, and that session decides whose calendar is written.
   *
   * The owner is never read from the body. An owner id in a request body is a
   * request to write into somebody else's week.
   */
  const ownerId = await requireUser(request.headers, verifyJwt);
  // One answer for every kind of refusal, so probing learns nothing.
  if (!ownerId) return json({ error: 'Not authorised' }, 401);

  const deps = depsOrNotConfigured();
  if (deps instanceof Response) return deps;

  const result = await syncOneOwner(deps, ownerId);

  if (result.status === 'not_connected') {
    return json(
      {
        status: 'not_connected',
        error:
          'No Google account is connected yet. Use Connect Google Calendar, and '
          + 'approve the request when Google asks.',
      },
      503,
    );
  }

  safeLog(
    `calendar: ${result.created} created, ${result.updated} updated, ${result.failed} failed`,
  );

  return json(
    {
      status: result.status,
      created: result.created,
      updated: result.updated,
      failed: result.failed,
      tasks: result.tasks,
      stoppedEarly: result.stoppedEarly,
      error: result.error,
    },
    result.status === 'failed' ? 502 : 200,
  );
});
