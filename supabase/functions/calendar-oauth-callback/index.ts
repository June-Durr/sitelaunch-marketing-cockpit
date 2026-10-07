/**
 * Where Google sends somebody back after they approve the calendar connection.
 *
 * WHY THIS ONE HAS NO PLATFORM JWT CHECK
 *
 * Google redirects a browser here. That request carries Google's code and state
 * and no Supabase session, so platform JWT verification would reject every real
 * callback before the function ran. The function therefore does its own check,
 * and it does it before touching anything: the state is consumed first, and a
 * state that is forged, replayed, expired or unknown ends the request with no
 * database write and no token exchange.
 *
 * Note which way round that is. The state is not a convenience for finding the
 * owner; it IS the authentication. It was issued to one signed in person, it is
 * stored only as a hash, and it can be spent exactly once.
 *
 * WHERE THE BROWSER GOES AFTERWARDS
 *
 * To one configured address and nowhere else. Nothing in the request chooses a
 * destination, because an OAuth callback that redirects wherever it is told is an
 * open redirect, and an open redirect here is how a phishing page borrows
 * somebody's authenticated session.
 */

import {
  exchangeAuthorizationCode, hashOAuthState, safeReturnUrl, type OAuthClient,
} from '../../../server/integrations/googleOAuth.ts';
import { CALENDAR_OAUTH_SCOPE } from '../../../server/integrations/googleOAuth.ts';
import { sanitizeError, safeLog } from '../../../server/integrations/sanitize.ts';
import { createServiceClient } from '../_shared/supabaseStore.ts';
import { consumeOAuthState, storeRefreshToken } from '../_shared/calendarOAuthStore.ts';

const PROVIDER = 'google_calendar' as const;

/** Where the Cockpit shows the result. A path, never taken from the request. */
const RETURN_PATH = '/data';

function env(name: string): string | null {
  const value = Deno.env.get(name);
  return value === undefined || value.trim() === '' ? null : value;
}

/**
 * Send the browser home with a one word outcome.
 *
 * The word is from a fixed set, so nothing Google or a caller supplied can travel
 * in the address bar. When no return address is configured the result is said in
 * plain text instead, because redirecting somewhere unverified would be worse
 * than not redirecting at all.
 */
function finish(outcome: 'connected' | 'refused' | 'failed'): Response {
  const target = safeReturnUrl(
    env('COCKPIT_APP_URL'),
    `${RETURN_PATH}?calendar=${outcome}`,
  );

  if (!target) {
    return new Response(
      outcome === 'connected'
        ? 'Google Calendar is connected. You can close this tab and return to the Cockpit.'
        : 'The calendar connection did not complete. Return to the Cockpit and try again.',
      { status: outcome === 'connected' ? 200 : 400, headers: { 'content-type': 'text/plain' } },
    );
  }
  return new Response(null, { status: 303, headers: { location: target } });
}

function oauthClient(): OAuthClient | null {
  const clientId = env('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = env('GOOGLE_OAUTH_CLIENT_SECRET');
  const redirectUri = env('GOOGLE_OAUTH_REDIRECT_URI');
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

Deno.serve(async (request: Request): Promise<Response> => {
  // Google sends a browser here, which is a GET.
  if (request.method !== 'GET') {
    return new Response('Use GET', { status: 405 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const googleError = url.searchParams.get('error');

  /**
   * The person pressed Cancel, or Google refused.
   *
   * Nothing to validate and nothing to store. Their reason is not echoed back:
   * it arrived in a query string anybody can write.
   */
  if (googleError) {
    safeLog('calendar oauth callback: the authorization was refused');
    return finish('refused');
  }

  if (!code || !state) {
    safeLog('calendar oauth callback: missing code or state');
    return finish('failed');
  }

  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const oauth = oauthClient();
  if (!supabaseUrl || !serviceRoleKey || !oauth) {
    safeLog('calendar oauth callback: function is not configured');
    return finish('failed');
  }

  const client = createServiceClient(supabaseUrl, serviceRoleKey);

  try {
    /**
     * Spend the state before anything else happens.
     *
     * One conditional update decides owner, freshness and single use together.
     * A forged state, a replayed one, an expired one and one that never existed
     * all come back the same way, which is both correct and all anybody probing
     * gets to learn.
     */
    const ownerId = await consumeOAuthState(client, await hashOAuthState(state));
    if (!ownerId) {
      safeLog('calendar oauth callback: the state was not valid, unused and current');
      return finish('failed');
    }

    const tokens = await exchangeAuthorizationCode(oauth, code, fetch);

    /**
     * Google does not always return a refresh token on a reconnection.
     *
     * Writing a null over the stored one would turn a working connection into one
     * that can never refresh again, so the store keeps what it has and says so.
     * If there is no token on either side there is nothing to schedule a sync
     * with, and calling that connected would be a lie the Today screen would then
     * repeat.
     */
    const outcome = await storeRefreshToken(client, ownerId, tokens.refreshToken);
    if (outcome === 'no_token') {
      safeLog('calendar oauth callback: Google returned no refresh token and none was held');
      await client.from('integration_connections').upsert(
        {
          owner_id: ownerId,
          provider: PROVIDER,
          status: 'error',
          error_message:
            'Google did not return a refresh token, so scheduled syncing is not possible. '
            + 'Disconnect and connect again, and approve the request when Google asks.',
          error_at: new Date().toISOString(),
        },
        { onConflict: 'owner_id,provider', ignoreDuplicates: false },
      );
      return finish('failed');
    }

    const granted = tokens.grantedScopes.length > 0
      ? tokens.grantedScopes
      : [CALENDAR_OAUTH_SCOPE];

    await client.from('integration_connections').upsert(
      {
        owner_id: ownerId,
        provider: PROVIDER,
        // The destination, said the way the screen says it. Not a secret, and
        // not a calendar id anybody has to copy.
        provider_account_id: 'primary',
        // Filled in from the first synced event, which is the only place the
        // address appears without asking Google for the identity scopes.
        display_name: null,
        granted_scopes: granted,
        status: 'connected',
        connected_at: new Date().toISOString(),
        error_message: null,
        error_at: null,
      },
      { onConflict: 'owner_id,provider', ignoreDuplicates: false },
    );

    safeLog(`calendar oauth callback: connected, token ${outcome}`);
    return finish('connected');
  } catch (error) {
    // sanitizeError strips tokens and key material; the code and the client
    // secret never reach a log through this path.
    safeLog('calendar oauth callback: failed', sanitizeError(error));
    return finish('failed');
  }
});
