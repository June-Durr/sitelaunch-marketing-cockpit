/**
 * GA4 and Search Console sync contracts.
 *
 * NOT CONNECTED. No credentials, no HTTP, no stubs.
 *
 * WHY THESE WRITE TO DAILY TABLES RATHER THAN traffic_snapshots
 *
 * traffic_snapshots holds a date range, which is right for a person typing in a
 * report they read once. Ranges overlap, and overlapping rows cannot be re-synced
 * without double counting: 1 to 30 September and 15 September to 15 October share
 * two weeks that no later run can untangle.
 *
 * An API sync writes one row per day per dimension into ga4_daily_traffic or
 * search_console_daily, each carrying a unique key that an upsert targets. Running
 * the same window twice then changes nothing.
 *
 * A sync must never delete rows the provider did not mention in this run.
 * Providers restate history as data settles, and absence from one response is not
 * evidence that a day had no traffic.
 */

import type { ProviderSync, SyncContext, SyncResult } from './types.ts';

/** One day of GA4 traffic for one source, medium and campaign. */
export interface Ga4DailyRow {
  date: string;
  source: string;
  medium: string;
  campaign: string;
  sessions: number | null;
  activeUsers: number | null;
  newUsers: number | null;
  engagedSessions: number | null;
  engagementTimeSecs: number | null;
  bounceRate: number | null;
  conversions: number | null;
  generateLeadEvents: number | null;
}

/** One day of Search Console data for one query, page, country and device. */
export interface SearchConsoleDailyRow {
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  averagePosition: number | null;
}

export interface Ga4Sync extends ProviderSync {
  readonly provider: 'ga4';
  run(context: SyncContext): Promise<SyncResult>;
}

export interface SearchConsoleSync extends ProviderSync {
  readonly provider: 'search_console';
  run(context: SyncContext): Promise<SyncResult>;
}

/**
 * The columns that identify a GA4 row. Matches the unique constraint in migration
 * 0005, and is what an upsert conflicts on.
 */
export const GA4_UNIQUE_KEY = ['date', 'source', 'medium', 'campaign'] as const;

export const SEARCH_CONSOLE_UNIQUE_KEY = [
  'date', 'query', 'page', 'country', 'device',
] as const;

/**
 * A dimension the provider left empty becomes a placeholder rather than null.
 *
 * NULL never equals NULL in a unique index, so a nullable dimension would let
 * duplicate rows through in exactly the case where GA4 reports no campaign. This is
 * the one place an empty value is deliberately replaced, and it applies to
 * dimensions only. Metrics stay null when unknown, as everywhere else in this app.
 */
export const NO_DIMENSION = '(none)';

export function normalizeDimension(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? NO_DIMENSION : trimmed;
}

/**
 * A metric value from a provider, as a number or as null.
 *
 * The opposite rule to normalizeDimension, and the reason both exist. A missing
 * dimension is a real category, "no campaign", so it gets a placeholder. A missing
 * metric is not a measurement of nothing, it is the absence of a measurement, so
 * it stays null and every screen downstream can keep saying it does not know.
 *
 * The distinction that matters most here is "0" against "". Both are falsy, and
 * treating them alike is the single easiest way to turn "we have no idea" into
 * "we had no visitors". A real zero from the API survives as 0.
 */
export function parseMetric(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
