/**
 * Idempotent syncing.
 *
 * The rule under test: running the same window twice changes nothing. A duplicated
 * day would silently double every total built on it, and nobody would notice until
 * a number looked wrong months later.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GA4_UNIQUE_KEY, NO_DIMENSION, SEARCH_CONSOLE_UNIQUE_KEY, normalizeDimension,
} from './uniqueKeys';
import { conflictKey, countNewRows, upsertRows } from './upsert';

interface Ga4Row extends Record<string, unknown> {
  date: string;
  source: string;
  medium: string;
  campaign: string;
  sessions: number | null;
}

const row = (over: Partial<Ga4Row> = {}): Ga4Row => ({
  date: '2026-09-19',
  source: 'instagram',
  medium: 'story',
  campaign: 'bts_story_2026_09',
  sessions: 4,
  ...over,
});

describe('repeated daily imports update rather than duplicate', () => {
  it('leaves one row when the same day is synced twice', () => {
    const first = upsertRows<Ga4Row>([], [row()], GA4_UNIQUE_KEY);
    const second = upsertRows(first, [row()], GA4_UNIQUE_KEY);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('takes the newer figure when a provider restates a day', () => {
    const first = upsertRows<Ga4Row>([], [row({ sessions: 4 })], GA4_UNIQUE_KEY);
    const second = upsertRows(first, [row({ sessions: 9 })], GA4_UNIQUE_KEY);

    expect(second).toHaveLength(1);
    expect(second[0].sessions).toBe(9);
  });

  it('stays at the same length over ten identical runs', () => {
    let rows: Ga4Row[] = [];
    const window = [row({ date: '2026-09-17' }), row({ date: '2026-09-18' }), row()];
    for (let i = 0; i < 10; i += 1) rows = upsertRows(rows, window, GA4_UNIQUE_KEY);
    expect(rows).toHaveLength(3);
  });

  it('keeps rows the provider did not mention this time', () => {
    const existing = upsertRows<Ga4Row>(
      [],
      [row({ date: '2026-09-17' }), row({ date: '2026-09-18' })],
      GA4_UNIQUE_KEY,
    );
    // A later run that only returns one day must not delete the other.
    const after = upsertRows(existing, [row({ date: '2026-09-18', sessions: 12 })], GA4_UNIQUE_KEY);

    expect(after).toHaveLength(2);
    expect(after.find((r) => r.date === '2026-09-17')?.sessions).toBe(4);
  });

  it('does not blank a column a partial response left out', () => {
    const existing = upsertRows<Ga4Row>([], [row({ sessions: 4 })], GA4_UNIQUE_KEY);
    const partial = { date: '2026-09-19', source: 'instagram', medium: 'story', campaign: 'bts_story_2026_09' } as Ga4Row;
    const after = upsertRows(existing, [partial], GA4_UNIQUE_KEY);

    expect(after[0].sessions).toBe(4);
  });

  it('treats a different dimension as a different row', () => {
    const rows = upsertRows<Ga4Row>(
      [],
      [row(), row({ campaign: 'another_campaign' }), row({ medium: 'post' })],
      GA4_UNIQUE_KEY,
    );
    expect(rows).toHaveLength(3);
  });

  it('counts what is genuinely new', () => {
    const existing = upsertRows<Ga4Row>([], [row()], GA4_UNIQUE_KEY);
    expect(countNewRows(existing, [row()], GA4_UNIQUE_KEY)).toBe(0);
    expect(countNewRows(existing, [row({ date: '2026-09-20' })], GA4_UNIQUE_KEY)).toBe(1);
  });

  it('deduplicates within a single batch as well as against history', () => {
    const rows = upsertRows<Ga4Row>([], [row({ sessions: 1 }), row({ sessions: 7 })], GA4_UNIQUE_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessions).toBe(7);
  });

  it('cannot be fooled by a value containing a separator', () => {
    const a = conflictKey(row({ campaign: 'a', source: 'b' }), GA4_UNIQUE_KEY);
    const b = conflictKey(row({ campaign: 'b', source: 'a' }), GA4_UNIQUE_KEY);
    expect(a).not.toBe(b);
  });
});

describe('Search Console rows key on all five dimensions', () => {
  interface ScRow extends Record<string, unknown> {
    date: string; query: string; page: string; country: string; device: string;
    clicks: number | null;
  }
  const sc = (over: Partial<ScRow> = {}): ScRow => ({
    date: '2026-09-19', query: 'web design miami', page: 'https://s.com/',
    country: 'usa', device: 'mobile', clicks: 3, ...over,
  });

  it('separates the same query on a different device', () => {
    const rows = upsertRows<ScRow>([], [sc(), sc({ device: 'desktop' })], SEARCH_CONSOLE_UNIQUE_KEY);
    expect(rows).toHaveLength(2);
  });

  it('merges the identical row', () => {
    const rows = upsertRows<ScRow>([], [sc({ clicks: 3 }), sc({ clicks: 5 })], SEARCH_CONSOLE_UNIQUE_KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0].clicks).toBe(5);
  });
});

describe('empty dimensions become a placeholder, never null', () => {
  it('replaces blank and missing values', () => {
    expect(normalizeDimension('')).toBe(NO_DIMENSION);
    expect(normalizeDimension('   ')).toBe(NO_DIMENSION);
    expect(normalizeDimension(null)).toBe(NO_DIMENSION);
    expect(normalizeDimension(undefined)).toBe(NO_DIMENSION);
  });

  it('leaves a real value alone', () => {
    expect(normalizeDimension('instagram')).toBe('instagram');
  });

  it('keeps two campaign-less days apart, which null would not', () => {
    const rows = upsertRows<Ga4Row>(
      [],
      [
        row({ date: '2026-09-18', campaign: normalizeDimension('') }),
        row({ date: '2026-09-19', campaign: normalizeDimension('') }),
      ],
      GA4_UNIQUE_KEY,
    );
    expect(rows).toHaveLength(2);
  });
});

describe('the app and the database agree on the unique keys', () => {
  const sql = readFileSync('supabase/migrations/0005_integrations.sql', 'utf8');

  it('matches the GA4 constraint in the migration', () => {
    expect(sql).toContain('unique (owner_id, date, source, medium, campaign)');
    expect([...GA4_UNIQUE_KEY]).toEqual(['date', 'source', 'medium', 'campaign']);
  });

  it('matches the Search Console constraint in the migration', () => {
    expect(sql).toContain('unique (owner_id, date, query, page, country, device)');
    expect([...SEARCH_CONSOLE_UNIQUE_KEY]).toEqual([
      'date', 'query', 'page', 'country', 'device',
    ]);
  });

  it('declares the dimension columns not null, so the unique index actually bites', () => {
    for (const column of ['source', 'medium', 'campaign']) {
      expect(sql).toMatch(new RegExp(`${column}\\s+text not null default`));
    }
  });
});
