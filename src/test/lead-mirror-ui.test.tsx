/**
 * What the screens are allowed to say about the lead mirror and about following up.
 *
 * Supabase mode is reached by supplying the data context directly rather than by
 * putting credentials on disk: what is under test is the markup a given state
 * produces, so a stub state is the honest way to drive it, and it keeps the suite
 * from needing a live project or a real spreadsheet. Browser-only mode goes
 * through the real provider and the real local adapter, because that path has to
 * stay honest too.
 *
 * The leads below are invented, and every date is fixed.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

import { AppShell } from '../components/AppShell';
import { DataContext, type DataContextValue } from '../data/context';
import { DataProvider } from '../data/DataProvider';
import { DataImport } from '../screens/DataImport';
import { Pipeline } from '../screens/Pipeline';
import { Today } from '../screens/Today';
import { buildSeedDataset } from '../data/seed';
import {
  EMPTY_DATASET, type CalendarStatus, type LeadMirrorOutcome, type LeadMirrorStatus,
} from '../data/repository';
import type { Dataset } from '../types/domain';
import { makeActivity, makeLead, makeTask } from './fixtures';

/* ------------------------------------------------------------- fixtures -- */

const SYNCED_AT = '2026-10-05T08:02:00.000Z';

function mirrorStatus(over: Partial<LeadMirrorStatus> = {}): LeadMirrorStatus {
  return {
    connection: {
      id: 'conn-sheets',
      provider: 'google_sheets',
      provider_account_id: 'SiteLaunch Lead & Relationship Mirror',
      display_name: 'sync@example.iam.gserviceaccount.com',
      status: 'connected',
      granted_scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      connected_at: '2026-10-05T07:00:00.000Z',
      last_synced_at: SYNCED_AT,
      error_message: null,
      error_at: null,
      created_at: '2026-10-05T07:00:00.000Z',
      updated_at: SYNCED_AT,
    },
    runs: [
      {
        id: 'run-1',
        connection_id: 'conn-sheets',
        provider: 'google_sheets',
        started_at: '2026-10-05T08:00:00.000Z',
        completed_at: SYNCED_AT,
        status: 'succeeded',
        rows_read: 36,
        rows_written: 36,
        error_summary: null,
        idempotency_key: 'google_sheets:export:2026-10-05',
        details: { action: 'export', leadRows: 21, touchRows: 15 },
        created_at: SYNCED_AT,
      },
    ],
    ...over,
  };
}

function outcome(over: Partial<LeadMirrorOutcome> = {}): LeadMirrorOutcome {
  return {
    ok: true,
    status: 'succeeded',
    counts: null,
    ambiguous: [],
    rejected: [],
    warnings: [],
    gateReasons: [],
    applied: null,
    leadRows: null,
    touchRows: null,
    error: null,
    ...over,
  };
}

/* -------------------------------------------------------------- harness -- */

function supabaseContext(options: {
  data?: Dataset;
  status?: LeadMirrorStatus | null;
  trigger?: DataContextValue['triggerLeadMirror'];
  mirrorError?: string;
  calendar?: CalendarStatus;
  calendarSync?: DataContextValue['triggerCalendarSync'];
}): DataContextValue {
  const unused = () => {
    throw new Error('these tests do not write');
  };
  return {
    data: options.data ?? buildSeedDataset(),
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
    // The analytics panel has its own tests; here it is simply unavailable.
    loadAnalytics: null,
    triggerSync: null,
    loadLeadMirror: async () => {
      if (options.mirrorError) throw new Error(options.mirrorError);
      return options.status ?? mirrorStatus();
    },
    triggerLeadMirror: options.trigger ?? (async () => outcome()),
    loadCalendar: options.calendar ? async () => options.calendar as CalendarStatus : null,
    triggerCalendarSync: options.calendarSync ?? null,
    startCalendarOAuth: null,
    disconnectCalendar: null,
  };
}

