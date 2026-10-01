/**
 * What the analytics sync has to get right, proved against mocked Google
 * responses. Nothing in this file talks to a real Google property.
 *
 * The store double below enforces the same unique keys as migration 0005, so an
 * upsert that would collide in Postgres collides here too. That is what makes the
 * idempotency tests mean something without a live database.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseMetric, normalizeDimension, NO_DIMENSION, type Ga4DailyRow, type SearchConsoleDailyRow } from './analytics.ts';
import {
  buildLeadEventRequest, buildReportRequest, fetchGa4Rows, fromGa4Date,
  mapLeadEventResponse, mapReportResponse, mergeLeadEvents, rowKey,
  type Ga4ReportResponse,
} from './ga4.ts';
import { buildQueryRequest, mapQueryResponse, fetchSearchConsoleRows } from './searchConsole.ts';
import { runSync, type SyncRunRecord, type SyncStore } from './syncRunner.ts';
import {
  BACKFILL_START, backfillWindow, clampToCompleteDays, dailyWindow, idempotencyKey,
  isCompleteDay, lastCompleteDay,
} from './syncWindow.ts';
import { redact, sanitizeError } from './sanitize.ts';
import { parseServiceAccountKey, ServiceAccountTokenSource } from './googleAuth.ts';
import { CRON_SECRET_HEADER, resolveCaller, secretsMatch } from './requestAuth.ts';

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const CONNECTION = '33333333-3333-3333-3333-333333333333';

/** 2026-09-30, so yesterday is 2026-09-29. */
const NOW = new Date('2026-09-30T14:00:00.000Z');

// ---------------------------------------------------------------------------
// A store that behaves like the tables in migration 0005
// ---------------------------------------------------------------------------

class MemoryStore implements SyncStore {
  ga4 = new Map<string, Ga4DailyRow & { owner_id: string }>();
  searchConsole = new Map<string, SearchConsoleDailyRow & { owner_id: string }>();
  runs = new Map<string, SyncRunRecord>();
  /** Every save, in order, so a test can see running then succeeded. */
  runHistory: SyncRunRecord[] = [];

  upsertGa4Rows(ownerId: string, _c: string | null, rows: Ga4DailyRow[]): Promise<number> {
    for (const row of rows) {
      const key = [ownerId, row.date, row.source, row.medium, row.campaign].join('|');
      this.ga4.set(key, { ...row, owner_id: ownerId });
    }
    return Promise.resolve(rows.length);
  }

  upsertSearchConsoleRows(
    ownerId: string, _c: string | null, rows: SearchConsoleDailyRow[],
  ): Promise<number> {
    for (const row of rows) {
      const key = [ownerId, row.date, row.query, row.page, row.country, row.device].join('|');
      this.searchConsole.set(key, { ...row, owner_id: ownerId });
    }
    return Promise.resolve(rows.length);
  }

  saveSyncRun(run: SyncRunRecord): Promise<void> {
    // unique (owner_id, idempotency_key)
    this.runs.set(`${run.ownerId}|${run.idempotencyKey}`, run);
    this.runHistory.push(run);
    return Promise.resolve();
  }

  rowsFor(ownerId: string): (Ga4DailyRow & { owner_id: string })[] {
    return [...this.ga4.values()].filter((r) => r.owner_id === ownerId);
  }
}

function ga4Response(
  rows: { dims: string[]; metrics: (string | null)[] }[],
  metricNames = ['sessions', 'activeUsers', 'newUsers', 'engagedSessions', 'userEngagementDuration', 'bounceRate'],
): Ga4ReportResponse {
  return {
    dimensionHeaders: ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName'].map((name) => ({ name })),
    metricHeaders: metricNames.map((name) => ({ name })),
    rows: rows.map((r) => ({
      dimensionValues: r.dims.map((value) => ({ value })),
      metricValues: r.metrics.map((value) => ({ value })),
    })),
    rowCount: rows.length,
  };
}

