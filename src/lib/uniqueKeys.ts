/**
 * The columns that identify a daily analytics row.
 *
 * These must stay in step with the unique constraints in
 * supabase/migrations/0005_integrations.sql. A test asserts that they do, because
 * a drift between the two would mean the app merges on one key while the database
 * enforces another, and duplicates would appear only in production.
 */

export const GA4_UNIQUE_KEY = ['date', 'source', 'medium', 'campaign'] as const;

export const SEARCH_CONSOLE_UNIQUE_KEY = [
  'date', 'query', 'page', 'country', 'device',
] as const;

/** A dimension the provider left empty. Never null, or the unique index lets duplicates through. */
export const NO_DIMENSION = '(none)';

export function normalizeDimension(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? NO_DIMENSION : trimmed;
}
