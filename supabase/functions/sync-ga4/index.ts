/**
 * Daily GA4 sync.
 *
 * POST with no body for the rolling seven completed days, {"mode":"backfill"} for
 * history from 2026-08-27, or {"mode":"manual","start":"...","end":"..."} for a
 * specific window. Every one of them stops at yesterday.
 *
 * Callers: the Cockpit's Sync now button with the signed in user's token, or the
 * scheduler with the x-sync-cron-secret header.
 */

import { fetchGa4Rows } from '../../../server/integrations/ga4.ts';
import { GA4_SCOPE } from '../../../server/integrations/googleAuth.ts';
import type { Ga4DailyRow } from '../../../server/integrations/analytics.ts';
import { handleSyncRequest } from '../_shared/handler.ts';

Deno.serve((request: Request) =>
  handleSyncRequest<Ga4DailyRow>(request, {
    provider: 'ga4',
    accountId: Deno.env.get('GA4_PROPERTY_ID') ?? null,
    scopes: [GA4_SCOPE],
    fetchRows: (tokenSource, window) =>
      fetchGa4Rows(
        { tokenSource, propertyId: Deno.env.get('GA4_PROPERTY_ID') ?? '' },
        window,
      ),
    writeRows: (store, ownerId, connectionId, rows) =>
      store.upsertGa4Rows(ownerId, connectionId, rows),
  }));
