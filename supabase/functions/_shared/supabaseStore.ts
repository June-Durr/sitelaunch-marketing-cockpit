/**
 * The SyncStore that actually writes to Postgres.
 *
 * Runs under the service role, which bypasses row level security. That is the
 * only way a scheduled job with no user session can write at all, and it is also
 * why owner_id is set explicitly on every single row here rather than left to the
 * auth.uid() default: with the service role there is no auth.uid(), so a row that
 * did not carry an owner would be rejected or, worse, mis-owned.
 *
 * Every write is an upsert against the unique constraints from migration 0005.
 * There is no delete anywhere in this file, on purpose: a provider omitting a row
 * is not evidence that the row is wrong.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import type { Ga4DailyRow, SearchConsoleDailyRow } from '../../../server/integrations/analytics.ts';
import type { SyncRunRecord, SyncStore } from '../../../server/integrations/syncRunner.ts';
import type { IntegrationProvider } from '../../../server/integrations/types.ts';

/** Kept well under any statement size limit, and small enough to retry cheaply. */
const CHUNK = 500;

function chunked<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export function createServiceClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export class SupabaseSyncStore implements SyncStore {
  constructor(private readonly client: SupabaseClient) {}

  async upsertGa4Rows(
    ownerId: string,
    connectionId: string | null,
    rows: Ga4DailyRow[],
  ): Promise<number> {
    const syncedAt = new Date().toISOString();
    const payload = rows.map((row) => ({
      owner_id: ownerId,
      connection_id: connectionId,
      date: row.date,
      source: row.source,
      medium: row.medium,
      campaign: row.campaign,
      sessions: row.sessions,
      active_users: row.activeUsers,
      new_users: row.newUsers,
      engaged_sessions: row.engagedSessions,
      engagement_time_secs: row.engagementTimeSecs,
      bounce_rate: row.bounceRate,
      conversions: row.conversions,
      generate_lead_events: row.generateLeadEvents,
      synced_at: syncedAt,
    }));

    let written = 0;
    for (const batch of chunked(payload)) {
      const { error } = await this.client
        .from('ga4_daily_traffic')
        .upsert(batch, {
          onConflict: 'owner_id,date,source,medium,campaign',
          // false means a conflicting row is updated rather than left alone,
          // which is how a late correction lands.
          ignoreDuplicates: false,
        });
      if (error) throw new Error(`ga4_daily_traffic upsert failed: ${error.message}`);
      written += batch.length;
    }
    return written;
  }

  async upsertSearchConsoleRows(
    ownerId: string,
    connectionId: string | null,
    rows: SearchConsoleDailyRow[],
  ): Promise<number> {
    const syncedAt = new Date().toISOString();
    const payload = rows.map((row) => ({
      owner_id: ownerId,
      connection_id: connectionId,
      date: row.date,
      query: row.query,
      page: row.page,
      country: row.country,
      device: row.device,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      average_position: row.averagePosition,
      synced_at: syncedAt,
    }));

    let written = 0;
    for (const batch of chunked(payload)) {
      const { error } = await this.client
        .from('search_console_daily')
        .upsert(batch, {
          onConflict: 'owner_id,date,query,page,country,device',
          ignoreDuplicates: false,
        });
      if (error) throw new Error(`search_console_daily upsert failed: ${error.message}`);
      written += batch.length;
    }
    return written;
  }

  async saveSyncRun(run: SyncRunRecord): Promise<void> {
    const { error } = await this.client
      .from('sync_runs')
      .upsert({
        owner_id: run.ownerId,
        connection_id: run.connectionId,
        provider: run.provider,
        started_at: run.startedAt,
        completed_at: run.completedAt,
        status: run.status,
        rows_read: run.rowsRead,
        rows_written: run.rowsWritten,
        error_summary: run.errorSummary,
        idempotency_key: run.idempotencyKey,
        // Providers that have more to say than two counts put it here. Already
        // sanitized by the caller, because the owner can read this column.
        ...(run.details === undefined ? {} : { details: run.details }),
      }, { onConflict: 'owner_id,idempotency_key', ignoreDuplicates: false });

    if (error) throw new Error(`sync_runs upsert failed: ${error.message}`);
  }
}

/**
 * The connection row for this owner and provider, created if it is not there yet.
 *
 * integration_connections has no token column, so nothing secret passes through
 * here. It records that a connection exists, what it points at and how it last
 * behaved, which is exactly what the Cockpit needs to show.
 */
export async function ensureConnection(
  client: SupabaseClient,
  ownerId: string,
  provider: IntegrationProvider,
  providerAccountId: string,
  displayName: string,
  grantedScopes: string[],
): Promise<string | null> {
  const { data, error } = await client
    .from('integration_connections')
    .upsert({
      owner_id: ownerId,
      provider,
      provider_account_id: providerAccountId,
      display_name: displayName,
      granted_scopes: grantedScopes,
      status: 'connected',
      connected_at: new Date().toISOString(),
      error_message: null,
      error_at: null,
    }, { onConflict: 'owner_id,provider', ignoreDuplicates: false })
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`integration_connections upsert failed: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/** Record that a connection is currently broken, without touching its tokens. */
export async function markConnectionError(
  client: SupabaseClient,
  ownerId: string,
  provider: IntegrationProvider,
  message: string,
): Promise<void> {
  await client
    .from('integration_connections')
    .update({ status: 'error', error_message: message, error_at: new Date().toISOString() })
    .eq('owner_id', ownerId)
    .eq('provider', provider);
}

/** Note a successful sync against the connection, for the Cockpit to display. */
export async function markConnectionSynced(
  client: SupabaseClient,
  ownerId: string,
  provider: IntegrationProvider,
): Promise<void> {
  await client
    .from('integration_connections')
    .update({
      status: 'connected',
      last_synced_at: new Date().toISOString(),
      error_message: null,
      error_at: null,
    })
    .eq('owner_id', ownerId)
    .eq('provider', provider);
}
