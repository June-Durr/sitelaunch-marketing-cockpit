/**
 * Connecting a person's own Google account, so the Cockpit can put follow-ups on
 * their own calendar.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SERVICE ACCOUNT
 *
 * GA4, Search Console and the Sheet mirror are SiteLaunch's own properties, read
 * and written by SiteLaunch's own service account. A person's calendar is not
 * SiteLaunch's property. Using the service account for it would mean either
 * asking everybody to share a calendar with a robot they have never heard of, or
 * domain-wide delegation, which hands one credential the right to read every
 * calendar in an organisation. Neither is a reasonable thing to ask of a
 * customer, so the calendar uses the customer's own authorization and nothing
 * else.
 *
 * WHAT IS ASKED FOR, AND WHAT IS NOT
 *
 * One scope: calendar.events.owned. It permits creating and changing events on
 * calendars the person owns, and nothing else. It cannot list their calendars,
 * cannot read anybody else's, and cannot touch sharing or calendar settings. The
 * full `calendar` scope is deliberately not requested.
 *
 * WHERE THE SECRETS LIVE
 *
 * Nowhere in here. Every function takes its client credentials as arguments, and
 * the only caller is an Edge Function reading them from its own environment. No
 * token is ever returned to a browser, written to a readable table, or logged.
 */

/**
 * See, create, change and delete events on calendars this person owns.
 *
 * Deliberately not `auth/calendar`, which also grants creating, deleting and
 * re-sharing whole calendars, and not `calendar.events`, which extends to
 * calendars somebody merely has write access to. Owned events is the smallest
 * scope that can put an entry on the person's own primary calendar.
 */
export const CALENDAR_OAUTH_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/** How long an unused authorization attempt stays valid. */
export const STATE_LIFETIME_SECONDS = 600;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  /** Must match an Authorized redirect URI on the Google client, exactly. */
  redirectUri: string;
}

/* ----------------------------------------------------------------- the state --- */

/**
 * A fresh, unguessable state value.
 *
 * 32 bytes from the platform's cryptographic generator, base64url encoded so it
 * survives a query string untouched. This is the value Google hands back; what is
 * stored is its hash, so a leak of the database does not hand somebody a working
 * state.
 */
