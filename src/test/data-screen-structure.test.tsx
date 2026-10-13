/**
 * The shape of Data & Import, asserted so a tidy-up cannot quietly undo it.
 *
 * The complaint this screen answers was that everything on it looked the same,
 * so finding the calendar meant reading until you hit it. The fix was structural
 * rather than decorative: five groups, a card per service, each with its own
 * mark, and the prose folded away behind a disclosure.
 *
 * What is tested here is the part of that which is a claim about truth rather
 * than about taste. A duplicated anchor id breaks the jump bar silently. A
 * manual tool filed among the automatic ones tells somebody a CSV import syncs
 * itself. A card with no accessible name is invisible to a screen reader. None
 * of those shows up in a screenshot.
 *
 * Every fixture here is invented and no test writes anything.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppShell } from '../components/AppShell';
import { DataContext, type DataContextValue } from '../data/context';
import { DataImport } from '../screens/DataImport';
import { DATA_SECTIONS } from '../config/dataSections';
import { buildSeedDataset } from '../data/seed';
import type { AnalyticsStatus, CalendarStatus } from '../data/repository';
import type { IntegrationConnection } from '../types/integrations';

/* ------------------------------------------------------------- fixtures -- */

function connection(over: Partial<IntegrationConnection>): IntegrationConnection {
  return {
    id: `conn-${over.provider}`,
    provider: 'ga4',
    provider_account_id: null,
    display_name: null,
    status: 'connected',
    granted_scopes: [],
    connected_at: '2026-10-01T08:00:00.000Z',
    last_synced_at: '2026-10-11T08:00:00.000Z',
    error_message: null,
    error_at: null,
    created_at: '2026-10-01T08:00:00.000Z',
    updated_at: '2026-10-11T08:00:00.000Z',
    ...over,
  };
}

const analytics: AnalyticsStatus = {
  connections: [
    connection({ provider: 'ga4', provider_account_id: 'properties/123456' }),
    connection({
      provider: 'search_console',
      provider_account_id: 'https://example.test/',
    }),
  ],
  runs: [
    {
      id: 'run-ga4',
      connection_id: 'conn-ga4',
      provider: 'ga4',
      started_at: '2026-10-11T08:00:00.000Z',
      completed_at: '2026-10-11T08:01:00.000Z',
      status: 'succeeded',
      rows_read: 10,
      rows_written: 10,
      error_summary: null,
      idempotency_key: 'ga4:daily:2026-10-11',
      details: {},
      created_at: '2026-10-11T08:01:00.000Z',
    },
  ],
  ga4: [],
  searchConsole: [],
};

/** A deliberately long address, which is the one that used to widen the page. */
const LONG_EMAIL = 'alberto.camacho.junior.business@averyverylongdomainname.example';

const calendar: CalendarStatus = {
  connection: connection({
    provider: 'google_calendar',
    provider_account_id: 'primary',
    display_name: LONG_EMAIL,
  }),
  runs: [],
};

function context(over: Partial<DataContextValue> = {}): DataContextValue {
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
    loadAnalytics: async () => analytics,
    triggerSync: async () => ({ ok: true, status: 'succeeded', rowsWritten: 1, error: null }),
    loadLeadMirror: null,
    triggerLeadMirror: null,
    loadCalendar: async () => calendar,
    triggerCalendarSync: async () => ({
      ok: true, status: 'succeeded', created: 0, updated: 19, failed: 0, tasks: 19,
      stoppedEarly: null, error: null,
    }),
    completeTaskDurably: null,
    undoTaskOperation: null,
    skipTaskDurably: null,
    softDeleteTask: null,
    loadRecentlyDeleted: null,
    loadSyncPending: null,
    drainSyncJobs: null,
    startCalendarOAuth: async () => ({ status: 'ready', authorizeUrl: null, error: null }),
    disconnectCalendar: async () => ({
      ok: true, status: 'disconnected', revokedAtGoogle: true, eventsRemoved: false,
      error: null,
    }),
    ...over,
  };
}

