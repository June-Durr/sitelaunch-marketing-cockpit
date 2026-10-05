/**
 * What the interface is allowed to say about connected analytics.
 *
 * GA4 and Search Console really are connected and syncing daily, so the screens
 * had to stop claiming otherwise. These tests pin the places that claim used to
 * leak out: the sidebar caption, the Data and Import introduction, the schedule
 * column, and a second table that reported both providers as not set up directly
 * underneath the table reporting them as connected.
 *
 * Supabase mode is reached by supplying the data context directly rather than by
 * putting credentials on disk. What is under test is the markup a given repository
 * state produces, so a stub state is the honest way to drive it, and it keeps the
 * suite from depending on a live project. Browser-only mode goes through the real
 * provider and the real local adapter, because that path has to stay honest too.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppShell } from '../components/AppShell';
import { DataContext, type DataContextValue } from '../data/context';
import { DataProvider } from '../data/DataProvider';
import { DataImport } from '../screens/DataImport';
import { WebsiteOutcomes } from '../screens/WebsiteOutcomes';
import { buildSeedDataset } from '../data/seed';
import type { AnalyticsStatus } from '../data/repository';
import type {
  Ga4DailyTraffic, IntegrationConnection, SearchConsoleDaily, SyncRun,
} from '../types/integrations';

/* ------------------------------------------------------------- fixtures -- */

const SYNCED_AT = '2026-09-30T08:02:00.000Z';

function connection(
  provider: 'ga4' | 'search_console',
  property: string,
): IntegrationConnection {
  return {
    id: `conn-${provider}`,
    provider,
    provider_account_id: property,
    display_name: null,
    status: 'connected',
    granted_scopes: [],
    connected_at: '2026-09-25T08:00:00.000Z',
    last_synced_at: SYNCED_AT,
    error_message: null,
    error_at: null,
    created_at: '2026-09-25T08:00:00.000Z',
    updated_at: SYNCED_AT,
  };
}

function run(provider: 'ga4' | 'search_console'): SyncRun {
  return {
    id: `run-${provider}`,
    connection_id: `conn-${provider}`,
    provider,
    started_at: '2026-09-30T08:00:00.000Z',
    completed_at: SYNCED_AT,
    status: 'succeeded',
    rows_read: 90,
    rows_written: 90,
    error_summary: null,
    idempotency_key: `${provider}-2026-09-30`,
    details: {},
    created_at: SYNCED_AT,
  };
}

/**
 * GA4 rows where the last one has no sessions and no enquiry events recorded, and
 * every row has a genuine zero for engaged sessions. That pairing is what keeps the
 * null-versus-zero rule under test rather than assumed.
 */
function ga4Rows(count: number): Ga4DailyTraffic[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ga4-${i}`,
    connection_id: 'conn-ga4',
    date: `2026-09-${String(30 - (i % 30)).padStart(2, '0')}`,
    source: 'google',
    medium: 'organic',
    campaign: '(not set)',
    sessions: i === count - 1 ? null : i,
    active_users: i,
    new_users: null,
    engaged_sessions: 0,
    engagement_time_secs: null,
    bounce_rate: null,
    conversions: null,
    generate_lead_events: i === count - 1 ? null : 0,
    synced_at: SYNCED_AT,
    created_at: SYNCED_AT,
    updated_at: SYNCED_AT,
  }));
}

function searchRows(count: number): SearchConsoleDaily[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sc-${i}`,
    connection_id: 'conn-search_console',
    date: `2026-09-${String(30 - (i % 30)).padStart(2, '0')}`,
    query: `web design miami ${i}`,
    page: 'https://sitelaunchstudios.com/',
    country: 'usa',
    device: 'desktop',
    clicks: 1,
    impressions: 10,
    ctr: null,
    average_position: null,
    synced_at: SYNCED_AT,
    created_at: SYNCED_AT,
    updated_at: SYNCED_AT,
  }));
}

function analytics(ga4Count: number, searchCount: number): AnalyticsStatus {
  return {
    connections: [
      connection('ga4', 'properties/123456'),
      connection('search_console', 'sc-domain:sitelaunchstudios.com'),
    ],
    runs: [run('ga4'), run('search_console')],
    ga4: ga4Rows(ga4Count),
    searchConsole: searchRows(searchCount),
  };
}

/* -------------------------------------------------------------- harness -- */