function renderWith(
  value: DataContextValue,
  path: string,
  element: ReactNode,
  // The route to match on, when the address carries a query string the route
  // pattern must not contain.
  routePath = path,
) {
  return render(
    <DataContext.Provider value={value}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path={routePath} element={element} />
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

const panel = () =>
  screen.getByText('Google Sheet lead mirror').closest('section') as HTMLElement;

async function openData(value: DataContextValue) {
  renderWith(value, '/data', <DataImport key="d" />);
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
  // The panel reads its state in an effect, so wait for it to settle.
  await waitFor(() => expect(within(panel()).queryByText('Connected')).toBeTruthy());
}

/**
 * Pin the clock for the screens that do date arithmetic.
 *
 * Pipeline and Today call today() and work everything out from the real system
 * date, so an assertion like "11 days since the last touch" is only true on one
 * particular day. The first version of this file hardcoded those numbers against
 * fixed fixture dates and passed for exactly one day before failing. Fixed
 * fixtures are not enough on their own: the clock has to be fixed too.
 *
 * Midday local, so no timezone can push it onto a neighbouring date.
 */
const PINNED_TODAY = '2026-10-05';

function pinTheClock() {
  beforeAll(() => {
    // shouldAdvanceTime, so testing-library's waitFor still makes progress.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${PINNED_TODAY}T12:00:00`));
  });
  afterAll(() => {
    vi.useRealTimers();
  });
}

/* ============================================================ the panel === */

describe('the lead mirror panel reports stored state, not intentions', () => {
  it('says plainly that it cannot work in browser-only mode', async () => {
    renderLocal('/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    const section = panel();
    expect(within(section).getByText('not available here')).toBeTruthy();
    expect(section.textContent).toContain('needs a server');
    // No buttons that cannot work.
    expect(within(section).queryByRole('button', { name: /Sync lead mirror now/ })).toBeNull();
  });

  it('shows the connection the server actually recorded', async () => {
    await openData(supabaseContext({}));
    const section = panel();

    expect(within(section).getByText('Connected')).toBeTruthy();
    // The sheet's own title, read back from the connection row.
    expect(section.textContent).toContain('SiteLaunch Lead & Relationship Mirror');
  });

  it('never puts the spreadsheet id or the service account on screen', async () => {
    await openData(supabaseContext({}));
    const text = panel().textContent ?? '';

    expect(text).not.toContain('1umabdzkbi2VI5w0');
    expect(text).not.toContain('gserviceaccount.com');
    expect(text).not.toContain('private_key');
  });

  it('says never rather than guessing when nothing has run', async () => {
    await openData(
      supabaseContext({
        status: { connection: mirrorStatus().connection, runs: [] },
      }),
    );
    const section = panel();
    expect(within(section).getAllByText('Never').length).toBeGreaterThan(0);
  });

  it('says not connected rather than blank when there is no connection at all', async () => {
    renderWith(
      supabaseContext({ status: { connection: null, runs: [] } }),
      '/data',
      <DataImport key="d" />,
    );
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    await waitFor(() => {
      const section = panel();
      expect(within(section).getByText('Not set up')).toBeTruthy();
      expect(section.textContent).toContain('Not connected yet');
    });
  });

});

describe('a broken connection is reported and nothing else breaks', () => {
  it('shows the stored failure and keeps the rest of the screen working', async () => {
    const base = mirrorStatus();
    const value = supabaseContext({
      status: {
        ...base,
        connection: {
          ...base.connection!,
          status: 'error',
          error_message: 'Google Sheets GET /values failed (HTTP 403)',
          error_at: '2026-10-05T09:00:00.000Z',
        },
        runs: [
          {
            ...base.runs[0],
            status: 'failed',
            error_summary: 'Google Sheets GET /values failed (HTTP 403)',
          },
        ],
      },
    });

    renderWith(value, '/data', <DataImport key="d" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    await waitFor(() => {
      const section = panel();
      expect(within(section).getByText('Something went wrong')).toBeTruthy();
      expect(section.textContent).toContain('HTTP 403');
    });

    // The rest of Data and Import is untouched: a failed sheet sync is not an
    // outage of the Cockpit.
    expect(screen.getByText('Accounts')).toBeTruthy();
    expect(screen.getByText('Seed data')).toBeTruthy();
  });

  it('reports a panel that could not even be read, without blanking the screen', async () => {
    renderWith(
      supabaseContext({ mirrorError: 'relation "sync_runs" does not exist' }),
      '/data',
      <DataImport key="d" />,
    );
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    await waitFor(() =>
      expect(panel().textContent).toContain('relation "sync_runs" does not exist'),
    );
    expect(screen.getByText('Accounts')).toBeTruthy();
  });
});

/* =========================================================== the actions == */

describe('the on-demand sync', () => {
  it('asks the server to export, and reports what it wrote', async () => {
    const trigger = vi.fn(async () =>
      outcome({ status: 'succeeded', leadRows: 21, touchRows: 15 }),
    );
    await openData(supabaseContext({ trigger }));

    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Sync lead mirror now' }),
    );

    expect(trigger).toHaveBeenCalledWith('export');
    await waitFor(() => {
      const text = panel().textContent ?? '';
      expect(text).toContain('21 relationship');
      expect(text).toContain('15 touch');
    });
  });

  it('says the sheet was not updated, and that nothing here changed, on a failure', async () => {
    const trigger = vi.fn(async () =>
      outcome({ ok: false, status: 'failed', error: 'Google Sheets PUT failed (HTTP 500)' }),
    );
    await openData(supabaseContext({ trigger }));

    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Sync lead mirror now' }),
    );

    await waitFor(() => {
      const text = panel().textContent ?? '';
      expect(text).toContain('HTTP 500');
      expect(text).toContain('Nothing in this cockpit changed');
    });
  });
});

describe('the reconciliation is a two-step, and the first step writes nothing', () => {
  const DRY_RUN = outcome({
    status: 'dry_run',
    counts: {
      leadRowsRead: 21,
      touchRowsRead: 15,
      leadsToCreate: 21,
      leadsToUpdate: 0,
      leadsUnchanged: 0,
      ambiguousMatches: 0,
      touchesToCreate: 15,
      touchesAlreadyPresent: 0,
      rejectedRows: 0,
    },
  });

  it('reports the counts a dry run found, and says nothing was written', async () => {
    const trigger = vi.fn(async () => DRY_RUN);
    await openData(supabaseContext({ trigger }));

    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Check what the sheet would change' }),
    );

    expect(trigger).toHaveBeenCalledWith('reconcile', { mode: 'dry_run' });
    await waitFor(() => {
      const text = panel().textContent ?? '';
      expect(text).toContain('Relationship rows read');
      expect(text).toContain('Leads to create');
      expect(text).toContain('Touches to create');
      expect(text).toContain('Nothing was written');
    });
  });

  it('only offers to import after a clean check, and sends what the check saw', async () => {
    const trigger = vi.fn(async (_action: string, options?: unknown) =>
      options && (options as { mode?: string }).mode === 'live'
        ? outcome({
            status: 'applied',
            counts: DRY_RUN.counts,
            applied: { leadsCreated: 21, leadsUpdated: 0, touchesCreated: 15 },
          })
        : DRY_RUN,
    );
    await openData(supabaseContext({ trigger }));

    // Nothing to import until somebody has looked.
    expect(within(panel()).queryByRole('button', { name: 'Bring the sheet in' })).toBeNull();

    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Check what the sheet would change' }),
    );
    await waitFor(() =>
      expect(within(panel()).getByRole('button', { name: 'Bring the sheet in' })).toBeTruthy(),
    );

    fireEvent.click(within(panel()).getByRole('button', { name: 'Bring the sheet in' }));

    // The expectation is what the dry run actually read, not a number compiled in.
    expect(trigger).toHaveBeenLastCalledWith('reconcile', {
      mode: 'live',
      expect: { leadRows: 21, touchRows: 15 },
    });
    await waitFor(() => {
      const text = panel().textContent ?? '';
      expect(text).toContain('Created 21');
      expect(text).toContain('Running this again would change nothing');
    });
  });

  it('will not offer to import when a row is ambiguous', async () => {
    const trigger = vi.fn(async () =>
      outcome({
        status: 'dry_run',
        counts: { ...DRY_RUN.counts!, ambiguousMatches: 1 },
        ambiguous: [
          {
            tab: 'Lead Mirror',
            rowNumber: 7,
            label: 'taylor-handyman',
            reason: '2 existing leads share the email taylor@example.com. Left unchanged.',
            candidateIds: ['a', 'b'],
          },
        ],
      }),
    );
    await openData(supabaseContext({ trigger }));

    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Check what the sheet would change' }),
    );

    await waitFor(() => {
      const text = panel().textContent ?? '';
      expect(text).toContain('more than one person could have been meant');
      expect(text).toContain('taylor-handyman');
      expect(text).toContain('row 7');
    });
    expect(within(panel()).queryByRole('button', { name: 'Bring the sheet in' })).toBeNull();
  });

  it('will not offer to import when a row could not be read', async () => {
    const trigger = vi.fn(async () =>
      outcome({
        status: 'dry_run',
        counts: { ...DRY_RUN.counts!, rejectedRows: 1 },
        rejected: [
          {
            tab: 'Lead Mirror',
            rowNumber: 9,
            label: 'chef-groovin-bean',
            reason: 'First contact "sometime in March" is not a date this importer can read.',
          },
        ],
      }),
    );
    await openData(supabaseContext({ trigger }));

    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Check what the sheet would change' }),
    );

    await waitFor(() => {
      const text = panel().textContent ?? '';
      expect(text).toContain('Rows that could not be read');
      expect(text).toContain('sometime in March');
    });
    expect(within(panel()).queryByRole('button', { name: 'Bring the sheet in' })).toBeNull();
  });

  it('shows the reasons when a live import is refused, and that nothing was written', async () => {
    const trigger = vi.fn(async (_action: string, options?: unknown) =>
      options && (options as { mode?: string }).mode === 'live'
        ? outcome({
            ok: false,
            status: 'blocked',
            counts: DRY_RUN.counts,
            gateReasons: [
              'Expected 21 relationship rows on the Lead Mirror tab, found 22.',
            ],
          })
        : DRY_RUN,
    );
    await openData(supabaseContext({ trigger }));

    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Check what the sheet would change' }),
    );
    await waitFor(() =>
      expect(within(panel()).getByRole('button', { name: 'Bring the sheet in' })).toBeTruthy(),
    );
    fireEvent.click(within(panel()).getByRole('button', { name: 'Bring the sheet in' }));

    await waitFor(() => {
      const text = panel().textContent ?? '';
      expect(text).toContain('Stopped before writing anything');
      expect(text).toContain('found 22');
      expect(text).toContain('Nothing was created, changed or deleted');
    });
  });

  it('says there is nothing left to import once there is not', async () => {
    const trigger = vi.fn(async () =>
      outcome({
        status: 'dry_run',
        counts: {
          leadRowsRead: 21,
          touchRowsRead: 15,
          leadsToCreate: 0,
          leadsToUpdate: 0,
          leadsUnchanged: 21,
          ambiguousMatches: 0,
          touchesToCreate: 0,
          touchesAlreadyPresent: 15,
          rejectedRows: 0,
        },
      }),
    );
    await openData(supabaseContext({ trigger }));

    fireEvent.click(
      within(panel()).getByRole('button', { name: 'Check what the sheet would change' }),
    );

    await waitFor(() =>
      expect(panel().textContent).toContain('There is nothing left to import'),
    );
    // And no button to do it again pointlessly.
    expect(within(panel()).queryByRole('button', { name: 'Bring the sheet in' })).toBeNull();
  });
});