async function openData(value: DataContextValue = context()) {
  render(
    <DataContext.Provider value={value}>
      <MemoryRouter initialEntries={['/data']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/data" element={<DataImport key="d" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </DataContext.Provider>,
  );
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
  await waitFor(() => expect(document.getElementById('analytics')).toBeTruthy());
}

const group = (id: string) => document.getElementById(id) as HTMLElement;
/**
 * One integration card, found by its heading.
 *
 * By heading rather than by text: "Instagram" is also a row in the Accounts
 * table, and getByText would find two and throw.
 */
const card = (title: string | RegExp) =>
  screen.getByRole('heading', { name: title }).closest('article') as HTMLElement;

/* ====================================================== anchors and groups === */

describe('the screen is divided into groups the jump bar can reach', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('gives every navigator item a target that exists', async () => {
    await openData();
    for (const { id, label } of DATA_SECTIONS) {
      expect(group(id), `${label} points at #${id}, which is not on the page`).toBeTruthy();
    }
  });

  it('uses each anchor id exactly once', async () => {
    await openData();
    for (const { id } of DATA_SECTIONS) {
      // A duplicate id does not throw. It silently sends the jump bar to
      // whichever element the browser happened to find first.
      // An attribute selector rather than CSS.escape, which jsdom does not
      // implement. Every id here is a plain word, so the two agree anyway.
      expect(
        document.querySelectorAll(`[id="${id}"]`),
        `#${id} appears more than once`,
      ).toHaveLength(1);
    }
    const ids = DATA_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('renders the jump bar as real links, in order', async () => {
    await openData();
    const nav = screen.getByRole('navigation', { name: 'Jump to a section' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(
      DATA_SECTIONS.map((s) => s.label),
    );
    // Anchors, so they are focusable and middle-clickable. A div with a click
    // handler would be neither.
    for (const [i, link] of links.entries()) {
      expect(link.getAttribute('href')).toBe(`#${DATA_SECTIONS[i].id}`);
    }
  });

  it('keeps every jump bar label visible rather than leaving bare icons', async () => {
    await openData();
    const nav = screen.getByRole('navigation', { name: 'Jump to a section' });
    for (const link of within(nav).getAllByRole('link')) {
      expect(link.textContent?.trim()).not.toBe('');
    }
  });

  it('names each group with a heading', async () => {
    await openData();
    for (const title of [
      'Automatic analytics',
      'Relationships and follow-up',
      'Remaining automatic connections',
      'Manual fallback tools',
      'Program and account settings',
    ]) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
  });
});

/* ============================================= one icon and label per service === */

describe('every service carries a mark and a visible name', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('gives each integration card an icon and a readable title', async () => {
    await openData();
    for (const title of [
      'Google Analytics 4',
      'Search Console',
      'Google Calendar',
      'Website enquiry forms',
      'Instagram',
      'Facebook',
      'LinkedIn',
      'TikTok',
    ]) {
      const el = card(title);
      expect(el, `${title} has no card`).toBeTruthy();
      expect(el.querySelector('svg'), `${title} has no icon`).toBeTruthy();
      // The name is text, not only a picture.
      expect(within(el).getByRole('heading', { name: title })).toBeTruthy();
    }
  });

  it('marks every decorative icon aria-hidden', async () => {
    await openData();
    // These sit beside their own visible titles, so a screen reader announcing
    // them would read everything twice.
    for (const svg of document.querySelectorAll('.int-card-top svg, .nav-link svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('role')).toBeNull();
    }
  });

  it('does not give the same provider two cards', async () => {
    await openData();
    for (const title of ['Google Analytics 4', 'Search Console', 'Google Calendar']) {
      expect(
        screen.getAllByRole('heading', { name: title }),
        `${title} is on the page twice`,
      ).toHaveLength(1);
    }
  });
});

/* ======================================== the groups mean what they say === */

describe('automatic and manual are kept apart', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('files the CSV importer and the backup under manual fallback', async () => {
    await openData();
    const fallback = group('fallback');
    expect(fallback.contains(card('Import a GA4 traffic export'))).toBe(true);
    expect(fallback.contains(card('Backup and restore'))).toBe(true);
  });

  it('keeps those two out of every automatic group', async () => {
    await openData();
    // Filing a CSV import beside a daily sync would say it syncs itself.
    for (const id of ['analytics', 'leads', 'social']) {
      expect(group(id).textContent).not.toMatch(/Import a GA4 traffic export/);
      expect(group(id).textContent).not.toMatch(/Backup and restore/);
    }
  });

  it('files accounts and the program under settings', async () => {
    await openData();
    const settings = group('settings');
    expect(settings.contains(card('Accounts'))).toBe(true);
    expect(settings.contains(card('The 90-day program'))).toBe(true);
  });

  it('puts the two Google analytics properties in the analytics group', async () => {
    await openData();
    expect(group('analytics').contains(card('Google Analytics 4'))).toBe(true);
    expect(group('analytics').contains(card('Search Console'))).toBe(true);
  });
});

/* ================================ calendar is not the follow-up queue === */

describe('Google Calendar and the follow-up queue read as different things', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('gives the calendar card the Google product name and its state', async () => {
    await openData();
    const el = card('Google Calendar');
    expect(within(el).getByText('Connected')).toBeTruthy();
    expect(el.textContent).toContain('Primary Google Calendar');
  });

  it('explains that follow-ups are the Cockpit rules, written into Google after', async () => {
    await openData();
    // The relationship between the two is stated, rather than left for
    // somebody to infer from two cards sitting near each other.
    expect(group('leads').textContent).toMatch(
      /produced by this app's own rules/,
    );
    expect(group('leads').textContent).toMatch(
      /Google Calendar is one of the places that decision gets written to/,
    );
  });

  it('gives the calendar its own anchor inside the relationships group', async () => {
    await openData();
    expect(group('calendar')).toBeTruthy();
    expect(group('leads').contains(group('calendar'))).toBe(true);
  });
});

/* ====================================================== states stay true === */

describe('the redesign did not invent a connection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows connected only for the providers the fixture really connected', async () => {
    await openData();
    const connected = screen.getAllByText('Connected');
    // GA4, Search Console and Calendar. Nothing else in this fixture is.
    expect(connected).toHaveLength(3);
  });

  it('shows the identifier the server recorded, not a guess', async () => {
    await openData();
    expect(within(card('Google Analytics 4')).getByText('properties/123456')).toBeTruthy();
    expect(within(card('Google Calendar')).getByText(LONG_EMAIL)).toBeTruthy();
  });

  it('says not set up for the five that are not connected', async () => {
    await openData();
    expect(within(group('social')).getAllByText('Not set up')).toHaveLength(5);
  });

  it('prints no error block when nothing has failed', async () => {
    await openData();
    // An always-present empty error slot trains somebody to ignore the one
    // place a real failure appears.
    expect(group('analytics').querySelectorAll('.int-card-error')).toHaveLength(0);
  });

  it('prints one when something has', async () => {
    await openData(
      context({
        loadCalendar: async () => ({
          connection: connection({
            provider: 'google_calendar',
            status: 'error',
            error_message: 'Google refused the stored authorization',
            error_at: '2026-10-11T09:00:00.000Z',
          }),
          runs: [],
        }),
      }),
    );
    expect(within(card('Google Calendar')).getByText(/Google refused the stored authorization/))
      .toBeTruthy();
  });
});

