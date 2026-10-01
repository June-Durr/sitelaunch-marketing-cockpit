/**
 * Reading Search Console, and turning what comes back into rows for
 * search_console_daily.
 *
 * Same rule as GA4: the dimensions requested here are exactly the unique key in
 * migration 0005, (owner_id, date, query, page, country, device). Asking for a
 * coarser set would make several real rows collide on one key.
 *
 * TWO THINGS SEARCH CONSOLE DOES THAT GA4 DOES NOT
 *
 * It withholds data. Queries below a privacy threshold are simply absent, and
 * position is sometimes missing on low volume rows. Absent is not zero, and this
 * module never invents a row for a day the API did not mention.
 *
 * It serves unsettled data. dataState 'final' asks for only the figures Google
 * considers complete, which is the second guard alongside never requesting today.
 */

import { SEARCH_CONSOLE_SCOPE, type GoogleTokenSource } from './googleAuth.ts';
import { normalizeDimension, parseMetric, type SearchConsoleDailyRow } from './analytics.ts';
import type { DateWindow } from './types.ts';

const SEARCH_CONSOLE_ENDPOINT = 'https://searchconsole.googleapis.com/webmasters/v3';

/** Must match the unique key, in this order: the API returns keys positionally. */
export const SEARCH_CONSOLE_DIMENSIONS = [
  'date', 'query', 'page', 'country', 'device',
] as const;

/** The API's own maximum for one page. */
const PAGE_SIZE = 25_000;

export interface SearchConsoleQueryResponse {
  rows?: {
    keys?: (string | null)[];
    clicks?: number | null;
    impressions?: number | null;
    ctr?: number | null;
    position?: number | null;
  }[];
}

export function buildQueryRequest(window: DateWindow, startRow = 0): Record<string, unknown> {
  return {
    startDate: window.start,
    endDate: window.end,
    dimensions: [...SEARCH_CONSOLE_DIMENSIONS],
    rowLimit: PAGE_SIZE,
    startRow,
    // Only figures Google calls settled. Without this the most recent days come
    // back as fresh estimates that change under us.
    dataState: 'final',
    type: 'web',
  };
}

/** YYYY-MM-DD already, but never trusted without checking. */
function readDate(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

export function mapQueryResponse(response: SearchConsoleQueryResponse): SearchConsoleDailyRow[] {
  const rows: SearchConsoleDailyRow[] = [];

  for (const raw of response.rows ?? []) {
    const keys = raw.keys ?? [];
    const date = readDate(keys[0]);
    // Undatable rows cannot be keyed, so they are dropped rather than guessed at.
    if (!date) continue;

    rows.push({
      date,
      query: normalizeDimension(keys[1]),
      page: normalizeDimension(keys[2]),
      country: normalizeDimension(keys[3]),
      device: normalizeDimension(keys[4]),
      // A row that exists with zero clicks really did get zero clicks, and stays
      // 0. A field the API omitted stays null.
      clicks: parseMetric(raw.clicks),
      impressions: parseMetric(raw.impressions),
      ctr: parseMetric(raw.ctr),
      averagePosition: parseMetric(raw.position),
    });
  }

  return rows;
}

export interface SearchConsoleFetchDeps {
  tokenSource: GoogleTokenSource;
  /** The exact property string, including the trailing slash for a URL prefix. */
  siteUrl: string;
  fetchImpl?: typeof fetch;
}

/** Everything Search Console will admit to for this window. */
export async function fetchSearchConsoleRows(
  deps: SearchConsoleFetchDeps,
  window: DateWindow,
): Promise<SearchConsoleDailyRow[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const token = await deps.tokenSource.getAccessToken([SEARCH_CONSOLE_SCOPE]);
  const url =
    `${SEARCH_CONSOLE_ENDPOINT}/sites/${encodeURIComponent(deps.siteUrl)}/searchAnalytics/query`;

  const all: SearchConsoleDailyRow[] = [];
  let startRow = 0;

  for (;;) {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildQueryRequest(window, startRow)),
    });

    if (!response.ok) {
      throw new Error(`Search Console query failed (HTTP ${response.status})`);
    }

    const page = (await response.json()) as SearchConsoleQueryResponse;
    const mapped = mapQueryResponse(page);
    all.push(...mapped);

    const received = page.rows?.length ?? 0;
    // A short page is the last page: this API reports no total.
    if (received < PAGE_SIZE) break;
    startRow += received;
  }

  return all;
}
