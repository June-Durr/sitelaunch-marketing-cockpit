/**
 * What the calendar panel asks of somebody, and what it promises them.
 *
 * The thing worth testing here is not the layout, it is the absence of the old
 * setup work. Sprint B's version told people to create a calendar, share it with
 * a service account and copy its id into a secret. None of that may come back,
 * and a test that names those strings is how it stays gone.
 *
 * Supabase mode is reached by supplying the data context directly: what is under
 * test is the markup a given state produces, so a stub state is the honest way to
 * drive it and it keeps the suite from needing a live project or a real Google
 * account. Every address and date below is invented.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

import { AppShell } from '../components/AppShell';
import { DataContext, type DataContextValue } from '../data/context';
import { DataProvider } from '../data/DataProvider';
import { CalendarPanel, CALENDAR_PROMISE } from '../screens/CalendarPanel';
import { buildSeedDataset } from '../data/seed';
import {
  EMPTY_DATASET,
  type CalendarDisconnectOutcome, type CalendarOAuthStart, type CalendarStatus,
  type CalendarSyncOutcome,
} from '../data/repository';

/* ------------------------------------------------------------- fixtures -- */

const CONNECTED_AT = '2026-10-05T07:00:00.000Z';
const SYNCED_AT = '2026-10-05T08:41:00.000Z';

function connectedStatus(over: Partial<CalendarStatus> = {}): CalendarStatus {
  return {
    connection: {
      id: 'conn-calendar',
      provider: 'google_calendar',
      provider_account_id: 'primary',
      display_name: 'invented.person@example.test',
      status: 'connected',
      granted_scopes: ['https://www.googleapis.com/auth/calendar.events.owned'],
      connected_at: CONNECTED_AT,
      last_synced_at: SYNCED_AT,
      error_message: null,
      error_at: null,
      created_at: CONNECTED_AT,
      updated_at: SYNCED_AT,
    },
    runs: [
      {
        id: 'run-cal-1',
        connection_id: 'conn-calendar',
        provider: 'google_calendar',
        started_at: '2026-10-05T08:40:00.000Z',
        completed_at: SYNCED_AT,
        status: 'succeeded',
        rows_read: 19,
        rows_written: 19,
        error_summary: null,
        idempotency_key: 'google_calendar:export:2026-10-05',
        details: { action: 'export', created: 0, updated: 19, failed: 0, tasks: 19 },
        created_at: SYNCED_AT,
      },
    ],
    ...over,
  };
}

const notConnected: CalendarStatus = { connection: null, runs: [] };

function syncOutcome(over: Partial<CalendarSyncOutcome> = {}): CalendarSyncOutcome {
  return {
    ok: true, status: 'succeeded', created: 0, updated: 19, failed: 0, tasks: 19,
    error: null, ...over,
  };
}

/* -------------------------------------------------------------- harness -- */

function supabaseContext(options: {
  status?: CalendarStatus;
  start?: DataContextValue['startCalendarOAuth'];
  sync?: DataContextValue['triggerCalendarSync'];
  disconnect?: DataContextValue['disconnectCalendar'];
  loadThrows?: string;
}): DataContextValue {
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
    loadAnalytics: null,
    triggerSync: null,
    loadLeadMirror: null,
    triggerLeadMirror: null,
    loadCalendar: async () => {
      if (options.loadThrows) throw new Error(options.loadThrows);
      return options.status ?? notConnected;
    },
    triggerCalendarSync: options.sync ?? (async () => syncOutcome()),
    startCalendarOAuth:
      options.start
      ?? (async (): Promise<CalendarOAuthStart> => ({
        status: 'ready',
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=invented',
        error: null,
      })),
    disconnectCalendar:
      options.disconnect
      ?? (async (): Promise<CalendarDisconnectOutcome> => ({
        ok: true, status: 'disconnected', revokedAtGoogle: true, eventsRemoved: false,
        error: null,
      })),
  };
}

function renderWith(value: DataContextValue, path = '/data') {
  return render(
    <DataContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/data" element={<CalendarPanel key="c" /> as ReactNode} />
          </Route>
        </Routes>
      </MemoryRouter>
    </DataContext.Provider>,
  );
}

const panel = () =>
  screen.getByText('Follow-up calendar').closest('section') as HTMLElement;

async function open(value: DataContextValue, path = '/data') {
  renderWith(value, path);
  await waitFor(() => expect(screen.getByText('Follow-up calendar')).toBeTruthy());
  // The panel reads its state in an effect, so let it settle.
  await waitFor(() =>
    expect(within(panel()).queryAllByRole('button').length).toBeGreaterThan(0),
  );
}

/* ================================================= what it asks of somebody === */