/** A fetch that answers the traffic report and the lead report in turn. */
function fakeGoogle(pages: unknown[]): { impl: typeof fetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let index = 0;
  const impl = ((_url: string, init?: RequestInit) => {
    calls.push(init ?? {});
    const body = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as Response);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const tokenSource = {
  getAccessToken: () => Promise.resolve('test-access-token'),
  describe: () => 'test@example.iam.gserviceaccount.com',
};

// ---------------------------------------------------------------------------

describe('the window a sync asks for', () => {
  it('never includes today, because today is still being counted', () => {
    expect(lastCompleteDay(NOW)).toBe('2026-09-29');
    expect(dailyWindow(NOW)).toEqual({ start: '2026-09-23', end: '2026-09-29' });
    expect(isCompleteDay('2026-09-30', NOW)).toBe(false);
    expect(isCompleteDay('2026-09-29', NOW)).toBe(true);
  });

  it('re-asks for seven completed days so late corrections can land', () => {
    const window = dailyWindow(NOW);
    const days = (new Date(`${window.end}T00:00:00Z`).getTime()
      - new Date(`${window.start}T00:00:00Z`).getTime()) / 86_400_000 + 1;
    expect(days).toBe(7);
  });

  it('backfills from the agreed start through yesterday', () => {
    expect(backfillWindow(NOW)).toEqual({ start: BACKFILL_START, end: '2026-09-29' });
  });

  it('has nothing to backfill before the start date arrives', () => {
    expect(backfillWindow(new Date('2026-08-27T10:00:00Z'))).toBeNull();
  });

  it('trims a caller-supplied window back to yesterday', () => {
    expect(clampToCompleteDays({ start: '2026-09-25', end: '2026-12-31' }, NOW))
      .toEqual({ start: '2026-09-25', end: '2026-09-29' });
  });

  it('returns nothing when the caller asks only for today', () => {
    expect(clampToCompleteDays({ start: '2026-09-30', end: '2026-09-30' }, NOW)).toBeNull();
  });

  it('gives the same key for the same window and a different one otherwise', () => {
    const a = idempotencyKey('ga4', 'daily', dailyWindow(NOW));
    const b = idempotencyKey('ga4', 'daily', dailyWindow(NOW));
    const c = idempotencyKey('ga4', 'daily', dailyWindow(new Date('2026-10-01T14:00:00Z')));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('zero and unknown stay different', () => {
  it('keeps a real zero as 0 and a blank as null', () => {
    expect(parseMetric('0')).toBe(0);
    expect(parseMetric(0)).toBe(0);
    expect(parseMetric('')).toBeNull();
    expect(parseMetric('   ')).toBeNull();
    expect(parseMetric(null)).toBeNull();
    expect(parseMetric(undefined)).toBeNull();
    expect(parseMetric('not a number')).toBeNull();
  });

  it('carries that distinction through the GA4 mapping', () => {
    const [row] = mapReportResponse(ga4Response([
      { dims: ['20260929', 'google', 'organic', ''], metrics: ['0', '', '4', '0', '', '0'] },
    ]));

    expect(row.sessions).toBe(0);
    expect(row.activeUsers).toBeNull();
    expect(row.newUsers).toBe(4);
    expect(row.engagedSessions).toBe(0);
    expect(row.engagementTimeSecs).toBeNull();
    expect(row.bounceRate).toBe(0);
    // Asked for by nobody, so it cannot be anything but unknown.
    expect(row.conversions).toBeNull();
  });

  it('gives an absent dimension a placeholder, not a null', () => {
    const [row] = mapReportResponse(ga4Response([
      { dims: ['20260929', '', '', ''], metrics: ['1', '1', '1', '1', '1', '1'] },
    ]));
    expect(row.source).toBe(NO_DIMENSION);
    expect(row.campaign).toBe(NO_DIMENSION);
    expect(normalizeDimension(null)).toBe(NO_DIMENSION);
  });

  it('keeps a Search Console row of zero clicks as zero', () => {
    const [row] = mapQueryResponse({
      rows: [{
        keys: ['2026-09-29', 'sitelaunch studios', 'https://sitelaunchstudios.com/', 'usa', 'DESKTOP'],
        clicks: 0, impressions: 12, ctr: 0,
      }],
    });
    expect(row.clicks).toBe(0);
    expect(row.ctr).toBe(0);
    expect(row.impressions).toBe(12);
    // position was omitted by the API, so it is unknown rather than 0.
    expect(row.averagePosition).toBeNull();
  });
});

describe('reading GA4', () => {
  it('asks for exactly the dimensions that make up the unique key', () => {
    const request = buildReportRequest({ start: '2026-09-23', end: '2026-09-29' }) as {
      dimensions: { name: string }[]; dateRanges: { startDate: string; endDate: string }[];
    };
    expect(request.dimensions.map((d) => d.name))
      .toEqual(['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName']);
    expect(request.dateRanges[0]).toEqual({ startDate: '2026-09-23', endDate: '2026-09-29' });
  });

  it('filters the second report down to the lead event', () => {
    const request = buildLeadEventRequest({ start: '2026-09-23', end: '2026-09-29' }) as {
      dimensionFilter: { filter: { fieldName: string; stringFilter: { value: string } } };
    };
    expect(request.dimensionFilter.filter.fieldName).toBe('eventName');
    expect(request.dimensionFilter.filter.stringFilter.value).toBe('generate_lead');
  });

  it('converts GA4 YYYYMMDD dates, and drops rows it cannot date', () => {
    expect(fromGa4Date('20260929')).toBe('2026-09-29');
    expect(fromGa4Date('nonsense')).toBeNull();
    const rows = mapReportResponse(ga4Response([
      { dims: ['bad', 'google', 'organic', ''], metrics: ['5', '5', '5', '5', '5', '5'] },
    ]));
    expect(rows).toHaveLength(0);
  });

  it('reads metrics by header name, not by position', () => {
    // Same data, metric order reversed. The values must still land correctly.
    const reversed: Ga4ReportResponse = {
      dimensionHeaders: ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName'].map((name) => ({ name })),
      metricHeaders: [{ name: 'bounceRate' }, { name: 'sessions' }],
      rows: [{
        dimensionValues: [{ value: '20260929' }, { value: 'google' }, { value: 'organic' }, { value: '' }],
        metricValues: [{ value: '0.25' }, { value: '9' }],
      }],
      rowCount: 1,
    };
    const [row] = mapReportResponse(reversed);
    expect(row.sessions).toBe(9);
    expect(row.bounceRate).toBe(0.25);
  });

  it('merges lead counts onto the matching traffic row and leaves the rest null', () => {
    const traffic = mapReportResponse(ga4Response([
      { dims: ['20260929', 'google', 'organic', ''], metrics: ['9', '9', '9', '9', '9', '0'] },
      { dims: ['20260929', 'instagram', 'social', ''], metrics: ['3', '3', '3', '3', '3', '0'] },
    ]));
    const leads = mapLeadEventResponse({
      dimensionHeaders: ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName'].map((name) => ({ name })),
      metricHeaders: [{ name: 'eventCount' }],
      rows: [{
        dimensionValues: [{ value: '20260929' }, { value: 'google' }, { value: 'organic' }, { value: '' }],
        metricValues: [{ value: '2' }],
      }],
      rowCount: 1,
    });

    const merged = mergeLeadEvents(traffic, leads);
    const google = merged.find((r) => r.source === 'google');
    const instagram = merged.find((r) => r.source === 'instagram');

    expect(google?.generateLeadEvents).toBe(2);
    // The lead report was filtered, so it says nothing about Instagram.
    expect(instagram?.generateLeadEvents).toBeNull();
  });

  it('keeps a lead row the traffic report never mentioned', () => {
    const leads = new Map([[rowKey({ date: '2026-09-29', source: 'x', medium: 'y', campaign: 'z' }), 1]]);
    const merged = mergeLeadEvents([], leads);
    expect(merged).toHaveLength(1);
    expect(merged[0].generateLeadEvents).toBe(1);
    expect(merged[0].sessions).toBeNull();
  });

  it('sends the bearer token and follows pagination', async () => {
    const page1 = ga4Response(
      Array.from({ length: 2 }, (_, i) => ({
        dims: ['20260929', `s${i}`, 'organic', ''], metrics: ['1', '1', '1', '1', '1', '0'],
      })),
    );
    page1.rowCount = 4;
    const page2 = ga4Response(
      Array.from({ length: 2 }, (_, i) => ({
        dims: ['20260928', `s${i}`, 'organic', ''], metrics: ['1', '1', '1', '1', '1', '0'],
      })),
    );
    page2.rowCount = 4;
    const empty: Ga4ReportResponse = { rows: [], rowCount: 0 };

    const { impl, calls } = fakeGoogle([page1, page2, empty]);
    const rows = await fetchGa4Rows(
      { tokenSource, propertyId: '491108477', fetchImpl: impl },
      { start: '2026-09-28', end: '2026-09-29' },
    );

    expect(rows).toHaveLength(4);
    const headers = calls[0].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-access-token');
  });

  it('reports the status and never the response body when Google refuses', async () => {
    const impl = (() => Promise.resolve({
      ok: false, status: 403,
      json: () => Promise.resolve({ error: { message: 'assertion=secret-jwt-value' } }),
    } as Response)) as unknown as typeof fetch;

    await expect(fetchGa4Rows(
      { tokenSource, propertyId: '491108477', fetchImpl: impl },
      { start: '2026-09-28', end: '2026-09-29' },
    )).rejects.toThrow(/HTTP 403/);
  });
});

describe('reading Search Console', () => {
  it('asks only for settled data, keyed to the unique constraint', () => {
    const request = buildQueryRequest({ start: '2026-09-23', end: '2026-09-29' }) as {
      dimensions: string[]; dataState: string; startDate: string; endDate: string;
    };
    expect(request.dimensions).toEqual(['date', 'query', 'page', 'country', 'device']);
    expect(request.dataState).toBe('final');
    expect(request.startDate).toBe('2026-09-23');
  });

  it('does not invent rows for days the API left out', async () => {
    const impl = (() => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        rows: [{
          keys: ['2026-09-29', 'sitelaunch', 'https://sitelaunchstudios.com/', 'usa', 'DESKTOP'],
          clicks: 1, impressions: 10, ctr: 0.1, position: 4.5,
        }],
      }),
    } as Response)) as unknown as typeof fetch;

    const rows = await fetchSearchConsoleRows(
      { tokenSource, siteUrl: 'https://sitelaunchstudios.com/', fetchImpl: impl },
      { start: '2026-09-23', end: '2026-09-29' },
    );

    // Seven days requested, one day returned. The other six stay absent.
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-09-29');
  });
});

describe('running a sync', () => {
  const window = { start: '2026-09-23', end: '2026-09-29' };
  const sampleRows: Ga4DailyRow[] = [
    {
      date: '2026-09-29', source: 'google', medium: 'organic', campaign: NO_DIMENSION,
      sessions: 10, activeUsers: 8, newUsers: 5, engagedSessions: 6,
      engagementTimeSecs: 120, bounceRate: 0.2, conversions: null, generateLeadEvents: 1,
    },
    {
      date: '2026-09-28', source: 'instagram', medium: 'social', campaign: NO_DIMENSION,
      sessions: 0, activeUsers: 0, newUsers: 0, engagedSessions: 0,
      engagementTimeSecs: 0, bounceRate: null, conversions: null, generateLeadEvents: null,
    },
  ];

  function runGa4(store: MemoryStore, rows: Ga4DailyRow[], now = NOW, ownerId = OWNER_A) {
    return runSync<Ga4DailyRow>({
      ownerId,
      connectionId: CONNECTION,
      provider: 'ga4',
      idempotencyKey: idempotencyKey('ga4', 'daily', window),
      window,
      now,
      store,
      fetchRows: () => Promise.resolve(rows),
      writeRows: (r) => store.upsertGa4Rows(ownerId, CONNECTION, r),
    });
  }

  it('running the same window three times does not add rows', async () => {
    const store = new MemoryStore();
    await runGa4(store, sampleRows);
    const afterFirst = store.ga4.size;
    await runGa4(store, sampleRows);
    await runGa4(store, sampleRows);

    expect(afterFirst).toBe(2);
    expect(store.ga4.size).toBe(2);
    // One logical run, so one sync_runs row however many attempts it took.
    expect(store.runs.size).toBe(1);
  });

  it('late corrections update the existing row rather than adding one', async () => {
    const store = new MemoryStore();
    await runGa4(store, sampleRows);

    const corrected: Ga4DailyRow[] = [{ ...sampleRows[0], sessions: 14 }];
    await runGa4(store, corrected);

    expect(store.ga4.size).toBe(2);
    const row = store.rowsFor(OWNER_A).find((r) => r.source === 'google');
    expect(row?.sessions).toBe(14);
  });

  it('never stores an unfinished day even if the provider returns one', async () => {
    const store = new MemoryStore();
    const withToday: Ga4DailyRow[] = [
      ...sampleRows,
      { ...sampleRows[0], date: '2026-09-30', sessions: 3 },
    ];

    const result = await runGa4(store, withToday);

    expect(result.rowsRead).toBe(3);
    expect(result.rowsWritten).toBe(2);
    expect([...store.ga4.keys()].some((k) => k.includes('2026-09-30'))).toBe(false);
  });

  it('keeps two owners apart even with identical rows', async () => {
    const store = new MemoryStore();
    await runGa4(store, sampleRows, NOW, OWNER_A);
    await runGa4(store, sampleRows, NOW, OWNER_B);

    expect(store.ga4.size).toBe(4);
    expect(store.rowsFor(OWNER_A)).toHaveLength(2);
    expect(store.rowsFor(OWNER_B)).toHaveLength(2);
    expect(store.rowsFor(OWNER_A).every((r) => r.owner_id === OWNER_A)).toBe(true);
    // Same logical run for two owners is two sync_runs rows, not one.
    expect(store.runs.size).toBe(2);
  });

  it('records a failure as a failure, with a reason and no credentials', async () => {
    const store = new MemoryStore();
    const result = await runSync<Ga4DailyRow>({
      ownerId: OWNER_A,
      connectionId: CONNECTION,
      provider: 'ga4',
      idempotencyKey: idempotencyKey('ga4', 'daily', window),
      window,
      now: NOW,
      store,
      fetchRows: () => Promise.reject(new Error('refused: access_token=ya29.super-secret-value')),
      writeRows: () => Promise.resolve(0),
    });

    expect(result.status).toBe('failed');
    expect(result.rowsWritten).toBe(0);

    const run = [...store.runs.values()][0];
    expect(run.status).toBe('failed');
    expect(run.completedAt).not.toBeNull();
    expect(run.errorSummary).toBeTruthy();
    expect(run.errorSummary).not.toContain('ya29');
    expect(run.errorSummary).not.toContain('super-secret-value');
    // Nothing was written, and nothing was removed either.
    expect(store.ga4.size).toBe(0);
  });

  it('marks the attempt running before it marks it finished', async () => {
    const store = new MemoryStore();
    await runGa4(store, sampleRows);
    expect(store.runHistory.map((r) => r.status)).toEqual(['running', 'succeeded']);
  });

  it('skips rather than fails when the window is entirely unfinished', async () => {
    const store = new MemoryStore();
    const result = await runSync<Ga4DailyRow>({
      ownerId: OWNER_A,
      connectionId: CONNECTION,
      provider: 'ga4',
      idempotencyKey: 'ga4:manual:2026-09-30:2026-09-30',
      window: { start: '2026-09-30', end: '2026-09-30' },
      now: NOW,
      store,
      fetchRows: () => Promise.reject(new Error('should never be called')),
      writeRows: () => Promise.resolve(0),
    });

    expect(result.status).toBe('skipped');
    expect(store.ga4.size).toBe(0);
  });

  it('a successful retry after a failure leaves one run row, marked succeeded', async () => {
    const store = new MemoryStore();
    const key = idempotencyKey('ga4', 'daily', window);

    await runSync<Ga4DailyRow>({
      ownerId: OWNER_A, connectionId: CONNECTION, provider: 'ga4', idempotencyKey: key,
      window, now: NOW, store,
      fetchRows: () => Promise.reject(new Error('network down')),
      writeRows: (r) => store.upsertGa4Rows(OWNER_A, CONNECTION, r),
    });
    await runGa4(store, sampleRows);

    expect(store.runs.size).toBe(1);
    expect([...store.runs.values()][0].status).toBe('succeeded');
  });
});

describe('nothing secret escapes', () => {
  it('redacts tokens, keys and assertions from error text', () => {
    expect(redact('access_token=ya29.abcdefghijklmnop')).not.toContain('ya29');
    expect(redact('-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----'))
      .toBe('[redacted key]');
    expect(sanitizeError(new Error('client_secret: hunter2hunter2'))).not.toContain('hunter2');
    expect(sanitizeError({ refresh_token: '1//0abcdefghijklmnopqrst' })).not.toContain('1//0abc');
  });

  it('always returns something storable', () => {
    expect(sanitizeError(new Error(''))).toBe('Error');
    expect(sanitizeError(null)).toBeTruthy();
    expect(sanitizeError('x'.repeat(5000)).length).toBeLessThanOrEqual(500);
  });

  it('refuses a service account key that is not a key, without echoing it', () => {
    expect(() => parseServiceAccountKey('')).toThrow(/empty/i);
    expect(() => parseServiceAccountKey('{"client_email":"a@b.com"}')).toThrow(/private_key/);
    try {
      parseServiceAccountKey('{ not json at all');
    } catch (error) {
      expect((error as Error).message).not.toContain('not json at all');
    }
  });

  it('accepts a key with escaped newlines, which is how it usually arrives', () => {
    const key = parseServiceAccountKey(JSON.stringify({
      client_email: 'sync@sitelaunch.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n',
    }));
    expect(key.private_key).toContain('\n');
    expect(key.private_key).not.toContain('\\n');
  });

  it('describes the credential by its email only', () => {
    const source = new ServiceAccountTokenSource({
      client_email: 'sync@sitelaunch.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
    });
    expect(source.describe()).toBe('sync@sitelaunch.iam.gserviceaccount.com');
    expect(JSON.stringify(source.describe())).not.toContain('BEGIN PRIVATE KEY');
  });
});

describe('the browser bundle stays clear of Google', () => {
  /**
   * Every file under src that actually reaches a browser.
   *
   * Test files are excluded deliberately. They are not bundled, and they name
   * forbidden strings on purpose in order to assert their absence, so scanning
   * them would flag the guards rather than the leaks.
   */
  function filesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        return entry === 'test' ? [] : filesUnder(full);
      }
      if (/\.test\.tsx?$/.test(entry)) return [];
      return /\.tsx?$/.test(entry) ? [full] : [];
    });
  }

  const sourceFiles = filesUnder('src');

  it('has no Google API endpoint anywhere in src', () => {
    const offenders = sourceFiles.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /analyticsdata\.googleapis\.com|searchconsole\.googleapis\.com|oauth2\.googleapis\.com/
        .test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('has no credential material anywhere in src', () => {
    const offenders = sourceFiles.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /private_key|client_secret|service_role|BEGIN PRIVATE KEY|GOOGLE_SERVICE_ACCOUNT/
        .test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('exposes no VITE_ variable that could carry a Google credential', () => {
    const offenders = sourceFiles.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /import\.meta\.env\.VITE_[A-Z_]*(GOOGLE|GA4|SEARCH_CONSOLE|SERVICE)/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

describe('who a sync is allowed to run as', () => {
  const env = { cronSecret: 'cron-secret-value', cronOwnerId: OWNER_A };
  const verifyAsB = () => Promise.resolve(OWNER_B);
  const verifyNobody = () => Promise.resolve(null);

  it('takes the owner from a verified session, not from the request', async () => {
    const caller = await resolveCaller(
      { authorization: 'Bearer good-token' }, env, verifyAsB,
    );
    expect(caller).toEqual({ ownerId: OWNER_B, via: 'user' });
  });

  it('refuses a session it cannot verify', async () => {
    expect(await resolveCaller(
      { authorization: 'Bearer forged' }, env, verifyNobody,
    )).toBeNull();
  });

  it('refuses a request carrying no credentials at all', async () => {
    expect(await resolveCaller({}, env, verifyAsB)).toBeNull();
  });

  it('lets the scheduler in with the right secret, as the configured owner', async () => {
    const caller = await resolveCaller(
      { [CRON_SECRET_HEADER]: 'cron-secret-value' }, env, verifyNobody,
    );
    expect(caller).toEqual({ ownerId: OWNER_A, via: 'cron' });
  });

  it('refuses a wrong scheduler secret and never falls back to the session', async () => {
    expect(await resolveCaller(
      { [CRON_SECRET_HEADER]: 'wrong', authorization: 'Bearer good-token' }, env, verifyAsB,
    )).toBeNull();
  });

  it('refuses the scheduler when no secret is configured', async () => {
    expect(await resolveCaller(
      { [CRON_SECRET_HEADER]: 'anything' },
      { cronSecret: null, cronOwnerId: OWNER_A },
      verifyNobody,
    )).toBeNull();
  });

  it('ignores an owner id supplied by the caller', async () => {
    // Header casing varies by runtime, and a body field must never be consulted.
    const caller = await resolveCaller(
      { Authorization: 'Bearer good-token', 'x-owner-id': OWNER_A }, env, verifyAsB,
    );
    expect(caller?.ownerId).toBe(OWNER_B);
  });

  it('compares secrets without leaking their length', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch(null, 'abc')).toBe(false);
  });
});
