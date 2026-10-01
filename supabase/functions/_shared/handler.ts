/**
 * The HTTP shell both sync functions share.
 *
 * Reads configuration, works out who is asking, picks the window, runs the sync
 * and answers with a summary. The summary is deliberately thin: counts, a status
 * and a sanitized error. Nothing that came out of a credential reaches the
 * response, because the response reaches a browser.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

import {
  parseServiceAccountKey, ServiceAccountTokenSource, type GoogleTokenSource,
} from '../../../server/integrations/googleAuth.ts';
import { sanitizeError, safeLog } from '../../../server/integrations/sanitize.ts';
import { runSync, type SyncStore } from '../../../server/integrations/syncRunner.ts';
import {
  backfillWindow, dailyWindow, idempotencyKey,
} from '../../../server/integrations/syncWindow.ts';
import { resolveCaller } from '../../../server/integrations/requestAuth.ts';
import type { DateWindow, IntegrationProvider } from '../../../server/integrations/types.ts';
import {
  createServiceClient, ensureConnection, markConnectionError, markConnectionSynced,
  SupabaseSyncStore,
} from './supabaseStore.ts';

export type SyncMode = 'daily' | 'backfill' | 'manual';

interface RequestBody {
  mode?: SyncMode;
  start?: string;
  end?: string;
}

function env(name: string): string | null {
  const value = Deno.env.get(name);
  return value === undefined || value.trim() === '' ? null : value;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Browsers preflight the Sync now call, so the function has to answer OPTIONS. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-sync-cron-secret',
  'access-control-allow-methods': 'POST, OPTIONS',
};

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS)) response.headers.set(key, value);
  return response;
}

export interface SyncHandlerConfig<Row extends { date: string }> {
  provider: IntegrationProvider;
  /** The GA4 property id or the Search Console site url. Not a secret. */
  accountId: string | null;
  scopes: string[];
  fetchRows: (tokenSource: GoogleTokenSource, window: DateWindow) => Promise<Row[]>;
  writeRows: (
    store: SyncStore, ownerId: string, connectionId: string | null, rows: Row[],
  ) => Promise<number>;
}

export async function handleSyncRequest<Row extends { date: string }>(
  request: Request,
  config: SyncHandlerConfig<Row>,
): Promise<Response> {
  if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
  if (request.method !== 'POST') return withCors(json({ error: 'Use POST' }, 405));

  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return withCors(json({ error: 'Function is not configured' }, 500));
  }

  // Verifying the caller's token is done with the anon client, so a forged token
  // cannot borrow the service role's authority.
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

  const caller = await resolveCaller(request.headers, {
    cronSecret: env('SYNC_CRON_SECRET'),
    cronOwnerId: env('SYNC_OWNER_ID'),
  }, verifyJwt);

  // One answer for every kind of refusal, so probing learns nothing.
  if (!caller) return withCors(json({ error: 'Not authorised' }, 401));

  if (!config.accountId) {
    return withCors(json({ error: `${config.provider} is not configured` }, 500));
  }

  let body: RequestBody = {};
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    // An empty body means a daily run, which is what the scheduler sends.
  }

  const now = new Date();
  const mode: SyncMode = body.mode ?? 'daily';
  let window: DateWindow | null;
  if (mode === 'backfill') {
    window = backfillWindow(now);
  } else if (mode === 'manual' && body.start && body.end) {
    window = { start: body.start, end: body.end };
  } else {
    window = dailyWindow(now);
  }

  if (!window) {
    return withCors(json({ status: 'skipped', reason: 'Nothing complete to fetch yet' }));
  }

  const client = createServiceClient(supabaseUrl, serviceRoleKey);
  const store = new SupabaseSyncStore(client);

  let tokenSource: GoogleTokenSource;
  try {
    const rawKey = env('GOOGLE_SERVICE_ACCOUNT_KEY');
    if (!rawKey) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
    tokenSource = new ServiceAccountTokenSource(parseServiceAccountKey(rawKey));
  } catch (error) {
    const summary = sanitizeError(error);
    safeLog(`${config.provider}: credentials unusable`, summary);
    await markConnectionError(client, caller.ownerId, config.provider as 'ga4', summary);
    return withCors(json({ status: 'failed', error: summary }, 500));
  }

  let connectionId: string | null = null;
  try {
    connectionId = await ensureConnection(
      client, caller.ownerId, config.provider as 'ga4',
      config.accountId, tokenSource.describe(), config.scopes,
    );
  } catch (error) {
    // A missing connection row is not a reason to skip the sync itself.
    safeLog(`${config.provider}: could not record the connection`, sanitizeError(error));
  }

  const result = await runSync<Row>({
    ownerId: caller.ownerId,
    connectionId,
    provider: config.provider,
    idempotencyKey: idempotencyKey(config.provider, mode, window),
    window,
    now,
    store,
    fetchRows: (w) => config.fetchRows(tokenSource, w),
    writeRows: (rows) => config.writeRows(store, caller.ownerId, connectionId, rows),
  });

  if (result.status === 'failed') {
    await markConnectionError(
      client, caller.ownerId, config.provider as 'ga4', result.errorSummary ?? 'Sync failed',
    );
  } else if (result.status === 'succeeded') {
    await markConnectionSynced(client, caller.ownerId, config.provider as 'ga4');
  }

  safeLog(
    `${config.provider}: ${result.status} ${window.start}..${window.end}`,
    `read=${result.rowsRead} written=${result.rowsWritten} via=${caller.via}`,
  );

  return withCors(json({
    provider: config.provider,
    status: result.status,
    window,
    rowsRead: result.rowsRead,
    rowsWritten: result.rowsWritten,
    error: result.errorSummary,
  }, result.status === 'failed' ? 502 : 200));
}