/* ========================================================== the pipeline == */

/** A dataset shaped like the imported mirror, with the three interesting cases. */
function pipelineData(): Dataset {
  return {
    ...EMPTY_DATASET,
    leads: [
      makeLead({
        id: 'taylor',
        prospect_name: 'Taylor',
        organization: 'Your Local Handyman',
        stage: 'follow_up',
        next_action: 'Send one concise final follow-up',
        next_action_date: '2026-10-06',
        reported_last_touch_at: '2026-09-24',
      }),
      makeLead({
        id: 'moth',
        prospect_name: 'Tyson Harvey',
        organization: 'Moth to Flame',
        stage: 'waiting',
        reported_last_touch_at: '2026-09-13',
        next_action_date: '2026-11-09',
      }),
      makeLead({
        id: 'olde',
        prospect_name: 'Name pending',
        organization: 'Olde Capital Investments',
        stage: 'waiting',
        follow_up_mode: 'none',
      }),
      makeLead({
        id: 'ernesto',
        prospect_name: 'Ernesto Gil',
        organization: 'Independent / restaurant design',
        preferred_channel: 'LinkedIn',
        stage: 'follow_up',
        next_action: 'Send a concise follow-up or archive',
        next_action_date: '2026-09-15',
      }),
    ],
    activityEvents: [
      makeActivity({
        id: 'touch-1',
        lead_id: 'taylor',
        activity_type: 'follow_up_sent',
        title: 'Follow-up sent',
        occurred_at: '2026-09-24T12:00:00.000Z',
      }),
      makeActivity({
        id: 'touch-2',
        lead_id: 'ernesto',
        activity_type: 'follow_up_sent',
        title: 'Follow-up sent',
        occurred_at: '2026-09-08T12:00:00.000Z',
      }),
    ],
  };
}

