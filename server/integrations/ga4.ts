/**
 * Reading GA4, and turning what comes back into rows for ga4_daily_traffic.
 *
 * The request shape is fixed by the unique key in migration 0005:
 * (owner_id, date, source, medium, campaign). The dimensions asked for here must
 * stay exactly that set, because a response broken down any finer would collapse
 * onto the same key and rows would overwrite each other silently. Anything extra
 * has to arrive as a separate request keyed the same way, which is what the key
 * event count below does.
 *
 * Every function is pure or takes its fetch as an argument, so the tests drive
 * the real mapping code against recorded response shapes and never touch Google.
 */

import { GA4_SCOPE, type GoogleTokenSource } from './googleAuth.ts';
import { normalizeDimension, parseMetric, type Ga4DailyRow } from './analytics.ts';
import type { DateWindow } from './types.ts';

const GA4_ENDPOINT = 'https://analyticsdata.googleapis.com/v1beta';

/** Must match the unique key, in this order. */
export const GA4_DIMENSIONS = [
  'date', 'sessionSource', 'sessionMedium', 'sessionCampaignName',
] as const;

/**
 * Metrics that have been stable across GA4's renames.
 *
 * `conversions` is deliberately absent. Google renamed it to `keyEvents` and the
 * old name's behaviour has shifted, so asking for either one risks a request that
 * fails outright or a number that does not mean what the column name says. The
 * conversions column stays null, which is the app's existing way of saying not
 * measured, and is honest until the name is pinned down against the real property.
 */
export const GA4_METRICS = [
  'sessions', 'activeUsers', 'newUsers', 'engagedSessions',
  'userEngagementDuration', 'bounceRate',
] as const;

/** The GA4 event that means someone got in touch. */
export const LEAD_EVENT_NAME = 'generate_lead';

/** GA4 caps a page at 100000 rows; this stays well inside it. */
const PAGE_SIZE = 25_000;

export interface Ga4ReportResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: {
    dimensionValues?: { value?: string | null }[];
    metricValues?: { value?: string | null }[];
  }[];
  rowCount?: number;
}

/** GA4 returns dates as YYYYMMDD. Everything else in this app uses YYYY-MM-DD. */
export function fromGa4Date(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!/^\d{8}$/.test(trimmed)) return null;
  return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
}

export function buildReportRequest(window: DateWindow, offset = 0): Record<string, unknown> {
  return {
    dateRanges: [{ startDate: window.start, endDate: window.end }],
    dimensions: GA4_DIMENSIONS.map((name) => ({ name })),
    metrics: GA4_METRICS.map((name) => ({ name })),
    limit: PAGE_SIZE,
    offset,
    // Without this a property with fewer than the requested rows still reports a
    // total, which is what the pagination loop below counts against.
    returnPropertyQuota: false,
  };
}

/** The same breakdown, narrowed to the lead event, counted. */
export function buildLeadEventRequest(window: DateWindow, offset = 0): Record<string, unknown> {
  return {
    dateRanges: [{ startDate: window.start, endDate: window.end }],
    dimensions: GA4_DIMENSIONS.map((name) => ({ name })),
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        stringFilter: { matchType: 'EXACT', value: LEAD_EVENT_NAME },
      },
    },
    limit: PAGE_SIZE,
    offset,
    returnPropertyQuota: false,
  };
}

/** The unique key of a row, as one string, for merging the two reports. */
export function rowKey(row: { date: string; source: string; medium: string; campaign: string }): string {
  return [row.date, row.source, row.medium, row.campaign].join('\u0000');
}

/**
 * Response to rows, reading metrics by header name rather than by position.
 *
 * Position would work today and break quietly the first time the metric list
 * changes order, and the failure would look like plausible numbers in the wrong
 * columns rather than an error.
 */
export function mapReportResponse(response: Ga4ReportResponse): Ga4DailyRow[] {
  const metricNames = (response.metricHeaders ?? []).map((h) => h.name);
  const dimensionNames = (response.dimensionHeaders ?? []).map((h) => h.name);
  const rows: Ga4DailyRow[] = [];

  for (const raw of response.rows ?? []) {
    const dimensionAt = (name: string): string | null => {
      const index = dimensionNames.indexOf(name);
      return index === -1 ? null : (raw.dimensionValues?.[index]?.value ?? null);
    };
    const metric = (name: string): number | null => {
      const index = metricNames.indexOf(name);
      // A metric that was not asked for is unknown, not zero.
      if (index === -1) return null;
      return parseMetric(raw.metricValues?.[index]?.value ?? null);
    };

    const date = fromGa4Date(dimensionAt('date'));
    // A row with no usable date cannot be keyed or upserted, so it is dropped
    // rather than stored against a guessed day.
    if (!date) continue;

    rows.push({
      date,
      source: normalizeDimension(dimensionAt('sessionSource')),
      medium: normalizeDimension(dimensionAt('sessionMedium')),
      campaign: normalizeDimension(dimensionAt('sessionCampaignName')),
      sessions: metric('sessions'),
      activeUsers: metric('activeUsers'),
      newUsers: metric('newUsers'),
      engagedSessions: metric('engagedSessions'),
      engagementTimeSecs: metric('userEngagementDuration'),
      bounceRate: metric('bounceRate'),
      conversions: null,
      generateLeadEvents: null,
    });
  }

  return rows;
}