export function createOAuthState(randomBytes: Uint8Array): string {
  let binary = '';
  for (const byte of randomBytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * What gets stored for a state value.
 *
 * WHY A HASH RATHER THAN THE VALUE
 *
 * The state is a bearer value for the few minutes it lives: anybody holding it
 * could complete somebody else's authorization. Storing only its hash means the
 * row is useless to anyone who reads the table, exactly as with a password.
 *
 * WHY STORING IT AT ALL BEATS SIGNING IT
 *
 * A signature proves a state was issued by us and nothing more. It cannot say
 * whether it has already been used, and a replayed callback is the attack that
 * matters here. A row can be consumed exactly once, which a signature can never
 * be, so the stored nonce is the stronger of the two rather than a shortcut past
 * it.
 */
export async function hashOAuthState(state: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(state),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/* ---------------------------------------------------------- the authorize url --- */

export interface AuthorizeUrlInput {
  client: OAuthClient;
  state: string;
}

/**
 * Where to send somebody to approve this.
 *
 * access_type=offline is what makes a refresh token possible at all, and without
 * one a scheduled sync could only work while somebody happened to be signed in
 * minutes earlier. prompt=consent makes Google return a refresh token on every
 * authorization rather than only the first, which is what stops a reconnection
 * silently producing a connection that cannot refresh. The code still handles
 * Google omitting it, because relying on a prompt parameter for correctness is
 * how a connection quietly dies six months later.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.client.clientId,
    redirect_uri: input.client.redirectUri,
    response_type: 'code',
    scope: CALENDAR_OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: input.state,
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/* --------------------------------------------------------------- redirecting --- */

/**
 * Is this somewhere we are willing to send a browser after the callback?
 *
 * The answer never comes from the request. Google's callback carries a code and a
 * state and nothing else that decides a destination, so the only acceptable
 * target is the one configured for this deployment. An app that takes its
 * post-login destination from a parameter is an open redirect, and an open
 * redirect on an OAuth callback is how a phishing page borrows somebody's
 * authenticated session.
 */
export function safeReturnUrl(configuredAppUrl: string | null, path: string): string | null {
  if (!configuredAppUrl) return null;

  let base: URL;
  try {
    base = new URL(configuredAppUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' && base.hostname !== 'localhost') return null;

  // A path, never a URL. Anything with a scheme or a host is refused outright.
  if (!path.startsWith('/') || path.startsWith('//')) return null;

  const target = new URL(path, base);
  if (target.origin !== base.origin) return null;
  return target.toString();
}

/* ------------------------------------------------------------ exchanging code --- */

export interface TokenResponse {
  accessToken: string;
  /** Absent when Google decides the caller already has one. */
  refreshToken: string | null;
  expiresInSeconds: number;
  grantedScopes: string[];
}

interface RawTokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Google's error, reduced to the part that is safe to keep.
 *
 * The body of a failed token exchange quotes back the code, and on some failures
 * the client secret's prefix. Only the `error` field is kept, and only when it
 * looks like one of Google's fixed codes, so nothing free-form can travel with it.
 */
export function oauthErrorCode(body: unknown): string | null {
  const error = (body as RawTokenBody | null)?.error;
  if (typeof error !== 'string') return null;
  return /^[a-z][a-z0-9_]{2,40}$/.test(error) ? error : null;
}

function readTokenBody(body: RawTokenBody): TokenResponse {
  if (!body.access_token) throw new Error('Google returned no access token');
  return {
    accessToken: body.access_token,
    // Null, not undefined and not an empty string: "Google did not send one" is
    // a specific fact the caller has to act on by keeping the one it already has.
    refreshToken: body.refresh_token ?? null,
    expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : 3600,
    grantedScopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
  };
}

async function postForm(
  endpoint: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; body: RawTokenBody }> {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

  let body: RawTokenBody = {};
  try {
    body = (await response.json()) as RawTokenBody;
  } catch {
    body = {};
  }
  return { ok: response.ok, status: response.status, body };
}

/** Trade the one-time code for tokens. Server side only, by definition. */
export async function exchangeAuthorizationCode(
  client: OAuthClient,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const result = await postForm(
    GOOGLE_TOKEN_ENDPOINT,
    {
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      // Google checks this matches the one the authorization used, which is a
      // second line of defence against a code stolen in transit.
      redirect_uri: client.redirectUri,
      grant_type: 'authorization_code',
    },
    fetchImpl,
  );

  if (!result.ok) {
    const code = oauthErrorCode(result.body);
    throw new Error(
      `Google refused the authorization (HTTP ${result.status})${code ? `: ${code}` : ''}`,
    );
  }
  return readTokenBody(result.body);
}

/** Turn a stored refresh token into a short lived access token. */
export async function refreshAccessToken(
  client: OAuthClient,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const result = await postForm(
    GOOGLE_TOKEN_ENDPOINT,
    {
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: 'refresh_token',
    },
    fetchImpl,
  );

  if (!result.ok) {
    const code = oauthErrorCode(result.body);
    throw new Error(
      `Google refused the stored authorization (HTTP ${result.status})${code ? `: ${code}` : ''}`,
    );
  }
  return readTokenBody(result.body);
}

/**
 * Tell Google the person has disconnected.
 *
 * Best effort on purpose. Forgetting the token on this side is what actually
 * matters and happens either way; telling Google as well is the courteous half,
 * and a network failure on it must not leave somebody unable to disconnect.
 * Returns whether it worked so the caller can say so honestly.
 */
export async function revokeRefreshToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}