async function openPipelineTable(data: Dataset) {
  renderWith(supabaseContext({ data }), '/pipeline', <Pipeline key="p" />);
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Table' }));
  return screen.getByRole('table');
}

describe('the Pipeline shows how long somebody has been waiting', () => {
  pinTheClock();

  it('has a column for each of the four things', async () => {
    const table = await openPipelineTable(pipelineData());
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);

    expect(headers).toContain('Last touch');
    expect(headers).toContain('Days since');
    expect(headers).toContain('Next follow-up');
    expect(headers).toContain('Follow-up status');
  });

  it('derives the last touch from the activity log', async () => {
    const table = await openPipelineTable(pipelineData());
    const row = within(table).getByText('Taylor').closest('tr') as HTMLElement;

    expect(row.textContent).toContain('Sep 24, 2026');
    // 2026-09-24 to the pinned 2026-10-05 is 11 days, and the app worked that
    // out from the activity log rather than reading a stored number.
    expect(within(row).getByText('11')).toBeTruthy();
    expect(row.textContent).not.toContain('Reported, no activity logged');
  });

  it('says when a date was only reported, rather than dressing it up as logged', async () => {
    const table = await openPipelineTable(pipelineData());
    const row = within(table).getByText('Tyson Harvey').closest('tr') as HTMLElement;

    expect(row.textContent).toContain('Sep 13, 2026');
    expect(row.textContent).toContain('Reported, no activity logged');
  });

  it('says nothing is known rather than showing a zero or a date', async () => {
    const table = await openPipelineTable(pipelineData());
    const row = within(table).getByText('Name pending').closest('tr') as HTMLElement;

    // The house wording for an absent observation. Not "Never", which would be a
    // claim nobody can support, and emphatically not 0 days since touch.
    const absent = within(row).getAllByText('Not known');
    expect(absent.length).toBeGreaterThanOrEqual(2);
    expect(absent.some((el) => el.getAttribute('title') === 'Nothing logged')).toBe(true);

    expect(row.textContent).toContain('None set');
    expect(row.textContent).toContain('Not scheduled');
    expect(row.textContent).not.toContain('0 days');
  });

  it('puts the overdue lead at the top and the deliberate one at the bottom', async () => {
    const table = await openPipelineTable(pipelineData());
    const names = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('.row-button')?.textContent);

    expect(names[0]).toBe('Ernesto Gil');
    expect(names.at(-1)).toBe('Name pending');
  });

  it('counts who needs chasing and who has no contact on record', async () => {
    renderWith(supabaseContext({ data: pipelineData() }), '/pipeline', <Pipeline key="p" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());

    const strip = document.querySelector('.stat-strip') as HTMLElement;
    expect(strip.textContent).toContain('Need chasing');
    expect(strip.textContent).toContain('No contact on record');
  });
});

