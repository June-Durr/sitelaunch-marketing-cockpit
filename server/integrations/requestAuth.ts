/**
 * Who is allowed to start a sync, and whose data it runs against.
 *
 * Two callers exist and they arrive differently. A person pressing Sync now in
 * the Cockpit sends their Supabase session, and the sync must run against that
 * person and nobody else. The scheduler has no session at all, so it presents a
 * shared secret and the owner it may act for is fixed in configuration rather
 * than taken from the request.
 *
 * WHY THE OWNER IS NEVER READ FROM THE BODY
 *
 * An owner id in a request body is a request to write into someone else's rows.
 * The owner here comes from a verified JWT or from server configuration, never
 * from anything the caller can type, which is what keeps owner isolation true
 * even though the sync itself runs with the service role and bypasses RLS.
 */

/** Header the scheduler presents instead of a user session. */
export const CRON_SECRET_HEADER = 'x-sync-cron-secret';

export interface AuthEnv {
  /** Shared secret the scheduler sends. Null disables scheduled invocation. */
  cronSecret: string | null;
  /** The owner scheduled runs act for. Null disables scheduled invocation. */
  cronOwnerId: string | null;
}

/** Verifies a Supabase access token and returns the user id, or null. */
export type JwtVerifier = (token: string) => Promise<string | null>;

export interface ResolvedCaller {
  ownerId: string;
  via: 'user' | 'cron';
}

/** Length-independent comparison, so a wrong secret leaks nothing by timing. */
export function secretsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Compare a fixed number of bytes either way, then require equal lengths.
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

function headerValue(headers: Headers | Record<string, string>, name: string): string | null {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string>;
  const match = Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase());
  return match ? record[match] : null;
}

/**
 * Decide who this request acts for, or refuse it.
 *
 * Returns null rather than throwing, because every refusal is the same 401 to the
 * caller and distinguishing them in the response would describe the auth setup to
 * whoever is probing it.
 */
export async function resolveCaller(
  headers: Headers | Record<string, string>,
  env: AuthEnv,
  verifyJwt: JwtVerifier,
): Promise<ResolvedCaller | null> {
  const presented = headerValue(headers, CRON_SECRET_HEADER);
  if (presented !== null) {
    if (!env.cronSecret || !env.cronOwnerId) return null;
    if (!secretsMatch(presented, env.cronSecret)) return null;
    return { ownerId: env.cronOwnerId, via: 'cron' };
  }

  const authorization = headerValue(headers, 'authorization');
  if (!authorization) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;

  const userId = await verifyJwt(match[1]);
  return userId ? { ownerId: userId, via: 'user' } : null;
}

/**
 * The owner of a real user session, and nothing else.
 *
 * WHY THIS IS NOT resolveCaller
 *
 * resolveCaller deliberately accepts the scheduler's shared secret as well as a
 * person's session, because a nightly sync has no session. Connecting a Google
 * account is the opposite situation: it is an act of consent by one particular
 * person, and it decides whose calendar gets written to forever afterwards. A
 * shared secret cannot consent on somebody's behalf, and a caller holding one
 * must not be able to start or cancel an authorization for an arbitrary owner.
 *
 * So this path takes a Bearer token and only a Bearer token. A request carrying
 * the cron header gets exactly the same refusal as a request carrying nothing.
 */
export async function requireUser(
  headers: Headers | Record<string, string>,
  verifyJwt: JwtVerifier,
): Promise<string | null> {
  const authorization = headerValue(headers, 'authorization');
  if (!authorization) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;

  return verifyJwt(match[1]);
}
