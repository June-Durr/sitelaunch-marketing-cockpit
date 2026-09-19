/**
 * Idempotent merging of daily analytics rows.
 *
 * A sync must be safe to run twice. Running the same window again has to update
 * the rows that are already there, not add a second copy, because a duplicated day
 * silently doubles every total built on top of it.
 *
 * In Supabase this is an upsert against the unique constraints in migration 0005.
 * The same rule is implemented here as a pure function so the behaviour can be
 * proven without a database, and so any local or CSV path merges identically.
 */

import { GA4_UNIQUE_KEY, SEARCH_CONSOLE_UNIQUE_KEY } from './uniqueKeys';

/** Build the conflict key for a row from the columns that identify it. */
export function conflictKey<T extends Record<string, unknown>>(
  row: T,
  columns: readonly (keyof T & string)[],
): string {
  // Unit separator, so a value containing a normal delimiter cannot forge a key.
  return columns.map((c) => String(row[c] ?? '')).join('');
}

/**
 * Merge incoming rows into existing ones on the given key.
 *
 * Later wins on a collision, because a provider restating a day is correcting it.
 * Rows the provider did not mention are left exactly as they were: absence from
 * one response is not evidence that a day had no traffic.
 */
export function upsertRows<T extends Record<string, unknown>>(
  existing: readonly T[],
  incoming: readonly T[],
  columns: readonly (keyof T & string)[],
): T[] {
  const byKey = new Map<string, T>();
  for (const row of existing) byKey.set(conflictKey(row, columns), row);

  for (const row of incoming) {
    const key = conflictKey(row, columns);
    const previous = byKey.get(key);
    // Merge rather than replace, so a partial response cannot blank a column the
    // provider simply did not return this time.
    byKey.set(key, previous ? { ...previous, ...row } : row);
  }

  return [...byKey.values()];
}

/** How many of the incoming rows are new rather than updates. */
export function countNewRows<T extends Record<string, unknown>>(
  existing: readonly T[],
  incoming: readonly T[],
  columns: readonly (keyof T & string)[],
): number {
  const seen = new Set(existing.map((r) => conflictKey(r, columns)));
  let added = 0;
  for (const row of incoming) {
    const key = conflictKey(row, columns);
    if (!seen.has(key)) {
      seen.add(key);
      added += 1;
    }
  }
  return added;
}

export { GA4_UNIQUE_KEY, SEARCH_CONSOLE_UNIQUE_KEY };