/* ============================================================= the today == */

describe('Today has one follow-up queue, not two', () => {
  pinTheClock();

  const openToday = async (data: Dataset = pipelineData()) => {
    renderWith(supabaseContext({ data }), '/', <Today key="t" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
  };

  const queueSection = () =>
    screen.getByText('Follow-ups to make').closest('section') as HTMLElement;

  it('has exactly one follow-up section, under one name', async () => {
    /**
     * The duplication this replaced.
     *
     * There used to be a "Follow-ups due" section built from tasks and a "Leads
     * requiring action" section built from calculated lead state. Once every
     * eligible lead has a task those listed the same people twice, which makes a
     * daily list that is read in a hurry actively misleading about how much there
     * is to do.
     */
    await openToday();

    expect(screen.getAllByText('Follow-ups to make')).toHaveLength(1);
    expect(screen.queryByText('Follow-ups due')).toBeNull();
    expect(screen.queryByText('Leads requiring action')).toBeNull();

    // And nobody is listed twice within the queue itself. The recommended next
    // step above it may well name the same person, which is a different thing
    // being said once rather than the same list printed twice.
    const rows = within(queueSection()).getAllByRole('listitem');
    const names = rows.map((row) => row.querySelector('.queue-title')?.textContent);
    expect(names).toEqual([...new Set(names)]);
    expect(names).toContain('Ernesto Gil');
  });

  it('lists whoever is due now, with how long they have waited', async () => {
    await openToday();
    const section = queueSection();

    expect(within(section).getByText('Ernesto Gil')).toBeTruthy();
    expect(section.textContent).toContain('Overdue');
    expect(section.textContent).toContain('days since the last touch');
  });

  it('shows the organization, the channel and the recorded next action', async () => {
    await openToday();
    const section = queueSection();

    expect(section.textContent).toContain('Independent / restaurant design');
    expect(section.textContent).toContain('LinkedIn');
    expect(section.textContent).toContain('Send a concise follow-up or archive');
  });

  it('says what the calendar knows, and says so honestly when it knows nothing', async () => {
    await openToday();
    const section = queueSection();
    // No tasks in this fixture, so nothing could have been put on a calendar.
    expect(within(section).getAllByText('Not on a calendar').length).toBeGreaterThan(0);
  });

  it('reports a follow-up that is already on the calendar', async () => {
    const data = pipelineData();
    const withTask: Dataset = {
      ...data,
      tasks: [
        makeTask({
          id: 'task-ernesto',
          lead_id: 'ernesto',
          task_type: 'follow_up',
          status: 'open',
          due_date: '2026-09-15',
          follow_up_rule_managed: true,
          calendar_sync_status: 'synced',
          external_calendar_id: 'cal',
          external_event_id: 'evt',
        }),
      ],
    };
    await openToday(withTask);

    expect(within(queueSection()).getByText('On your calendar')).toBeTruthy();
  });

  it('reports a calendar failure as a failure', async () => {
    const data = pipelineData();
    const withTask: Dataset = {
      ...data,
      tasks: [
        makeTask({
          id: 'task-ernesto',
          lead_id: 'ernesto',
          task_type: 'follow_up',
          status: 'open',
          due_date: '2026-09-15',
          follow_up_rule_managed: true,
          calendar_sync_status: 'error',
          sync_error: 'Google Calendar insert failed (HTTP 403)',
        }),
      ],
    };
    await openToday(withTask);

    expect(within(queueSection()).getByText('Calendar sync failed')).toBeTruthy();
  });

  it('leaves out the people who are deliberately not being chased', async () => {
    await openToday();
    const section = queueSection();

    expect(within(section).queryByText('Name pending')).toBeNull();
    expect(within(section).queryByText('Tyson Harvey')).toBeNull();
  });

  it('explains why somebody held or archived is not on the list', async () => {
    const held: Dataset = {
      ...EMPTY_DATASET,
      leads: [
        makeLead({
          id: 'held',
          prospect_name: 'On The Brew',
          stage: 'waiting',
          follow_up_mode: 'hold',
          next_action_date: '2026-09-01',
        }),
      ],
    };
    await openToday(held);
    const section = queueSection();

    expect(within(section).queryByText('On The Brew')).toBeNull();
    expect(section.textContent).toContain('deliberately on hold');
  });

  it('keeps what is coming up out of the way until it is asked for', async () => {
    await openToday();
    const section = queueSection();

    // Tyson is scheduled for November, so he is not in the default view.
    expect(within(section).queryByText('Tyson Harvey')).toBeNull();

    const reveal = within(section).getByRole('button', { name: /Show \d+ coming up/ });
    fireEvent.click(reveal);

    await waitFor(() =>
      expect(within(queueSection()).getByText('Tyson Harvey')).toBeTruthy(),
    );
    // And it can be put away again.
    fireEvent.click(
      within(queueSection()).getByRole('button', { name: /Hide the ones that are not due yet/ }),
    );
    await waitFor(() =>
      expect(within(queueSection()).queryByText('Tyson Harvey')).toBeNull(),
    );
  });

  it('never offers to record contact just because a link was opened', async () => {
    // Tapping through to an email client is not evidence a message was sent.
    await openToday();
    const section = queueSection();

    expect(within(section).queryByRole('button', { name: /mark.*contact/i })).toBeNull();
    expect(within(section).queryByRole('link', { name: /^mailto:/ })).toBeNull();
    expect(section.textContent).toContain('not recorded as contact');
  });

  it('links to the one person rather than to the pipeline in general', async () => {
    await openToday();
    const open = within(queueSection()).getByRole('link', { name: /Open Ernesto Gil/ });
    expect(open.getAttribute('href')).toBe('/pipeline?lead=ernesto');
  });
});

/* ========================================================== the pipeline == */

describe('the Pipeline action queue', () => {
  pinTheClock();

  const openPipeline = async (path = '/pipeline', data: Dataset = pipelineData()) => {
    renderWith(supabaseContext({ data }), path, <Pipeline key="p" />, '/pipeline');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
  };

  it('is offered alongside Board and Table, not instead of them', async () => {
    await openPipeline();
    expect(screen.getByRole('button', { name: 'Action queue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Board' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Table' })).toBeTruthy();
  });

  it('puts whoever is due now above whoever is due later', async () => {
    await openPipeline();
    fireEvent.click(screen.getByRole('button', { name: 'Action queue' }));

    await waitFor(() => expect(screen.getByText('Do these now (1)')).toBeTruthy());
    const body = document.body.textContent ?? '';
    expect(body.indexOf('Do these now')).toBeLessThan(body.indexOf('Due within'));
    expect(body.indexOf('Due within')).toBeLessThan(body.indexOf('Later'));
  });

  it('keeps the ones nobody is chasing collapsed below', async () => {
    await openPipeline();
    fireEvent.click(screen.getByRole('button', { name: 'Action queue' }));

    await waitFor(() => expect(screen.getByText(/Not being chased/)).toBeTruthy());
    // Collapsed, so the person set to no follow-up is not on screen yet.
    expect(screen.queryByText('Name pending')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(screen.getByText('Name pending')).toBeTruthy());
  });

  it('says honestly where a last touch came from', async () => {
    await openPipeline();
    fireEvent.click(screen.getByRole('button', { name: 'Action queue' }));

    await waitFor(() => expect(screen.getByText('Do these now (1)')).toBeTruthy());
    // Ernesto's touch is a logged activity, so it is not labelled as reported.
    const body = document.body.textContent ?? '';
    expect(body).toContain('days since the last touch');
  });

  it('opens the requested lead when something deep-links to it', async () => {
    await openPipeline('/pipeline?lead=taylor');

    // The drawer for that exact person, not the list.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Taylor' })).toBeTruthy(),
    );
  });

  it('ignores a lead id that is not in the pipeline rather than breaking', async () => {
    await openPipeline('/pipeline?lead=does-not-exist');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Pipeline');
  });
});
