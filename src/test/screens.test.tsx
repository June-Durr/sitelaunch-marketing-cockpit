/**
 * Render smoke tests. Every screen must mount against the seed data without
 * throwing, and the screens that display metrics must show an absent value as an
 * em dash rather than a zero.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { DataProvider } from '../data/DataProvider';
import { ContentLog } from '../screens/ContentLog';
import { DataImport } from '../screens/DataImport';
import { Pipeline } from '../screens/Pipeline';
import { Recommendations } from '../screens/Recommendations';
import { Tasks } from '../screens/Tasks';
import { Today } from '../screens/Today';
import { WebsiteOutcomes } from '../screens/WebsiteOutcomes';
import { Activity as ActivityScreen } from '../screens/Activity';
import { createLocalRepository } from '../data/localRepository';

function renderAt(path: string, element: React.ReactNode) {
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

const SCREENS: [string, string, React.ReactNode][] = [
  ['Today', '/', <Today key="t" />],
  ['Content Log', '/content', <ContentLog key="c" />],
  ['Website Outcomes', '/website', <WebsiteOutcomes key="w" />],
  ['Pipeline', '/pipeline', <Pipeline key="p" />],
  ['Tasks', '/tasks', <Tasks key="k" />],
  ['Recommendations', '/recommendations', <Recommendations key="r" />],
  ['Data & Import', '/data', <DataImport key="d" />],
  ['Activity', '/activity', <ActivityScreen key="a" />],
];

describe('every screen mounts against the seed data', () => {
  for (const [name, path, element] of SCREENS) {
    it(`renders ${name}`, async () => {
      renderAt(path, element);
      await waitFor(() =>
        expect(screen.getByRole('heading', { level: 1 })).toBeTruthy(),
      );
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(name);
    });
  }
});

describe('the interface keeps unknown apart from zero', () => {
  it('shows an em dash, not 0, for the metrics the seed never recorded', async () => {
    renderAt('/content', <ContentLog key="c" />);
    await waitFor(() => expect(screen.getByText('SiteLaunch BTS Story')).toBeTruthy());

    const row = screen.getByText('SiteLaunch BTS Story').closest('tr');
    expect(row).toBeTruthy();
    const cells = within(row as HTMLElement);

    // The one observed figure.
    expect(cells.getByText('31')).toBeTruthy();
    // Link clicks and enquiries were never recorded, so they must not read as 0.
    expect(cells.queryByText('0')).toBeNull();
    expect(
      cells.getAllByTitle(/This is not a zero\./).length,
    ).toBeGreaterThan(0);
    expect(cells.getAllByText('Not checked').length).toBeGreaterThan(0);
  });

  it('marks the Facebook cross-post unavailable rather than empty', async () => {
    renderAt('/content', <ContentLog key="c" />);
    await waitFor(() =>
      expect(screen.getByText('SiteLaunch BTS Story (Facebook cross-post)')).toBeTruthy(),
    );
    const row = screen
      .getByText('SiteLaunch BTS Story (Facebook cross-post)')
      .closest('tr') as HTMLElement;
    expect(within(row).getByText('Not shared')).toBeTruthy();
  });
});

describe('the amplified record is visible but labelled', () => {
  it('shows it in the content log with an amplified tag', async () => {
    renderAt('/content', <ContentLog key="c" />);
    await waitFor(() =>
      expect(screen.getByText(/boosted by Only in Dade/i)).toBeTruthy(),
    );
    expect(screen.getAllByText('Boosted').length).toBeGreaterThan(0);
    expect(screen.getByText(/kept out of the\s+averages/i)).toBeTruthy();
  });

  it('explains the exclusion on the recommendations screen', async () => {
    renderAt('/recommendations', <Recommendations key="r" />);
    await waitFor(() =>
      expect(
        screen.getByRole('heading', {
          name: /externally amplified item is excluded from Instagram story averages/i,
        }),
      ).toBeTruthy(),
    );
    expect(screen.getAllByText(/Not yet measurable/i).length).toBeGreaterThan(0);
  });
});

describe('Today leads with a single next step', () => {
  it('shows exactly one recommended next step', async () => {
    renderAt('/', <Today key="t" />);
    await waitFor(() =>
      expect(screen.getByText('One recommended next step')).toBeTruthy(),
    );
    expect(screen.getAllByText('One recommended next step')).toHaveLength(1);
  });

  it('states the program dates rather than implying them', async () => {
    renderAt('/', <Today key="t" />);
    await waitFor(() => expect(screen.getByText('Program progress')).toBeTruthy());
    const head = screen.getByText('Program progress').closest('.section-head');
    expect((head as HTMLElement).textContent).toMatch(/Aug 27, 2026/);
    expect((head as HTMLElement).textContent).toMatch(/Nov 25, 2026/);
  });

  it('shows the program day, phase and target rather than a rolling window', async () => {
    renderAt('/', <Today key="t" />);
    await waitFor(() => expect(screen.getByText(/SiteLaunch 90 Day Program/)).toBeTruthy());

    const bar = document.querySelector('.program-bar') as HTMLElement;
    expect(bar).toBeTruthy();
    // A day number is shown and it is never the trailing-window language.
    expect(bar.textContent).toMatch(/Day \d+ of 91/);
    expect(bar.textContent).toMatch(/Phase [123]:/);
    expect(bar.textContent).toMatch(/Nov 25, 2026/);
    expect(document.body.textContent).not.toMatch(/90-day progress/);
  });
});

describe('program statistics count only what falls inside the program', () => {
  it('ignores a post published before the program started', async () => {
    // The seed outlier is dated 1 September 2026, inside the program. Add one
    // dated before the start and check it is not counted.
    const repo = createLocalRepository();
    const seeded = await repo.loadAll();
    await repo.insert('content_items', {
      account_id: seeded.accounts[0].id,
      cross_post_group_id: null,
      title: 'Old post from before the program',
      format: 'post',
      status: 'measured',
      published_at: '2026-07-01T12:00:00.000Z',
      pillar: null, target_audience: null, hook: null, cta: null,
      destination_url: null, utm_source: null, utm_medium: null, utm_campaign: null,
      is_externally_amplified: false, amplifier_name: null, amplification_note: null,
      notes: null, screenshot_url: null, external_id: null, is_seed: false,
    });

    renderAt('/', <Today key="t" />);
    await waitFor(() => expect(screen.getByText('Program progress')).toBeTruthy());

    const strip = screen
      .getByText('Program progress')
      .closest('section')
      ?.querySelector('.stat-strip') as HTMLElement;
    const published = within(strip).getByText('Published').closest('.stat') as HTMLElement;

    // Three seed items sit inside the program. The July post must not be counted.
    expect(published.querySelector('.stat-value')?.textContent).toBe('3');
  });
});

describe('the Activity screen', () => {
  it('renders and starts empty, because nothing is ever invented', async () => {
    renderAt('/activity', <ActivityScreen key="a" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Activity');
    expect(screen.getByText('Nothing logged yet')).toBeTruthy();
  });

  it('explains that a task is a plan and an activity is a record', async () => {
    renderAt('/activity', <ActivityScreen key="a" />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
    expect(screen.getByText(/Tasks are what you plan to do/)).toBeTruthy();
    expect(screen.getByText(/never invents activity/)).toBeTruthy();
  });
});