/** A Supabase-mode context over the seed dataset, with the sync tables stubbed. */
function supabaseContext(status: AnalyticsStatus): DataContextValue {
  const unused = () => {
    throw new Error('these tests do not write');
  };
  return {
    data: buildSeedDataset(),
    mode: 'supabase',
    loading: false,
    error: null,
    refresh: async () => {},
    insert: unused,
    insertMany: unused,
    update: unused,
    remove: async () => unused(),
    resetToSeed: null,
    replaceAll: null,
    importDataset: async () => unused(),
    loadAnalytics: async () => status,
    // The lead mirror has its own panel and its own tests; these assert the
    // analytics panel, so it is wired as unavailable rather than stubbed.
    loadLeadMirror: null,
    triggerLeadMirror: null,
    triggerSync: async () => ({ ok: true, status: 'succeeded', rowsWritten: 0, error: null }),
  };
}

function renderSupabase(path: string, element: ReactNode, status = analytics(4, 3)) {
  return render(
    <DataContext.Provider value={supabaseContext(status)}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path={path} element={element} />
          </Route>
        </Routes>
      </MemoryRouter>
    </DataContext.Provider>,
  );
}

/** Browser-only mode, through the real provider and the real local adapter. */
function renderLocal(path: string, element: ReactNode) {
  return render(
    <DataProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path={path} element={element} />
          </Route>
        </Routes>
      </MemoryRouter>
    </DataProvider>,
  );
}

const sectionFor = (title: string) =>
  screen.getByText(title).closest('section') as HTMLElement;

const headFor = (title: string) =>
  screen.getByText(title).closest('.section-head') as HTMLElement;

/* -------------------------------------------------------- the old claim -- */

describe('the outdated claim that nothing is connected is gone', () => {
  it('has left the sidebar, which now names what syncs and what does not', async () => {
    renderSupabase('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    const sidebar = document.querySelector('.sidebar-foot') as HTMLElement;
    expect(sidebar.textContent).not.toMatch(/Nothing is wired up/i);
    expect(sidebar.textContent).toMatch(/Saved to Supabase/);
    expect(sidebar.textContent).toMatch(
      /Google Analytics and Search Console sync themselves daily/,
    );
    // The platforms that really are still manual are named as such.
    expect(sidebar.textContent).toMatch(/Instagram,\s+Facebook, LinkedIn and TikTok/);
    expect(sidebar.textContent).toMatch(/typed in by hand/);
  });

  it('has left the Data and Import introduction', async () => {
    renderSupabase('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    const lede = document.querySelector('.page-head .page-lede') as HTMLElement;
    expect(lede.textContent).not.toMatch(/Nothing is wired up/i);
    // Automatic, fallback, and not connected yet are each stated separately.
    expect(lede.textContent).toMatch(
      /Google Analytics and Search Console sync on a\s+daily schedule/,
    );
    expect(lede.textContent).toMatch(/fallbacks/);
    expect(lede.textContent).toMatch(/Instagram, Facebook, LinkedIn, TikTok,\s+Calendar/);
    expect(lede.textContent).toMatch(/not connected yet/);
  });

  it('appears nowhere on the whole Data and Import screen', async () => {
    renderSupabase('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Remaining integrations')).toBeTruthy());

    expect(document.body.textContent).not.toMatch(/Nothing is wired up/i);
    expect(document.body.textContent).not.toMatch(/None of these are connected/i);
    expect(document.body.textContent).not.toMatch(/once switched on/i);
  });
});

/* ------------------------------------------------- one answer per question -- */