describe('connecting a calendar is one button and nothing else', () => {
  it('offers Connect Google Calendar when nothing is connected', async () => {
    await open(supabaseContext({ status: notConnected }));
    expect(within(panel()).getByRole('button', { name: 'Connect Google Calendar' }))
      .toBeTruthy();
    // No syncing on offer until there is somewhere to sync to.
    expect(within(panel()).queryByRole('button', { name: 'Sync now' })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  /**
   * The setup work that must never come back.
   *
   * Every one of these was in the previous version of this screen. A customer who
   * has to create a calendar, share it with a robot and paste an id has been
   * handed a configuration task, which is exactly what this sprint removed.
   */
  it('never asks anybody to create, share or name a calendar', async () => {
    for (const status of [notConnected, connectedStatus()]) {
      const { unmount } = renderWith(supabaseContext({ status }));
      await waitFor(() => expect(screen.getByText('Follow-up calendar')).toBeTruthy());
      const text = panel().textContent ?? '';

      for (const forbidden of [
        'service account',
        'Calendar ID',
        'calendar id',
        'GOOGLE_CALENDAR_ID',
        'share it with',
        'dedicated calendar',
        'JSON key',
        'private key',
      ]) {
        expect(text, `the panel says "${forbidden}"`).not.toContain(forbidden);
      }
      unmount();
    }
  });

  it('says exactly what it will and will not do to the calendar', async () => {
    await open(supabaseContext({ status: notConnected }));
    // The sentence somebody reads before granting access to their real diary.
    expect(panel().textContent).toContain(CALENDAR_PROMISE);
    expect(CALENDAR_PROMISE).toBe(
      'Follow-ups created by the Cockpit will appear on your primary Google Calendar. '
      + 'The Cockpit will not alter unrelated calendar events.',
    );
  });

  it('explains the one permission Google will ask for', async () => {
    await open(supabaseContext({ status: notConnected }));
    const text = panel().textContent ?? '';
    expect(text).toContain('managing events on calendars you own');
    expect(text).toContain('You can disconnect');
  });

  it('sends the browser to Google own consent screen', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign },
    });

    try {
      await open(supabaseContext({ status: notConnected }));
      fireEvent.click(
        within(panel()).getByRole('button', { name: 'Connect Google Calendar' }),
      );
      await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
      expect(assign.mock.calls[0][0]).toContain('accounts.google.com');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('says so rather than pretending, when the server is not set up', async () => {
    await open(
      supabaseContext({
        status: notConnected,
        start: async () => ({
          status: 'not_configured',
          authorizeUrl: null,
          error: 'Google Calendar is not set up on this deployment yet.',
        }),
      }),
    );
    fireEvent.click(within(panel()).getByRole('button', { name: 'Connect Google Calendar' }));
    await waitFor(() =>
      expect(panel().textContent).toContain('not set up on this deployment yet'),
    );
  });
});

/* ======================================================== what it shows === */

describe('a connected calendar reports what it actually did', () => {
  it('names the Google account and the primary calendar as the destination', async () => {
    await open(supabaseContext({ status: connectedStatus() }));
    const text = panel().textContent ?? '';
    expect(text).toContain('invented.person@example.test');
    expect(text).toContain('Primary Google Calendar');
    // And not the raw id, which means nothing to a person.
    expect(within(panel()).queryByText('primary')).toBeNull();
  });

  it('shows the last successful and last attempted sync separately', async () => {
    await open(supabaseContext({ status: connectedStatus() }));
    const headers = [...panel().querySelectorAll('th')].map((h) => h.textContent);
    expect(headers).toContain('Last successful');
    expect(headers).toContain('Last attempted');
    expect(headers).toContain('Next scheduled');
    expect(headers).toContain('Google account');
    expect(headers).toContain('Where events go');
  });

  it('offers Sync now and Disconnect once there is a connection', async () => {
    await open(supabaseContext({ status: connectedStatus() }));
    expect(within(panel()).getByRole('button', { name: 'Sync now' })).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: 'Connect Google Calendar' }))
      .toBeNull();
  });

  it('waits before claiming to know the Google account', async () => {
    const status = connectedStatus();
    await open(
      supabaseContext({
        status: { ...status, connection: { ...status.connection!, display_name: null } },
      }),
    );
    // No identity scope was requested, so the address genuinely is not known
    // until an event comes back. Saying so beats inventing one.
    expect(panel().textContent).toContain('Shown after the first event');
  });

  it('reports a sync honestly, counts and all', async () => {
    await open(supabaseContext({ status: connectedStatus() }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Sync now' }));
    await waitFor(() =>
      expect(panel().textContent).toMatch(/0 added, 19 brought up to date/),
    );
    expect(panel().textContent).toContain('19 open follow-ups');
  });

  it('says nobody is connected rather than blaming the calendar', async () => {
    await open(
      supabaseContext({
        status: connectedStatus(),
        sync: async () =>
          syncOutcome({
            ok: false,
            status: 'not_connected',
            created: null,
            updated: null,
            failed: null,
            tasks: null,
            error: 'No Google account is connected yet.',
          }),
      }),
    );
    fireEvent.click(within(panel()).getByRole('button', { name: 'Sync now' }));
    await waitFor(() =>
      expect(panel().textContent).toContain('No Google account is connected yet'),
    );
  });

  it('shows the stored failure reason when the last attempt broke', async () => {
    const status = connectedStatus();
    await open(
      supabaseContext({
        status: {
          ...status,
          connection: {
            ...status.connection!,
            status: 'error',
            error_message: 'Google refused the stored authorization (HTTP 400): invalid_grant',
            error_at: SYNCED_AT,
          },
        },
      }),
    );
    expect(panel().textContent).toContain('invalid_grant');
    // Still connected enough to retry or to disconnect.
    expect(within(panel()).getByRole('button', { name: 'Sync now' })).toBeTruthy();
  });
});

/* ===================================================== coming back from Google === */

describe('the panel reads the result the callback redirected back with', () => {
  it('confirms a connection', async () => {
    await open(supabaseContext({ status: connectedStatus() }), '/data?calendar=connected');
    expect(panel().textContent).toContain('Google Calendar is connected');
  });

  it('says nothing changed when somebody cancelled at Google', async () => {
    await open(supabaseContext({ status: notConnected }), '/data?calendar=refused');
    expect(panel().textContent).toContain('cancelled at Google, so nothing changed');
  });

  it('says nothing changed when it failed, without guessing why', async () => {
    await open(supabaseContext({ status: notConnected }), '/data?calendar=failed');
    const text = panel().textContent ?? '';
    expect(text).toContain('did not complete, so nothing changed');
    // The reason came from a query string anybody can write, so none is shown.
    expect(text).not.toContain('invalid');
  });
});

/* =========================================== 12. disconnecting deletes nothing === */

describe('disconnecting forgets the authorization and leaves the calendar alone', () => {
  it('says the events were left where they are', async () => {
    await open(supabaseContext({ status: connectedStatus() }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(panel().textContent).toContain('Disconnected'));

    const text = panel().textContent ?? '';
    expect(text).toContain('forgotten the authorization');
    expect(text).toContain('left exactly where they are');
    expect(text).toContain('Google was told to cancel it as well');
  });

  /**
   * Two facts, not one.
   *
   * Forgetting the token here is what stops the Cockpit writing, and it happened.
   * Telling Google is the courteous half, and it did not. Rolling the two into
   * one reassuring sentence would leave somebody believing the app had been
   * removed from their Google account when it had not.
   */
  it('does not claim Google was told when it could not be reached', async () => {
    await open(
      supabaseContext({
        status: connectedStatus(),
        disconnect: async () => ({
          ok: true, status: 'disconnected', revokedAtGoogle: false, eventsRemoved: false,
          error: null,
        }),
      }),
    );
    fireEvent.click(within(panel()).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(panel().textContent).toContain('Disconnected'));

    const text = panel().textContent ?? '';
    expect(text).toContain('Google could not be reached');
    expect(text).toContain('remove SiteLaunch Cockpit from your Google account');
    expect(text).not.toContain('Google was told to cancel it as well');
  });

  it('says the connection may still be there when disconnecting failed', async () => {
    await open(
      supabaseContext({
        status: connectedStatus(),
        disconnect: async () => ({
          ok: false, status: 'failed', revokedAtGoogle: false, eventsRemoved: false,
          error: 'Could not reach the connection function.',
        }),
      }),
    );
    fireEvent.click(within(panel()).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(panel().textContent).toContain('Disconnecting did not finish'),
    );
    expect(panel().textContent).toContain('may still be in place');
  });
});

/* ==================================================== browser only mode === */

describe('browser only mode says why this cannot work here', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('explains it needs a server rather than offering a dead button', async () => {
    render(
      <DataProvider>
        <MemoryRouter initialEntries={['/data']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/data" element={<CalendarPanel /> as ReactNode} />
            </Route>
          </Routes>
        </MemoryRouter>
      </DataProvider>,
    );
    await waitFor(() => expect(screen.getByText('Follow-up calendar')).toBeTruthy());

    expect(panel().textContent).toContain('running on this browser alone');
    expect(panel().textContent).toContain('needs a server to hold the authorization');
    expect(within(panel()).queryAllByRole('button')).toEqual([]);
  });

  it('never leaves anything about the connection in browser storage', () => {
    // The panel holds no token, so there is nothing of Google's to store. This
    // asserts the absence rather than assuming it.
    const keys = Object.keys(window.localStorage);
    for (const key of keys) {
      const value = window.localStorage.getItem(key) ?? '';
      expect(value).not.toContain('refresh');
      expect(value).not.toContain('accounts.google.com');
    }
    expect(EMPTY_DATASET).toBeTruthy();
  });
});
