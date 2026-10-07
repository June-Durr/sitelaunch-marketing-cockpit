/**
 * Starting and ending a person's Google Calendar connection.
 *
 * Two things, both requiring that person's own session:
 *
 *   {"action":"start"}       Returns the Google URL to send them to.
 *   {"action":"disconnect"}  Forgets their token, tells Google, marks the
 *                            connection disconnected.
 *
 * WHY A SESSION AND NOT THE CRON SECRET
 *
 * Connecting a Google account is consent by one particular person, and it decides
 * whose calendar gets written to from then on. The scheduler's shared secret
 * cannot consent on anybody's behalf, so requireUser accepts a Bearer token and
 * nothing else. A request carrying the cron header is refused exactly as one
 * carrying nothing is.
 *
 * WHAT NEVER LEAVES
 *
 * The client secret and the refresh token. The response carries a URL to Google,
 * a status, and sanitized text. Nothing else.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

import { sanitizeError, safeLog } from '../../../server/integrations/sanitize.ts';
import { requireUser } from '../../../server/integrations/requestAuth.ts';
import {
  buildAuthorizeUrl, createOAuthState, hashOAuthState, revokeRefreshToken,
  type OAuthClient,
} from '../../../server/integrations/googleOAuth.ts';
import { createServiceClient, markConnectionError } from '../_shared/supabaseStore.ts';
import {
  forgetRefreshToken, issueOAuthState, pruneOAuthStates,
} from '../_shared/calendarOAuthStore.ts';

const PROVIDER = 'google_calendar' as const;

function env(name: string): string | null {
  const value = Deno.env.get(name);
  return value === undefined || value.trim() === '' ? null : value;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
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

  // Verified with the anon client, so a forged token cannot borrow the service
  // role's authority.
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

  const ownerId = await requireUser(request.headers, verifyJwt);
  if (!ownerId) return json({ error: 'Not authorised' }, 401);

  let body: { action?: 'start' | 'disconnect' } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const action = body.action ?? 'start';

  const client = createServiceClient(supabaseUrl, serviceRoleKey);

  /* ---------------------------------------------------------- disconnect --- */

  if (action === 'disconnect') {
    try {
      /**
       * Forget first, tell Google second.
       *
       * If the revoke call fails the person is still disconnected here, which is
       * what they asked for. Doing it the other way round would mean a network
       * blip could leave somebody unable to disconnect at all.
       *
       * No calendar event is touched. Events the Cockpit created stay exactly
       * where they are: somebody may have planned their week around them, and
       * removing them because a connection ended is not this app's decision.
       */
      const token = await forgetRefreshToken(client, ownerId);
      const revoked = token ? await revokeRefreshToken(token) : false;

      await client
        .from('integration_connections')
        .update({
          status: 'not_configured',
          display_name: null,
          granted_scopes: [],
          connected_at: null,
          error_message: null,
          error_at: null,
        })
        .eq('owner_id', ownerId)
        .eq('provider', PROVIDER);

      safeLog(`calendar oauth: disconnected, revoked=${revoked}`);
      return json({
        status: 'disconnected',
        // Said plainly rather than implied: a failed revoke still leaves them
        // disconnected here, and they may want to remove the app at Google too.
        revokedAtGoogle: revoked,
        eventsRemoved: false,
      });
    } catch (error) {
      const summary = sanitizeError(error);
      safeLog('calendar oauth: disconnect failed', summary);
      return json({ status: 'failed', error: summary }, 500);
    }
  }

  /* --------------------------------------------------------------- start --- */

  const oauth = oauthClient();
  if (!oauth) {
    return json(
      {
        status: 'not_configured',
        error:
          'Connecting a Google account needs an OAuth client. Set '
          + 'GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and '
          + 'GOOGLE_OAUTH_REDIRECT_URI as Edge Function secrets.',
      },
      503,
    );
  }

  try {
    // Housekeeping, not correctness: consuming a state is what makes it one use.
    await pruneOAuthStates(client);

    const state = createOAuthState(crypto.getRandomValues(new Uint8Array(32)));
    await issueOAuthState(client, ownerId, await hashOAuthState(state));

    return json({
      status: 'ready',
      authorizeUrl: buildAuthorizeUrl({ client: oauth, state }),
    });
  } catch (error) {
    const summary = sanitizeError(error);
    safeLog('calendar oauth: could not start', summary);
    await markConnectionError(client, ownerId, PROVIDER, summary);
    return json({ status: 'failed', error: summary }, 500);
  }
});
