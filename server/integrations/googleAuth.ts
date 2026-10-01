/**
 * How a sync gets a Google access token, and the seam that lets that change.
 *
 * WHY AN INTERFACE RATHER THAN A FUNCTION
 *
 * This V1 authenticates as SiteLaunch itself, with one service account reading
 * one GA4 property and one Search Console site. That is the right shape for an
 * internal tool and the wrong shape for customers, who will each need to grant
 * access to their own properties through a consent screen.
 *
 * Everything downstream of this file asks for a token and does not care where it
 * came from. Adding customer-facing OAuth later means writing a second
 * implementation of GoogleTokenSource that swaps a stored refresh token for an
 * access token, and changing which one is constructed. The GA4 and Search Console
 * request, mapping, upsert and logging code does not move.
 *
 * WHERE THE CREDENTIAL LIVES
 *
 * In Supabase Edge Function secrets, read at runtime from the environment, held
 * in memory for the life of the request and never written anywhere. It is not in
 * src/, not a VITE_ variable, not in a database table, and not in any committed
 * file. The browser has no path to it: the functions here run server side under
 * the service role, and the only thing the frontend ever sees is a row in
 * integration_connections, which has no token column by design.
 */

/** Read-only scopes. Nothing here may change anything in a Google property. */
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/** The one thing the rest of the integration needs from authentication. */
export interface GoogleTokenSource {
  /** A bearer token good for these scopes. Implementations may cache. */
  getAccessToken(scopes: string[]): Promise<string>;
  /** For display only. Never a secret, and safe to store or show. */
  describe(): string;
}

/** The fields of a Google service account JSON key that we actually use. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/**
 * Pull a service account key out of an environment value.
 *
 * Accepts the raw JSON of the key file, or that JSON base64 encoded, because
 * pasting a multi-line PEM into a secret field mangles the newlines often enough
 * that base64 is worth supporting. Escaped \n inside the PEM is repaired, which
 * is the single most common way this credential arrives broken.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') throw new Error('Service account key is empty');

  let text = trimmed;
  if (!text.startsWith('{')) {
    try {
      text = atob(text);
    } catch {
      throw new Error('Service account key is neither JSON nor base64 JSON');
    }
  }

  let parsed: Partial<ServiceAccountKey>;
  try {
    parsed = JSON.parse(text) as Partial<ServiceAccountKey>;
  } catch {
    // Deliberately does not echo the text back: it is the credential.
    throw new Error('Service account key is not valid JSON');
  }

  const email = parsed.client_email;
  const key = parsed.private_key;
  if (!email || typeof email !== 'string') {
    throw new Error('Service account key has no client_email');
  }
  if (!key || typeof key !== 'string') {
    throw new Error('Service account key has no private_key');
  }

  return {
    client_email: email,
    private_key: key.includes('\\n') ? key.replace(/\\n/g, '\n') : key,
    token_uri: typeof parsed.token_uri === 'string' ? parsed.token_uri : undefined,
  };
}

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Refresh this long before expiry, so a token cannot die mid-request. */
const EXPIRY_MARGIN_SECS = 60;

/**
 * Signs a JWT with the service account key and trades it for an access token.
 *
 * This is the documented two-legged OAuth flow for server to server access. No
 * user is involved, so there is no consent screen and no refresh token: the
 * signed assertion is the credential, and it is minted fresh each time.
 */
export class ServiceAccountTokenSource implements GoogleTokenSource {
  private readonly key: ServiceAccountKey;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number; scopeKey: string } | null = null;

  constructor(
    key: ServiceAccountKey,
    options: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    this.key = key;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  describe(): string {
    return this.key.client_email;
  }

  async getAccessToken(scopes: string[]): Promise<string> {
    const scopeKey = [...scopes].sort().join(' ');
    const nowSecs = Math.floor(this.now() / 1000);

    if (this.cached && this.cached.scopeKey === scopeKey && this.cached.expiresAt > nowSecs) {
      return this.cached.token;
    }

    const tokenUri = this.key.token_uri ?? DEFAULT_TOKEN_URI;
    const assertion = await this.signAssertion(scopeKey, tokenUri, nowSecs);

    const response = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });

    if (!response.ok) {
      // The body echoes the assertion back on failure, so it is never included.
      throw new Error(`Google refused the service account credentials (HTTP ${response.status})`);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('Google returned no access token');

    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.cached = {
      token: body.access_token,
      expiresAt: nowSecs + Math.max(0, lifetime - EXPIRY_MARGIN_SECS),
      scopeKey,
    };
    return body.access_token;
  }

  private async signAssertion(scope: string, audience: string, nowSecs: number): Promise<string> {
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: this.key.client_email,
      scope,
      aud: audience,
      iat: nowSecs,
      exp: nowSecs + 3600,
    };

    const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
    const cryptoKey = await importPrivateKey(this.key.private_key);
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(unsigned),
    );
    return `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
  }
}

/**
 * PKCS#8 PEM to a Web Crypto key. Works the same in Deno and in Node 18 or newer.
 *
 * The return type is inferred rather than written as CryptoKey, because that name
 * is a DOM type and this file is compiled without the DOM lib so it can also run
 * on Deno.
 */
async function importPrivateKey(pem: string) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (body === '') throw new Error('Service account private key is not a PEM block');

  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    throw new Error('Service account private key is not valid base64');
  }

  return crypto.subtle.importKey(
    'pkcs8',
    raw.buffer as ArrayBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function base64Url(text: string): string {
  return base64UrlBytes(new TextEncoder().encode(text));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