/** Lead event counts, keyed the same way so they can be merged in. */
export function mapLeadEventResponse(response: Ga4ReportResponse): Map<string, number | null> {
  const dimensionNames = (response.dimensionHeaders ?? []).map((h) => h.name);
  const metricNames = (response.metricHeaders ?? []).map((h) => h.name);
  const counts = new Map<string, number | null>();

  for (const raw of response.rows ?? []) {
    const dimensionAt = (name: string): string | null => {
      const index = dimensionNames.indexOf(name);
      return index === -1 ? null : (raw.dimensionValues?.[index]?.value ?? null);
    };
    const date = fromGa4Date(dimensionAt('date'));
    if (!date) continue;

    const index = metricNames.indexOf('eventCount');
    const count = index === -1 ? null : parseMetric(raw.metricValues?.[index]?.value ?? null);

    counts.set(rowKey({
      date,
      source: normalizeDimension(dimensionAt('sessionSource')),
      medium: normalizeDimension(dimensionAt('sessionMedium')),
      campaign: normalizeDimension(dimensionAt('sessionCampaignName')),
    }), count);
  }

  return counts;
}

/**
 * Fold lead counts into traffic rows.
 *
 * A key present in the traffic report and absent from the lead report keeps
 * generateLeadEvents null rather than 0, because the lead report was filtered and
 * says nothing about rows it filtered out. A key that appears only in the lead
 * report still becomes a row: someone submitted a form and the traffic breakdown
 * did not account for it, which is worth keeping rather than discarding.
 */
export function mergeLeadEvents(
  traffic: Ga4DailyRow[],
  leadCounts: Map<string, number | null>,
): Ga4DailyRow[] {
  const merged = traffic.map((row) => {
    const key = rowKey(row);
    return leadCounts.has(key) ? { ...row, generateLeadEvents: leadCounts.get(key) ?? null } : row;
  });

  const seen = new Set(traffic.map(rowKey));
  for (const [key, count] of leadCounts) {
    if (seen.has(key)) continue;
    const [date, source, medium, campaign] = key.split('\u0000');
    merged.push({
      date, source, medium, campaign,
      sessions: null, activeUsers: null, newUsers: null, engagedSessions: null,
      engagementTimeSecs: null, bounceRate: null, conversions: null,
      generateLeadEvents: count,
    });
  }

  return merged;
}

export interface Ga4FetchDeps {
  tokenSource: GoogleTokenSource;
  propertyId: string;
  fetchImpl?: typeof fetch;
}

/** Run one report to completion, following GA4's offset pagination. */
async function runReport(
  deps: Ga4FetchDeps,
  build: (window: DateWindow, offset: number) => Record<string, unknown>,
  window: DateWindow,
): Promise<Ga4ReportResponse[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const token = await deps.tokenSource.getAccessToken([GA4_SCOPE]);
  const url = `${GA4_ENDPOINT}/properties/${deps.propertyId}:runReport`;

  const pages: Ga4ReportResponse[] = [];
  let offset = 0;

  for (;;) {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(build(window, offset)),
    });

    if (!response.ok) {
      // Google's body can quote the request back, so only the status is kept.
      throw new Error(`GA4 runReport failed (HTTP ${response.status})`);
    }

    const page = (await response.json()) as Ga4ReportResponse;
    pages.push(page);

    const received = page.rows?.length ?? 0;
    offset += received;
    const total = typeof page.rowCount === 'number' ? page.rowCount : offset;
    if (received === 0 || offset >= total) break;
  }

  return pages;
}

/** Everything GA4 has for this window, already merged and mapped. */
export async function fetchGa4Rows(
  deps: Ga4FetchDeps,
  window: DateWindow,
): Promise<Ga4DailyRow[]> {
  const trafficPages = await runReport(deps, buildReportRequest, window);
  const traffic = trafficPages.flatMap(mapReportResponse);

  const leadPages = await runReport(deps, buildLeadEventRequest, window);
  const leadCounts = new Map<string, number | null>();
  for (const page of leadPages) {
    for (const [key, value] of mapLeadEventResponse(page)) leadCounts.set(key, value);
  }

  return mergeLeadEvents(traffic, leadCounts);
}