describe('connected Google analytics are reported once, by GoogleSyncPanel', () => {
  it('shows both providers as connected, with the property the server recorded', async () => {
    renderSupabase('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Automatic analytics')).toBeTruthy());

    const panel = sectionFor('Automatic analytics');
    expect(within(panel).getByText('Google Analytics 4')).toBeTruthy();
    expect(within(panel).getByText('Search Console')).toBeTruthy();
    expect(within(panel).getAllByText('Connected')).toHaveLength(2);
    expect(within(panel).getByText('properties/123456')).toBeTruthy();
  });

  it('states the live schedule as a fact, with no "once switched on" hedge', async () => {
    renderSupabase('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Automatic analytics')).toBeTruthy());

    const panel = sectionFor('Automatic analytics');
    expect(within(panel).getByText('08:00 UTC daily')).toBeTruthy();
    expect(within(panel).getByText('08:15 UTC daily')).toBeTruthy();
    expect(panel.textContent).not.toMatch(/once switched on/i);
  });

  it('does not list GA4 or Search Console again under the remaining integrations', async () => {
    renderSupabase('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Remaining integrations')).toBeTruthy());

    const remaining = sectionFor('Remaining integrations');
    expect(within(remaining).queryByText('Google Analytics')).toBeNull();
    expect(within(remaining).queryByText('Google Search Console')).toBeNull();

    // So every "not set up" row left is a service that really is not set up.
    const rows = within(remaining)
      .getAllByText('Not set up')
      .map((tag) => (tag.closest('tr') as HTMLElement).textContent ?? '');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toMatch(/Google Analytics|Search Console/);
    }
  });

  it('never reports a provider as both connected and not set up', async () => {
    renderSupabase('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Remaining integrations')).toBeTruthy());

    // Only the Google panel claims anything is connected, and nothing anywhere
    // else on the screen contradicts it.
    const sections = screen
      .getAllByText('Connected')
      .map((tag) => tag.closest('section') as HTMLElement);
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section.querySelector('.section-title')?.textContent).toBe('Automatic analytics');
    }
  });

  it('counts the remaining services honestly in the section note', async () => {
    renderSupabase('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Remaining integrations')).toBeTruthy());

    // Six are left once the two syncing providers come out of the list.
    expect(headFor('Remaining integrations').textContent).toMatch(/none of these 6 yet/);
    expect(sectionFor('Remaining integrations').querySelectorAll('tbody tr')).toHaveLength(6);
  });

  it('keeps the manual CSV importer, labelled as the fallback it is', async () => {
    renderSupabase('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Import a GA4 traffic export')).toBeTruthy());

    const section = sectionFor('Import a GA4 traffic export');
    expect(section.querySelector('input[type="file"]')).toBeTruthy();
    expect(section.textContent).toMatch(/fallback/i);
    expect(section.textContent).toMatch(/The daily sync above covers Google Analytics/);
    expect(section.textContent).toMatch(/never fills a gap with a zero/);
  });

  it('explains the exclusion by pointing at the panel that does report them', async () => {
    renderSupabase('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Remaining integrations')).toBeTruthy());

    expect(sectionFor('Remaining integrations').textContent).toMatch(
      /They are connected and syncing, and Automatic analytics above reports/,
    );
  });
});

/* ----------------------------------------------------------- synced rows -- */

