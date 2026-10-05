import { useCallback, useEffect, useState } from 'react';
import { useData } from '../data/context';
import { Empty, Notice, Section, Tag } from '../components/primitives';
import { formatDateTime } from '../lib/dates';
import { formatNumber } from '../lib/format';
import type { AnalyticsProvider, AnalyticsStatus } from '../data/repository';
import {
  PROVIDER_LABELS, STATUS_EXPLANATIONS, STATUS_LABELS, type IntegrationStatus,
} from '../types/integrations';

/**
 * What the automatic Google sync is doing, and the one button that starts it.
 *
 * Everything here is read back from the database rather than assumed. The GA4
 * property and the Search Console site shown below are the ones the server
 * actually recorded when it last connected, not values compiled into this page,
 * so if the two ever disagree this screen shows the truth rather than the
 * intention. Until a sync has run there is no connection row and the panel says
 * so plainly instead of showing a hopeful blank.
 *
 * No credential passes through here. The browser holds no Google key; pressing
 * Sync now sends this person's own session to a server function, and the function
 * does the rest.
 */

const PROVIDERS: { id: AnalyticsProvider; label: string; what: string }[] = [
  { id: 'ga4', label: 'Google Analytics 4', what: 'Daily visits, by where they came from' },
  { id: 'search_console', label: 'Search Console', what: 'Daily clicks, impressions and position' },
];

/**
 * When the cron jobs run, as scheduled on the project.
 *
 * Both jobs are live, so this is a statement of what happens rather than of what
 * would happen. The two are fifteen minutes apart so they do not contend for the
 * same outbound connections. The times are written out here rather than read back
 * from cron.job, which the browser has no business querying; Last successful and
 * Last attempted in the table are the evidence that the schedule is really firing.
 */
const SCHEDULE = {
  ga4: '08:00 UTC daily',
  search_console: '08:15 UTC daily',
};

function tone(status: IntegrationStatus) {
  if (status === 'connected') return 'violet';
  if (status === 'error') return 'crimson';
  if (status === 'syncing') return 'amber';
  return 'quiet';
}

export function GoogleSyncPanel() {
  const { loadAnalytics, triggerSync, mode } = useData();
  const [status, setStatus] = useState<AnalyticsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<AnalyticsProvider | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!loadAnalytics) return;
    setLoading(true);
    try {
      setStatus(await loadAnalytics());
      setProblem(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [loadAnalytics]);

  useEffect(() => {
    // Reading the sync tables is exactly the external synchronisation an effect
    // is for, and the state writes happen after the await.
    // oxlint-disable-next-line react/set-state-in-effect
    void load();
  }, [load]);

  if (mode === 'local' || !loadAnalytics) {
    return (
      <Section title="Automatic analytics" note="not available here">
        <Notice>
          You are running on this browser alone. Automatic syncing needs a server to hold
          the Google credentials and do the fetching, so it starts working once this
          cockpit is on Supabase.
        </Notice>
      </Section>
    );
  }

  async function sync(provider: AnalyticsProvider) {
    if (!triggerSync) return;
    setBusy(provider);
    setLastAction(null);
    try {
      const outcome = await triggerSync(provider, 'daily');
      setLastAction(
        outcome.ok
          ? `${outcome.status}, ${formatNumber(outcome.rowsWritten)} rows written`
          : `Did not run: ${outcome.error ?? outcome.status}`,
      );
    } catch (err) {
      setLastAction(`Did not run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
      await load();
    }
  }

  const connectionFor = (provider: AnalyticsProvider) =>
    status?.connections.find((c) => c.provider === provider) ?? null;

  // sync_runs is shared by every integration, so every read of it in this panel
  // narrows to one provider first.
  const runsFor = (provider: AnalyticsProvider) =>
    (status?.runs ?? []).filter((r) => r.provider === provider);

  return (
    <Section title="Automatic analytics" note="Google">
      <p className="page-lede" style={{ marginTop: 0 }}>
        These two bring themselves in. A server reads them on a schedule and writes the
        result here, which is why this is the only part of the cockpit you do not have to
        type into. The credentials live on that server and never reach this browser.
      </p>

      {problem ? <p className="notice notice-crimson">{problem}</p> : null}
      {lastAction ? <p className="notice">{lastAction}</p> : null}

      {loading && !status ? (
        <Empty title="Checking">Reading what the sync has done so far.</Empty>
      ) : null}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Source</th>
              <th>State</th>
              <th>Property</th>
              <th>Last successful</th>
              <th>Last attempted</th>
              <th>Next scheduled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {PROVIDERS.map(({ id, label, what }) => {
              const connection = connectionFor(id);
              const runs = runsFor(id);
              const lastAttempt = runs[0] ?? null;
              const lastSuccess = runs.find((r) => r.status === 'succeeded') ?? null;
              const state: IntegrationStatus = connection?.status ?? 'not_configured';

              return (
                <tr key={id}>
                  <td data-label="Source">
                    <strong>{label}</strong>
                    <div className="row-note">{what}</div>
                  </td>
                  <td data-label="State">
                    <Tag tone={tone(state)} title={STATUS_EXPLANATIONS[state]}>
                      {STATUS_LABELS[state]}
                    </Tag>
                  </td>
                  <td data-label="Property">
                    {/* Written by the server on connect, so this is what it really read. */}
                    {connection?.provider_account_id ?? <span className="quiet">Not connected yet</span>}
                  </td>
                  <td data-label="Last successful">
                    {lastSuccess
                      ? formatDateTime(lastSuccess.completed_at ?? lastSuccess.started_at)
                      : <span className="quiet">Never</span>}
                  </td>
                  <td data-label="Last attempted">
                    {lastAttempt ? formatDateTime(lastAttempt.started_at) : <span className="quiet">Never</span>}
                  </td>
                  <td data-label="Next scheduled">{SCHEDULE[id]}</td>
                  <td data-label="">
                    <button
                      className="btn"
                      disabled={busy !== null || !triggerSync}
                      onClick={() => void sync(id)}
                    >
                      {busy === id ? 'Syncing…' : 'Sync now'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <LastError status={status} />

      <p className="notice">
        A sync only ever asks for days that have finished, and re-asks for the previous
        week each time so late corrections land. Running it twice changes nothing, so the
        button above is safe to press as often as you like.
      </p>
    </Section>
  );
}

/**
 * The most recent failure per provider, as the server sanitized it.
 *
 * Filtered to the two providers this panel is about. sync_runs is shared by every
 * integration, so without the filter a failure belonging to something else shows
 * up here, and labelling it by a two-way guess would print the wrong provider's
 * name next to it. That is worse than not showing it: it sends somebody to
 * investigate a service that is working.
 */
function LastError({ status }: { status: AnalyticsStatus | null }) {
  const mine = new Set<string>(PROVIDERS.map((p) => p.id));
  const failures = (status?.runs ?? []).filter(
    (r) => r.status === 'failed' && mine.has(r.provider),
  );
  if (failures.length === 0) return null;

  const latest = new Map<string, (typeof failures)[number]>();
  for (const run of failures) if (!latest.has(run.provider)) latest.set(run.provider, run);

  return (
    <div style={{ marginTop: '1rem' }}>
      {[...latest.values()].map((run) => (
        <p key={run.id} className="notice notice-crimson">
          {/* Named from the shared label map, so a provider added later cannot
              inherit the wrong name from a ternary. */}
          <strong>{PROVIDER_LABELS[run.provider] ?? run.provider}</strong>{' '}
          failed at {formatDateTime(run.started_at)}: {run.error_summary}
        </p>
      ))}
    </div>
  );
}
