/**
 * The worker that drains sync_jobs.
 *
 * TWO CALLERS, TWO SCOPES
 *
 *   the scheduler   x-sync-cron-secret, drains everybody's queue
 *   a signed in person   their own session, drains their own queue and nobody
 *                        else's
 *
 * The second is what makes a save feel finished without a Sync now button: the
 * browser asks for its own queue to be run the moment a completion commits. It
 * is scoped by a different database function rather than by an argument,
 * because a null owner quietly meaning "everyone" is exactly the kind of default
 * that becomes a leak.
 *
 * A JOB IS NEVER FINISHED BECAUSE IT WAS STARTED
 *
 * finish_sync_job is called with the real outcome. A sync that threw, returned a
 * failure, or could not be attempted is pushed back with its reason and a
 * doubling delay, and the row stays outstanding. Nothing here reports success
 * because work was queued, which is the whole reason the queue exists.
 *
 * WHY THE LEAD MIRROR IS DISPATCHED AND THE CALENDAR IS NOT
 *
 * The calendar sync is already a per-owner function in
 * server/integrations/calendarSync.ts, so this calls it directly. The lead
 * mirror's logic lives inside its own HTTP handler and is not extracted, so
 * this asks that function to do the work rather than duplicating it. The honest
 * consequence is in the code: the mirror runs only for the owner the deployment
 * has a spreadsheet configured for, and a job belonging to anybody else is
 * finished with a reason rather than silently written into somebody else's
 * sheet.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import {
  CALENDAR_OAUTH_SCOPE, refreshAccessToken, type OAuthClient,
} from '../../../server/integrations/googleOAuth.ts';
import {
  syncOneOwner, type CalendarSyncDeps, type CalendarSyncStore,
} from '../../../server/integrations/calendarSync.ts';
import { sanitizeError, safeLog } from '../../../server/integrations/sanitize.ts';
import {
  CRON_SECRET_HEADER, requireUser, secretsMatch,
} from '../../../server/integrations/requestAuth.ts';
import {
  createServiceClient, markConnectionError, markConnectionSynced,
} from '../_shared/supabaseStore.ts';
import {
  fetchPendingHistory, fetchPushableTasks, markHistoryFailed, markHistorySynced,
  markTaskSyncFailed, markTaskSynced, saveCalendarRun,
} from '../_shared/calendarStore.ts';
import { connectedOwners, readRefreshToken } from '../_shared/calendarOAuthStore.ts';

const PROVIDER = 'google_calendar' as const;

/** How many jobs one invocation will take. Small, because each one is outbound work. */
const BATCH = 10;

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

interface SyncJob {
  id: string;
  owner_id: string;
  kind: 'calendar' | 'lead_mirror';
  attempts: number;
}

