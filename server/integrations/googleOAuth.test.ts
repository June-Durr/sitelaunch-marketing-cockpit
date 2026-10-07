/**
 * The OAuth flow that connects somebody's own Google account.
 *
 * Nothing here reaches the network. The fakes behave the way Google's token
 * endpoint actually behaves in the cases that decide whether a connection keeps
 * working: it omits the refresh token on a reconnection, and it quotes the
 * authorization code back inside a failure body.
 *
 * Every client id, secret and token below is invented.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAuthorizeUrl, CALENDAR_OAUTH_SCOPE, createOAuthState, exchangeAuthorizationCode,
  GOOGLE_AUTH_ENDPOINT, hashOAuthState, oauthErrorCode, refreshAccessToken,
  revokeRefreshToken, safeReturnUrl, STATE_LIFETIME_SECONDS, type OAuthClient,
} from './googleOAuth.ts';
import { CRON_SECRET_HEADER, requireUser } from './requestAuth.ts';

const client: OAuthClient = {
  clientId: '1234567890-abcdefg.apps.googleusercontent.com',
  clientSecret: 'not-a-real-secret',
  redirectUri: 'https://cockpit.example.test/functions/v1/calendar-oauth-callback',
};

/** A token endpoint that records what it was sent. */
function fakeGoogle(reply: {
  status?: number;
  body?: Record<string, unknown>;
}) {
  const sent: { url: string; form: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? '')) });
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

/* ========================================================== 6. the scope === */

describe('it asks for exactly one scope, and it is the narrow one', () => {
  it('requests calendar.events.owned and nothing else', () => {
    expect(CALENDAR_OAUTH_SCOPE)
      .toBe('https://www.googleapis.com/auth/calendar.events.owned');
  });

  it('does not request the full calendar scope, or the wider events scope', () => {
    expect(CALENDAR_OAUTH_SCOPE).not.toBe('https://www.googleapis.com/auth/calendar');
    expect(CALENDAR_OAUTH_SCOPE).not.toBe('https://www.googleapis.com/auth/calendar.events');
  });

  it('sends that one scope on the authorize url', () => {
    const url = new URL(buildAuthorizeUrl({ client, state: 'abc' }));
    expect(url.searchParams.get('scope')).toBe(CALENDAR_OAUTH_SCOPE);
    // One value, not a space separated list that quietly grew.
    expect(url.searchParams.get('scope')?.split(' ')).toHaveLength(1);
  });

  it('asks for no identity scope, so it never learns an address it was not given', () => {
    const url = buildAuthorizeUrl({ client, state: 'abc' });
    for (const identity of ['userinfo.email', 'userinfo.profile', 'openid']) {
      expect(url, `asks for ${identity}`).not.toContain(identity);
    }
  });
});

/* ================================================= the authorize url shape === */

