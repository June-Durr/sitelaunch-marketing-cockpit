/**
 * The database side of connecting somebody's Google account.
 *
 * Every function here runs under the service role, which is the only role
 * migration 0010 grants these helpers to. A refresh token passes through this
 * file and goes nowhere else: not into a response, not into a log, not onto
 * integration_connections.
 *
 * WHY THESE ARE ALL rpc CALLS
 *
 * Because the rules they enforce are properties of a SQL statement rather than of
 * a caller. Spending a state exactly once is one conditional update that Postgres
 * serialises; doing it as a read and then a write would leave a window in which
 * two callbacks arriving together both succeed, and no amount of care out here
 * closes that window. Keeping the rules in migration 0010 also means they are
 * tested against a real Postgres rather than against a mock written to agree
 * with them.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { STATE_LIFETIME_SECONDS } from '../../../server/integrations/googleOAuth.ts';

/* ------------------------------------------------------------------ the state --- */

/** Record an authorization this owner has just started. */
export async function issueOAuthState(
  client: SupabaseClient,
  ownerId: string,
  stateHash: string,
): Promise<void> {
  const { error } = await client.rpc('calendar_oauth_issue_state', {
    p_owner: ownerId,
    p_state_hash: stateHash,
    p_lifetime_seconds: STATE_LIFETIME_SECONDS,
  });

  if (error) throw new Error(`could not record the authorization: ${error.message}`);
}

/**
 * Spend a state exactly once, and say whose it was.
 *
 * Null covers forged, replayed, expired and never issued, and deliberately does
 * not distinguish them. They are all "no", and telling them apart would describe
 * this table to whoever is probing it.
 */
export async function consumeOAuthState(
  client: SupabaseClient,
  stateHash: string,
): Promise<string | null> {
  const { data, error } = await client.rpc('calendar_oauth_consume_state', {
    p_state_hash: stateHash,
  });

  if (error) throw new Error(`could not check the authorization: ${error.message}`);
  return (data as string | null) ?? null;
}

/** Throw away states that are no longer any use. Housekeeping, not correctness. */
export async function pruneOAuthStates(client: SupabaseClient): Promise<number> {
  const { data, error } = await client.rpc('calendar_oauth_prune_states', {
    p_older_than_seconds: STATE_LIFETIME_SECONDS,
  });
  if (error) return 0;
  return typeof data === 'number' ? data : 0;
}

/* ----------------------------------------------------------------- the tokens --- */

export type StoreTokenOutcome = 'stored' | 'replaced' | 'kept_existing' | 'no_token';

/**
 * Keep this owner's refresh token, or keep the one already held.
 *
 * Passing null is normal rather than exceptional: on a reconnection Google often
 * returns an access token and no refresh token, and the right answer is to leave
 * the stored one alone. The outcome says which happened so the caller can refuse
 * to call a connection healthy when there is no token behind it at all.
 */
export async function storeRefreshToken(
  client: SupabaseClient,
  ownerId: string,
  refreshToken: string | null,
): Promise<StoreTokenOutcome> {
  const { data, error } = await client.rpc('calendar_oauth_store_token', {
    p_owner: ownerId,
    p_refresh_token: refreshToken,
  });

  if (error) throw new Error(`could not store the authorization: ${error.message}`);
  return (data as StoreTokenOutcome) ?? 'no_token';
}

/** This owner's refresh token, or null. Never returned to a browser. */
export async function readRefreshToken(
  client: SupabaseClient,
  ownerId: string,
): Promise<string | null> {
  const { data, error } = await client.rpc('calendar_oauth_read_token', {
    p_owner: ownerId,
  });

  if (error) throw new Error(`could not read the authorization: ${error.message}`);
  return (data as string | null) ?? null;
}

/**
 * Forget this owner's token, and hand it back once so it can be revoked.
 *
 * The return value is the only moment this value is allowed out of the database,
 * and the caller's only legitimate use for it is telling Google to cancel it.
 */
export async function forgetRefreshToken(
  client: SupabaseClient,
  ownerId: string,
): Promise<string | null> {
  const { data, error } = await client.rpc('calendar_oauth_forget_token', {
    p_owner: ownerId,
  });

  if (error) throw new Error(`could not disconnect: ${error.message}`);
  return (data as string | null) ?? null;
}

/** Every owner with a stored token. What the scheduled run iterates. */
export async function connectedOwners(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client.rpc('calendar_oauth_owners');
  if (error) throw new Error(`could not list connections: ${error.message}`);

  // The function returns a set of rows, so the client hands back an array of
  // objects rather than an array of ids.
  const rows = (data ?? []) as ({ owner_id: string } | string)[];
  return rows.map((row) => (typeof row === 'string' ? row : row.owner_id));
}
