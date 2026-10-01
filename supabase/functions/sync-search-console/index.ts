/**
 * Daily Search Console sync.
 *
 * Same three modes as the GA4 function, same stop at yesterday, and additionally
 * only ever asks for data Google has marked final.
 *
 * SEARCH_CONSOLE_SITE_URL must be the exact property string, including the
 * trailing slash for a URL-prefix property. Search Console treats
 * https://sitelaunchstudios.com/ and https://sitelaunchstudios.com as different
 * properties and returns an empty result rather than an error for the wrong one.
 */

import { fetchSearchConsoleRows } from '../../../server/integrations/searchConsole.ts';
import { SEARCH_CONSOLE_SCOPE } from '../../../server/integrations/googleAuth.ts';
import type { SearchConsoleDailyRow } from '../../../server/integrations/analytics.ts';
import { handleSyncRequest } from '../_shared/handler.ts';

Deno.serve((request: Request) =>
  handleSyncRequest<SearchConsoleDailyRow>(request, {
    provider: 'search_console',
    accountId: Deno.env.get('SEARCH_CONSOLE_SITE_URL') ?? null,
    scopes: [SEARCH_CONSOLE_SCOPE],
    fetchRows: (tokenSource, window) =>
      fetchSearchConsoleRows(
        { tokenSource, siteUrl: Deno.env.get('SEARCH_CONSOLE_SITE_URL') ?? '' },
        window,
      ),
    writeRows: (store, ownerId, connectionId, rows) =>
      store.upsertSearchConsoleRows(ownerId, connectionId, rows),
  }));