describe('the authorize url is built for a connection that keeps working', () => {
  it('goes to Google and carries the client, the target and the state', () => {
    const url = new URL(buildAuthorizeUrl({ client, state: 'the-state-value' }));
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe(client.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(client.redirectUri);
    expect(url.searchParams.get('state')).toBe('the-state-value');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('asks for offline access, without which a nightly sync cannot work', () => {
    const url = new URL(buildAuthorizeUrl({ client, state: 'abc' }));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('never puts the client secret in a url a browser will follow', () => {
    expect(buildAuthorizeUrl({ client, state: 'abc' })).not.toContain(client.clientSecret);
  });
});

/* ======================================================= 2. the state value === */

describe('the state is unguessable, stored as a hash, and short lived', () => {
  it('turns random bytes into something a query string survives', () => {
    const state = createOAuthState(new Uint8Array(32).fill(7));
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state).not.toContain('=');
    expect(state.length).toBeGreaterThan(30);
  });

  it('gives different bytes different states', () => {
    const a = createOAuthState(Uint8Array.from({ length: 32 }, (_, i) => i));
    const b = createOAuthState(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
    expect(a).not.toBe(b);
  });

  it('stores a sha256 hash, so the table is useless to a reader', async () => {
    const state = createOAuthState(new Uint8Array(32).fill(3));
    const hash = await hashOAuthState(state);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(state);
    // Same input, same hash: the callback has to be able to find the row.
    expect(await hashOAuthState(state)).toBe(hash);
  });

  it('gives two states two different hashes', async () => {
    const one = await hashOAuthState('aaaa');
    const two = await hashOAuthState('aaab');
    expect(one).not.toBe(two);
  });

  it('expires in minutes rather than days', () => {
    // A state good for a day is a replay window good for a day.
    expect(STATE_LIFETIME_SECONDS).toBeLessThanOrEqual(900);
    expect(STATE_LIFETIME_SECONDS).toBeGreaterThanOrEqual(120);
  });
});

/* ===================================================== 3. no open redirects === */

describe('the callback will only send a browser somewhere configured', () => {
  const app = 'https://cockpit.example.test';

  it('sends them to the configured app and nowhere else', () => {
    expect(safeReturnUrl(app, '/data?calendar=connected'))
      .toBe('https://cockpit.example.test/data?calendar=connected');
  });

  it('refuses an absolute url dressed up as a path', () => {
    for (const path of [
      'https://evil.example/steal',
      '//evil.example/steal',
      'http://evil.example',
      'javascript:alert(1)',
      'data:text/html,hi',
    ]) {
      expect(safeReturnUrl(app, path), path).toBeNull();
    }
  });

  it('refuses a path that climbs out of the configured origin', () => {
    // Not reachable through our own call sites, which pass a literal. Asserted
    // because an open redirect on an OAuth callback is how a phishing page
    // borrows somebody's authenticated session.
    expect(safeReturnUrl(app, '/../../other')).toBe('https://cockpit.example.test/other');
    expect(safeReturnUrl(app, 'data')).toBeNull();
  });

  it('refuses to redirect at all when nothing is configured', () => {
    expect(safeReturnUrl(null, '/data')).toBeNull();
    expect(safeReturnUrl('', '/data')).toBeNull();
    expect(safeReturnUrl('not a url', '/data')).toBeNull();
  });

  it('refuses plain http anywhere but localhost', () => {
    expect(safeReturnUrl('http://cockpit.example.test', '/data')).toBeNull();
    expect(safeReturnUrl('http://localhost:5173', '/data'))
      .toBe('http://localhost:5173/data');
  });
});

/* ================================================= 4. nothing secret escapes === */

describe('a failed exchange says what went wrong without quoting the code back', () => {
  it('keeps only Google own error code', () => {
    expect(oauthErrorCode({ error: 'invalid_grant' })).toBe('invalid_grant');
    expect(oauthErrorCode({ error: 'redirect_uri_mismatch' })).toBe('redirect_uri_mismatch');
  });

  it('drops anything that is not shaped like one of those codes', () => {
    for (const body of [
      { error: 'the code 4/0AX4 was already redeemed' },
      { error: 'UPPERCASE' },
      { error: 'with spaces' },
      { error: 42 },
      { error_description: 'invalid_grant' },
      null,
      'invalid_grant',
    ]) {
      expect(oauthErrorCode(body), JSON.stringify(body)).toBeNull();
    }
  });

  it('throws a message carrying no code, no secret and no description', async () => {
    const google = fakeGoogle({
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'Code 4/0AX4-not-a-real-code was already redeemed',
      },
    });

    let message = '';
    try {
      await exchangeAuthorizationCode(client, '4/0AX4-not-a-real-code', google.fetchImpl);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('invalid_grant');
    expect(message).not.toContain('4/0AX4-not-a-real-code');
    expect(message).not.toContain(client.clientSecret);
    expect(message).not.toContain('already redeemed');
  });
});

/* ============================================= the exchange and the refresh === */

describe('exchanging the code happens server side, with the redirect checked', () => {
  it('posts the code, the client and the same redirect uri', async () => {
    const google = fakeGoogle({
      body: {
        access_token: 'not-a-real-access-token',
        refresh_token: 'not-a-real-refresh-token',
        expires_in: 3599,
        scope: CALENDAR_OAUTH_SCOPE,
      },
    });

    const tokens = await exchangeAuthorizationCode(client, 'the-code', google.fetchImpl);

    expect(tokens.accessToken).toBe('not-a-real-access-token');
    expect(tokens.refreshToken).toBe('not-a-real-refresh-token');
    expect(tokens.grantedScopes).toEqual([CALENDAR_OAUTH_SCOPE]);

    const form = google.sent[0].form;
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    // Google checks this matches the authorization, which is a second line of
    // defence against a code stolen in transit.
    expect(form.get('redirect_uri')).toBe(client.redirectUri);
  });

  /**
   * The case that quietly kills a connection six months later.
   *
   * On a reconnection Google often returns an access token and no refresh token,
   * on the grounds that the caller already has one. Reporting that as an empty
   * string or a zero would make the caller overwrite the stored token with
   * nothing, and the nightly sync would never work again.
   */
  it('reports a missing refresh token as null rather than as an empty value', async () => {
    const google = fakeGoogle({
      body: { access_token: 'not-a-real-access-token', expires_in: 3599 },
    });
    const tokens = await exchangeAuthorizationCode(client, 'the-code', google.fetchImpl);
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.grantedScopes).toEqual([]);
  });

  it('refuses a reply with no access token in it at all', async () => {
    const google = fakeGoogle({ body: { refresh_token: 'only-this' } });
    await expect(exchangeAuthorizationCode(client, 'c', google.fetchImpl))
      .rejects.toThrow(/no access token/i);
  });

  it('refreshes with the stored token and asks for no new scopes', async () => {
    const google = fakeGoogle({
      body: { access_token: 'fresh-not-real', expires_in: 3599 },
    });
    const tokens = await refreshAccessToken(client, 'stored-not-real', google.fetchImpl);

    expect(tokens.accessToken).toBe('fresh-not-real');
    const form = google.sent[0].form;
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('stored-not-real');
    // Widening scopes on refresh is not a thing Google does, and asking would
    // only be a lie in the request.
    expect(form.get('scope')).toBeNull();
  });

  it('does not put the refresh token in the message when Google refuses it', async () => {
    const google = fakeGoogle({ status: 400, body: { error: 'invalid_grant' } });
    let message = '';
    try {
      await refreshAccessToken(client, 'stored-not-real', google.fetchImpl);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('invalid_grant');
    expect(message).not.toContain('stored-not-real');
  });
});

/* ================================================== 12. disconnecting safely === */

describe('revoking is best effort, and reports honestly which it was', () => {
  it('tells Google to cancel the token and says it worked', async () => {
    const google = fakeGoogle({ body: {} });
    expect(await revokeRefreshToken('stored-not-real', google.fetchImpl)).toBe(true);
    expect(google.sent[0].form.get('token')).toBe('stored-not-real');
  });

  it('says so rather than throwing when Google cannot be reached', async () => {
    const broken = (async () => {
      throw new Error('network is down');
    }) as unknown as typeof fetch;
    // Forgetting the token locally is what actually stops the Cockpit writing.
    // A network failure on the courteous half must not leave somebody unable to
    // disconnect at all.
    expect(await revokeRefreshToken('stored-not-real', broken)).toBe(false);
  });

  it('says so when Google refuses', async () => {
    const google = fakeGoogle({ status: 400, body: { error: 'invalid_token' } });
    expect(await revokeRefreshToken('stored-not-real', google.fetchImpl)).toBe(false);
  });

  it('never asks Google to delete anything on a calendar', async () => {
    const google = fakeGoogle({ body: {} });
    await revokeRefreshToken('stored-not-real', google.fetchImpl);
    // One request, to the revoke endpoint. Disconnecting touches no event.
    expect(google.sent).toHaveLength(1);
    expect(google.sent[0].url).toContain('oauth2.googleapis.com/revoke');
    expect(google.sent[0].url).not.toContain('calendar');
  });
});

/* ======================= 1. connecting needs a real, signed in person === */

/**
 * Who may start or cancel an authorization.
 *
 * One person, with their own session. Not the scheduler, even though the
 * scheduler is trusted for everything else: connecting a Google account is an act
 * of consent by one particular person, and it decides whose calendar gets written
 * to from then on. A shared secret cannot consent on somebody's behalf.
 */
describe('only a signed in person can start or cancel a connection', () => {
  const OWNER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const verify = async (token: string) => (token === 'good-session' ? OWNER : null);

  it('accepts their own bearer token and returns their owner id', async () => {
    expect(await requireUser({ authorization: 'Bearer good-session' }, verify)).toBe(OWNER);
    // Header names are case insensitive on the wire, and so is this.
    expect(await requireUser({ Authorization: 'bearer good-session' }, verify)).toBe(OWNER);
  });

  it('refuses a request with no session at all', async () => {
    expect(await requireUser({}, verify)).toBeNull();
    expect(await requireUser({ authorization: '' }, verify)).toBeNull();
    expect(await requireUser({ authorization: 'good-session' }, verify)).toBeNull();
    expect(await requireUser({ authorization: 'Basic good-session' }, verify)).toBeNull();
  });

  it('refuses a token the verifier does not recognise', async () => {
    expect(await requireUser({ authorization: 'Bearer forged' }, verify)).toBeNull();
  });

  /**
   * The difference from resolveCaller, written as a test.
   *
   * resolveCaller accepts the cron secret, because a nightly sync has no session.
   * If this ever accepted it too, a caller holding one shared secret could start
   * or cancel an authorization for any owner they could name.
   */
  it('refuses the scheduler shared secret, which cannot consent for anybody', async () => {
    expect(await requireUser({ [CRON_SECRET_HEADER]: 'the-cron-secret' }, verify)).toBeNull();
    expect(
      await requireUser(
        { [CRON_SECRET_HEADER]: 'the-cron-secret', authorization: 'Bearer forged' },
        verify,
      ),
    ).toBeNull();
  });

  it('works with a real Headers object as well as a plain record', async () => {
    const headers = new Headers({ authorization: 'Bearer good-session' });
    expect(await requireUser(headers, verify)).toBe(OWNER);
    expect(await requireUser(new Headers(), verify)).toBeNull();
  });
});