/* ========================================================== the details === */

describe('the long explanations are folded away, the status is not', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('starts every disclosure closed', async () => {
    await openData();
    const disclosures = document.querySelectorAll('details.int-details');
    expect(disclosures.length).toBeGreaterThan(0);
    for (const d of disclosures) {
      expect((d as HTMLDetailsElement).open).toBe(false);
    }
  });

  it('keeps state and action out of the disclosure', async () => {
    await openData();
    const el = card('Google Analytics 4');
    const details = el.querySelector('details.int-details') as HTMLElement;
    // The chip and the button are visible without opening anything.
    expect(details.contains(within(el).getByText('Connected'))).toBe(false);
    expect(details.contains(within(el).getByRole('button', { name: 'Sync now' }))).toBe(false);
  });

  it('gives each disclosure a usable summary', async () => {
    await openData();
    for (const summary of document.querySelectorAll('.int-details-summary')) {
      expect(summary.textContent?.trim()).not.toBe('');
    }
  });

  it('opens to reveal the explanation that used to be in the way', async () => {
    await openData();
    const el = card('Google Analytics 4');
    const details = el.querySelector('details.int-details') as HTMLDetailsElement;
    details.open = true;
    expect(details.textContent).toMatch(/Running it twice changes nothing/);
  });
});