function storeOver(client: SupabaseClient): CalendarSyncStore {
  return {
    connectedOwners: () => connectedOwners(client),
    readRefreshToken: (ownerId) => readRefreshToken(client, ownerId),
    pushableTasks: (ownerId) => fetchPushableTasks(client, ownerId),
    pendingHistory: (ownerId) => fetchPendingHistory(client, ownerId),
    markHistorySynced: (ownerId, activityId, calendarId, eventId) =>
      markHistorySynced(client, ownerId, activityId, calendarId, eventId),
    markHistoryFailed: (ownerId, activityId, message) =>
      markHistoryFailed(client, ownerId, activityId, message),
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

/** Ask the lead mirror function to export, as the scheduler would. */
async function runLeadMirror(ownerId: string): Promise<{ ok: boolean; error: string | null }> {
  const base = env('SYNC_FUNCTIONS_BASE_URL');
  const secret = env('SYNC_CRON_SECRET');
  const mirrorOwner = env('SYNC_OWNER_ID');

  if (!base || !secret) {
    return { ok: false, error: 'the mirror dispatcher is not configured' };
  }

  /**
   * One sheet, one owner.
   *
   * sync-lead-mirror takes its owner from SYNC_OWNER_ID when the scheduler
   * calls it, so running it for anybody else would write their records into
   * this deployment's spreadsheet. The job is closed with a reason instead,
   * which is a true statement rather than a silent success.
   */
  if (mirrorOwner === null || ownerId !== mirrorOwner) {
    return { ok: false, error: 'no spreadsheet is configured for this owner' };
  }

  try {
    const response = await fetch(`${base}/sync-lead-mirror`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CRON_SECRET_HEADER]: secret,
      },
      body: JSON.stringify({ action: 'export' }),
    });

    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    // Both have to be true. An HTTP 200 carrying {"status":"failed"} is a
    // failure, and treating it as success is exactly the lie the queue exists
    // to prevent.
    const ok = response.ok && body.status !== 'failed';
    return {
      ok,
      error: ok ? null : (typeof body.error === 'string' ? body.error : `HTTP ${response.status}`),
    };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
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

  /* ------------------------------------------------------ who is asking --- */

  let scopedOwner: string | null = null;
  const presentedSecret = request.headers.get(CRON_SECRET_HEADER);

  if (presentedSecret !== null) {
    if (!secretsMatch(presentedSecret, env('SYNC_CRON_SECRET'))) {
      return json({ error: 'Not authorised' }, 401);
    }
    // The sweep. Everybody's queue.
  } else {
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
    scopedOwner = await requireUser(request.headers, verifyJwt);
    // One answer for every kind of refusal, so probing learns nothing.
    if (!scopedOwner) return json({ error: 'Not authorised' }, 401);
  }

  /* ----------------------------------------------------------- claiming --- */

  let jobs: SyncJob[] = [];
  try {
    const { data, error } = scopedOwner
      ? await client.rpc('claim_sync_jobs_for_owner', { p_owner: scopedOwner, p_limit: BATCH })
      : await client.rpc('claim_sync_jobs', { p_limit: BATCH });
    if (error) throw new Error(error.message);
    jobs = (data ?? []) as SyncJob[];
  } catch (error) {
    const summary = sanitizeError(error);
    safeLog('worker: could not claim jobs', summary);
    return json({ status: 'failed', error: summary }, 500);
  }

  if (jobs.length === 0) {
    return json({ status: 'idle', claimed: 0, succeeded: 0, failed: 0 });
  }

  /* ------------------------------------------------------------ running --- */

  const oauth = oauthClient();
  let succeeded = 0;
  let failed = 0;

  for (const job of jobs) {
    let ok = false;
    let reason: string | null = null;

    try {
      if (job.kind === 'calendar') {
        if (!oauth) {
          reason = 'Google Calendar is not set up on this deployment';
        } else {
          const deps: CalendarSyncDeps = {
            store: storeOver(client),
            refreshFor: (token) => refreshAccessToken(oauth, token),
          };
          const result = await syncOneOwner(deps, job.owner_id);
          // not_connected is not a failure to retry: there is nothing to sync
          // until somebody connects an account, and retrying for days would
          // only fill the log.
          ok = result.status === 'succeeded' || result.status === 'not_connected';
          reason = ok ? null : (result.error ?? 'the calendar sync failed');
        }
      } else {
        const result = await runLeadMirror(job.owner_id);
        ok = result.ok;
        reason = result.error;
      }
    } catch (error) {
      reason = sanitizeError(error);
    }

    /**
     * A job that can never work is closed rather than retried forever.
     *
     * "No spreadsheet is configured for this owner" will be just as true in
     * eight attempts' time. Retrying it would bury the jobs that can succeed.
     */
    const permanent =
      reason === 'no spreadsheet is configured for this owner' ||
      reason === 'the mirror dispatcher is not configured' ||
      reason === 'Google Calendar is not set up on this deployment';

    await client.rpc('finish_sync_job', {
      p_id: job.id,
      p_ok: ok || permanent,
      p_error: ok ? null : reason,
    });

    if (ok) succeeded += 1;
    else failed += 1;
  }

  safeLog(`worker: ${jobs.length} claimed, ${succeeded} succeeded, ${failed} failed`);

  return json({
    status: 'ran',
    claimed: jobs.length,
    succeeded,
    failed,
    scope: scopedOwner ? 'owner' : 'all',
  });
});