describe('synced totals are counted in rows, not days', () => {
  it('labels the section note as rows', async () => {
    renderSupabase('/website', <WebsiteOutcomes key="w" />, analytics(90, 46));
    await waitFor(() => expect(screen.getByText('Brought in automatically')).toBeTruthy());

    const head = headFor('Brought in automatically');
    expect(head.textContent).toMatch(/136 synced rows/);
    expect(head.textContent).not.toMatch(/days/);
  });

  it('counts the per-figure notes in rows too', async () => {
    renderSupabase('/website', <WebsiteOutcomes key="w" />, analytics(90, 46));
    await waitFor(() => expect(screen.getByText('Brought in automatically')).toBeTruthy());

    const notes = [...sectionFor('Brought in automatically').querySelectorAll('.stat-note')]
      .map((n) => n.textContent ?? '');
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note).toMatch(/rows have a figure/);
      expect(note).not.toMatch(/days/);
    }
    // 89 of the 90 GA4 rows carry a sessions figure. The last one carries none.
    expect(notes.some((n) => /89 of 90 rows have a figure/.test(n))).toBe(true);
  });

  it('says so when a table is showing only the newest slice', async () => {
    renderSupabase('/website', <WebsiteOutcomes key="w" />, analytics(90, 46));
    await waitFor(() => expect(screen.getByText('Brought in automatically')).toBeTruthy());

    expect(screen.getByText(/Showing the latest 50 of 90 rows/)).toBeTruthy();
    // Search Console fits inside the window, so only one notice appears.
    expect(screen.getAllByText(/Showing the latest/)).toHaveLength(1);
    expect(
      sectionFor('Brought in automatically').querySelectorAll('tbody tr'),
    ).toHaveLength(96);
  });

  it('says nothing about truncation when everything is on screen', async () => {
    renderSupabase('/website', <WebsiteOutcomes key="w" />, analytics(4, 3));
    await waitFor(() => expect(screen.getByText('Brought in automatically')).toBeTruthy());

    expect(screen.queryByText(/Showing the latest/)).toBeNull();
    expect(headFor('Brought in automatically').textContent).toMatch(/7 synced rows/);
  });

  it('still shows a missing synced figure as not checked rather than zero', async () => {
    renderSupabase('/website', <WebsiteOutcomes key="w" />, analytics(4, 3));
    await waitFor(() => expect(screen.getByText('Brought in automatically')).toBeTruthy());

    const section = sectionFor('Brought in automatically');
    // The last GA4 row has no sessions recorded, and every row has a real zero
    // for engaged sessions. The two must not render the same way.
    expect(within(section).getAllByText('Not checked').length).toBeGreaterThan(0);
    expect(within(section).getAllByTitle(/This is not a zero\./).length).toBeGreaterThan(0);
    expect(within(section).getAllByText('0').length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------- /website -- */

describe('the Website Outcomes screen', () => {
  it('still renders, with the automatic section below the manual table', async () => {
    renderSupabase('/website', <WebsiteOutcomes key="w" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Website Outcomes');
    expect(screen.getByText('Brought in automatically')).toBeTruthy();
  });

  it('introduces the two tables as rows from two places, not as days', async () => {
    renderSupabase('/website', <WebsiteOutcomes key="w" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    const lede = document.querySelector('.page-head .page-lede') as HTMLElement;
    expect(lede.textContent).toMatch(/sync\s+themselves daily/);
    expect(lede.textContent).toMatch(/the rows they bring in appear further down/);
    expect(lede.textContent).toMatch(/counted separately on purpose/);
    expect(lede.textContent).not.toMatch(/those days appear/);
  });

  it('keeps synced rows out of the manual totals, so no period is counted twice', async () => {
    const seeded = buildSeedDataset();
    const manual = seeded.traffic.reduce((sum, t) => sum + (t.sessions ?? 0), 0);

    renderSupabase('/website', <WebsiteOutcomes key="w" />, analytics(90, 46));
    await waitFor(() => expect(screen.getByText('Brought in automatically')).toBeTruthy());

    // The headline Visits stat counts the manual rows and nothing else.
    const visits = screen.getByText('Visits').closest('.stat') as HTMLElement;
    expect(visits.querySelector('.stat-value')?.textContent).toBe(manual.toLocaleString());
    expect(visits.querySelector('.stat-note')?.textContent).toMatch(
      new RegExp(`of ${seeded.traffic.length} rows`),
    );

    // The synced visits are reported separately, and are a different number.
    const synced = within(sectionFor('Brought in automatically'))
      .getByText('Visits, synced')
      .closest('.stat') as HTMLElement;
    expect(synced.querySelector('.stat-value')?.textContent).not.toBe(manual.toLocaleString());
  });

  it('drops the misleading nav badge that counted manual rows only', async () => {
    renderSupabase('/website', <WebsiteOutcomes key="w" />, analytics(90, 46));
    await waitFor(() => expect(screen.getByText('Brought in automatically')).toBeTruthy());

    expect(
      screen.getByRole('link', { name: /Website Outcomes/ }).querySelector('.nav-count'),
    ).toBeNull();
    // The other badges are untouched.
    expect(
      screen.getByRole('link', { name: /Content Log/ }).querySelector('.nav-count')?.textContent,
    ).toBe('3');
  });
});

/* ----------------------------------------------------------- local mode -- */

describe('browser-only mode still describes itself honestly', () => {
  it('claims no sync in the sidebar', async () => {
    renderLocal('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    const sidebar = document.querySelector('.sidebar-foot') as HTMLElement;
    expect(sidebar.textContent).toMatch(/Saved in this browser only/);
    expect(sidebar.textContent).toMatch(/Nothing syncs in this mode/);
    expect(sidebar.textContent).not.toMatch(/sync themselves daily/);
    expect(sidebar.textContent).not.toMatch(/Nothing is wired up/i);
  });

  it('says automatic analytics is not available, and offers no invented state', async () => {
    renderLocal('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Automatic analytics')).toBeTruthy());

    expect(headFor('Automatic analytics').textContent).toMatch(/not available here/);
    const panel = sectionFor('Automatic analytics');
    expect(panel.textContent).toMatch(/once this\s+cockpit is on Supabase/);
    expect(within(panel).queryByText('Connected')).toBeNull();
    expect(panel.querySelector('table')).toBeNull();
  });

  it('does not promise a daily sync in the page introduction', async () => {
    renderLocal('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    const lede = document.querySelector('.page-head .page-lede') as HTMLElement;
    expect(lede.textContent).toMatch(/Nothing syncs in browser-only mode/);
    expect(lede.textContent).not.toMatch(/Nothing is wired up/i);
    expect(lede.textContent).not.toMatch(/daily schedule/);
  });

  it('renders no synced analytics section on Website Outcomes', async () => {
    renderLocal('/website', <WebsiteOutcomes key="w" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    expect(screen.queryByText('Brought in automatically')).toBeNull();
  });

  it('does not point Website Outcomes at a synced table that is not there', async () => {
    renderLocal('/website', <WebsiteOutcomes key="w" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    const lede = document.querySelector('.page-head .page-lede') as HTMLElement;
    expect(lede.textContent).toMatch(/Nothing syncs in browser-only mode/);
    expect(lede.textContent).not.toMatch(/sync\s+themselves daily/);
    expect(lede.textContent).not.toMatch(/further down/);
  });

  it('still lists the remaining integrations, with the Supabase-first note', async () => {
    renderLocal('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Remaining integrations')).toBeTruthy());

    const remaining = sectionFor('Remaining integrations');
    expect(remaining.textContent).toMatch(/Supabase comes first/);
    expect(within(remaining).queryByText('Google Analytics')).toBeNull();
    expect(remaining.querySelectorAll('tbody tr')).toHaveLength(6);
  });

  it('does not claim Google is connected and syncing while explaining its absence', async () => {
    renderLocal('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Remaining integrations')).toBeTruthy());

    // The reason GA4 and Search Console are left out of this table has to hold in
    // browser-only mode too, where they are not connected to anything.
    const remaining = sectionFor('Remaining integrations');
    expect(remaining.textContent).not.toMatch(/They are connected and syncing/);
    expect(remaining.textContent).toMatch(/nothing to report yet/);
  });

  it('does not call the CSV importer a fallback to a sync that is not running', async () => {
    renderLocal('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByText('Import a GA4 traffic export')).toBeTruthy());

    const section = sectionFor('Import a GA4 traffic export');
    expect(section.textContent).not.toMatch(/The daily sync above covers/);
    expect(section.textContent).toMatch(/Nothing syncs in browser-only mode/);
    // It is still the real importer, with the same no-zeroes promise.
    expect(section.querySelector('input[type="file"]')).toBeTruthy();
    expect(section.textContent).toMatch(/never fills a gap with a zero/);
  });
});

/* ------------------------------------------------------------------------ */

describe('a failure belonging to another integration is not blamed on these two', () => {
  /**
   * sync_runs is one table shared by every provider.
   *
   * Found by looking at the real screen rather than by reasoning about it: the
   * lead mirror's first failed run appeared in this panel captioned "Search
   * Console failed", because the caption came from a two-way ternary that treated
   * everything that was not ga4 as Search Console. Showing somebody a failure
   * against a service that is working is worse than showing nothing: they go and
   * investigate the wrong thing.
   */
  function runFor(
    provider: IntegrationConnection['provider'],
    status: SyncRun['status'],
    summary: string | null,
  ): SyncRun {
    return {
      id: `run-${provider}-${status}`,
      connection_id: null,
      provider,
      started_at: '2026-10-05T19:39:00.000Z',
      completed_at: '2026-10-05T19:39:02.000Z',
      status,
      rows_read: null,
      rows_written: null,
      error_summary: summary,
      idempotency_key: `${provider}-failed`,
      details: {},
      created_at: '2026-10-05T19:39:02.000Z',
    };
  }

  const withForeignFailure = (): AnalyticsStatus => ({
    ...analytics(4, 3),
    runs: [
      runFor(
        'google_sheets',
        'failed',
        'Google Sheets GET failed (HTTP 403): PERMISSION_DENIED',
      ),
      ...analytics(4, 3).runs,
    ],
  });

  it('does not report the lead mirror\u2019s failure as a Search Console failure', async () => {
    renderSupabase('/data', <DataImport key="d" />, withForeignFailure());
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    const section = sectionFor('Automatic analytics');
    await waitFor(() => expect(within(section).getByText('Google Analytics 4')).toBeTruthy());

    expect(section.textContent).not.toContain('Search Console failed');
    expect(section.textContent).not.toContain('PERMISSION_DENIED');
  });

  it('still reports a real failure of one of its own two providers', async () => {
    const broken: AnalyticsStatus = {
      ...analytics(4, 3),
      runs: [
        runFor('search_console', 'failed', 'Search Console query failed (HTTP 500)'),
        ...analytics(4, 3).runs,
      ],
    };
    renderSupabase('/data', <DataImport key="d" />, broken);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    const section = sectionFor('Automatic analytics');
    await waitFor(() => expect(section.textContent).toContain('HTTP 500'));
    expect(section.textContent).toContain('Google Search Console');
  });
});