/* ========================================================= the sidebar === */

describe('the sidebar gained marks without losing its words', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps every label visible', async () => {
    await openData();
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    for (const label of [
      'Today', 'Content Log', 'Website Outcomes', 'Pipeline', 'Tasks', 'Activity',
      'Recommendations', 'Data & Import',
    ]) {
      expect(within(nav).getByText(label)).toBeTruthy();
    }
  });

  it('gives each one an icon as well', async () => {
    await openData();
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    const links = within(nav).getAllByRole('link').filter((a) =>
      a.classList.contains('nav-link'),
    );
    expect(links).toHaveLength(8);
    for (const link of links) {
      expect(link.querySelector('svg'), `${link.textContent} has no icon`).toBeTruthy();
      expect(link.textContent?.trim()).not.toBe('');
    }
  });

  it('keeps the counts readable beside the labels', async () => {
    await openData();
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    for (const count of nav.querySelectorAll('.nav-count')) {
      expect(count.textContent?.trim()).toMatch(/^\d+$/);
    }
  });
});

/* ================================================== accessible names === */

describe('every control still says what it is', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('leaves no button without an accessible name', async () => {
    await openData();
    for (const button of screen.getAllByRole('button')) {
      const name =
        button.textContent?.trim() ||
        button.getAttribute('aria-label') ||
        button.getAttribute('title');
      expect(name, `a button has no accessible name: ${button.outerHTML.slice(0, 80)}`)
        .toBeTruthy();
    }
  });

  it('leaves no link without one either', async () => {
    await openData();
    for (const link of screen.getAllByRole('link')) {
      const name = link.textContent?.trim() || link.getAttribute('aria-label');
      expect(name, `a link has no accessible name: ${link.outerHTML.slice(0, 80)}`)
        .toBeTruthy();
    }
  });
});

/* ================================================= the navigator behaves === */

describe('the jump bar moves the page and the keyboard with it', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    // jsdom has no layout, so scrollIntoView is absent. Recording the calls is
    // what these tests are about anyway.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('scrolls to the section the link names', async () => {
    await openData();
    const nav = screen.getByRole('navigation', { name: 'Jump to a section' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Calendar' }));

    const calls = (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock;
    expect(calls.calls.length).toBe(1);
    expect(calls.instances[0]).toBe(group('calendar'));
  });

  it('moves focus as well as the viewport', async () => {
    // Scrolling alone leaves a keyboard user's next Tab back at the top of the
    // page, which is the usual way an anchor nav is broken for everybody who
    // does not use a mouse.
    await openData();
    const nav = screen.getByRole('navigation', { name: 'Jump to a section' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Fallback' }));
    expect(document.activeElement).toBe(group('fallback'));
  });

  it('smooth scrolls by default', async () => {
    await openData();
    const nav = screen.getByRole('navigation', { name: 'Jump to a section' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Social' }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth' }),
    );
  });

  it('jumps instantly when reduced motion is asked for', async () => {
    // Read at click time rather than at mount, so a mid-session change counts.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      await openData();
      const nav = screen.getByRole('navigation', { name: 'Jump to a section' });
      fireEvent.click(within(nav).getByRole('link', { name: 'Analytics' }));
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'auto' }),
      );
    } finally {
      window.matchMedia = original;
    }
  });

  it('marks the section it moved to as current', async () => {
    await openData();
    const nav = screen.getByRole('navigation', { name: 'Jump to a section' });
    const link = within(nav).getByRole('link', { name: 'Settings' });
    fireEvent.click(link);
    // aria-current, not only a colour: the highlight says "you are here" to
    // somebody who can see it, and this says it to everybody else.
    expect(link.getAttribute('aria-current')).toBe('true');
  });
});
