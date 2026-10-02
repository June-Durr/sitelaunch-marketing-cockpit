import { useCallback, useEffect, useMemo, useState } from 'react';
import { useData } from '../data/context';
import { Empty, Notice, Observed, Section, Tag } from '../components/primitives';
import { formatDay } from '../lib/dates';
import { aggregate } from '../lib/metrics';
import type { AnalyticsStatus } from '../data/repository';

/** How many rows of each source the tables render. The totals cover every row. */
const ROW_WINDOW = 50;

/**
 * The rows that arrived on their own, kept visibly apart from the ones typed in.
 *
 * WHY THESE ARE NOT MERGED WITH THE MANUAL TABLE
 *
 * A typed row covers a date range someone chose. A synced row covers exactly one
 * day. Adding them together would double count every day that a manual row also
 * happens to span, and there is no way to detect that overlap after the fact,
 * because a range that covers a day is not evidence that it came from the same
 * place. So they sit in two tables, each labelled with where it came from, and
 * the reader does the comparing.
 *
 * That is deliberately less tidy than one merged number, and considerably harder
 * to be wrong with.
 */
export function SyncedAnalytics() {
  const { loadAnalytics, mode } = useData();
  const [status, setStatus] = useState<AnalyticsStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!loadAnalytics) return;
    try {
      setStatus(await loadAnalytics());
      setProblem(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  }, [loadAnalytics]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load();
  }, [load]);

  const ga4 = useMemo(() => status?.ga4 ?? [], [status]);
  const searchConsole = useMemo(() => status?.searchConsole ?? [], [status]);

  if (mode === 'local' || !loadAnalytics) return null;

  if (problem) {
    return (
      <Section title="Brought in automatically" note="could not read">
        <p className="notice notice-crimson">{problem}</p>
      </Section>
    );
  }

  if (ga4.length === 0 && searchConsole.length === 0) {
    return (
      <Section title="Brought in automatically" note="nothing yet">
        <Empty title="Nothing synced yet">
          Once the Google sync has run, the rows it brought in appear here, separately from
          anything you typed in above.
        </Empty>
      </Section>
    );
  }

  const sessions = aggregate(ga4.map((r) => r.sessions));
  const leads = aggregate(ga4.map((r) => r.generate_lead_events));
  const clicks = aggregate(searchConsole.map((r) => r.clicks));

  // Newest first is how the sync stores them, and the most recent rows are the ones
  // worth looking at, so only a window is rendered. Whenever that window hides
  // anything, the table says so underneath rather than trailing off in silence.
  const ga4Recent = ga4.slice(0, ROW_WINDOW);
  const searchRecent = searchConsole.slice(0, ROW_WINDOW);

  // Rows, not days. One GA4 day arrives as a row per source, medium and campaign,
  // and one Search Console day as a row per query and page, so this total runs well
  // ahead of the number of days covered. Calling it days would overstate the range
  // the sync has reached by a wide margin.
  const totalRows = ga4.length + searchConsole.length;

  return (
    <Section
      title="Brought in automatically"
      note={`${totalRows.toLocaleString()} synced ${totalRows === 1 ? 'row' : 'rows'}`}
    >
      <Notice>
        These rows came from Google on their own. They are kept apart from the rows above,
        which you typed in or imported, because a typed row covers a range and one of these
        covers a single day. Adding the two together would count some days twice.
      </Notice>

      <div className="stat-strip" style={{ marginTop: '1rem' }}>
        <Stat label="Visits, synced" value={sessions.sum} n={sessions.n} total={ga4.length} />
        <Stat label="Enquiry events" value={leads.sum} n={leads.n} total={ga4.length} />
        <Stat label="Search clicks" value={clicks.sum} n={clicks.n} total={searchConsole.length} />
      </div>

      {ga4Recent.length > 0 ? (
        <>
          <div className="fieldset-legend">
            Google Analytics <Tag tone="violet">synced</Tag>
          </div>
          <Truncation shown={ga4Recent.length} total={ga4.length} />
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Source / medium</th>
                  <th>Campaign</th>
                  <th className="num">Sessions</th>
                  <th className="num">Users</th>
                  <th className="num">Engaged</th>
                  <th className="num">Enquiries</th>
                </tr>
              </thead>
              <tbody>
                {ga4Recent.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Day">{formatDay(row.date)}</td>
                    <td data-label="Source / medium">{row.source} / {row.medium}</td>
                    <td data-label="Campaign">{row.campaign}</td>
                    <td className="num" data-label="Sessions"><Observed value={row.sessions} /></td>
                    <td className="num" data-label="Users"><Observed value={row.active_users} /></td>
                    <td className="num" data-label="Engaged"><Observed value={row.engaged_sessions} /></td>
                    <td className="num" data-label="Enquiries">
                      <Observed value={row.generate_lead_events} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {searchRecent.length > 0 ? (
        <>
          <div className="fieldset-legend">
            Search Console <Tag tone="violet">synced</Tag>
          </div>
          <Truncation shown={searchRecent.length} total={searchConsole.length} />
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Search</th>
                  <th>Page</th>
                  <th className="num">Clicks</th>
                  <th className="num">Impressions</th>
                  <th className="num">Position</th>
                </tr>
              </thead>
              <tbody>
                {searchRecent.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Day">{formatDay(row.date)}</td>
                    <td data-label="Search">{row.query}</td>
                    <td data-label="Page">{row.page}</td>
                    <td className="num" data-label="Clicks"><Observed value={row.clicks} /></td>
                    <td className="num" data-label="Impressions">
                      <Observed value={row.impressions} />
                    </td>
                    <td className="num" data-label="Position">
                      <Observed value={row.average_position} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Section>
  );
}

/**
 * A count that says how much of the data it is actually based on.
 *
 * `n` counts rows carrying a real figure, and a row with nothing recorded is not
 * one of them. That is what keeps a missing number from reading as a zero here:
 * the total is a sum of what was observed, and the note says how many rows it came
 * from, so a small `n` against a large `total` is visible rather than hidden.
 */
function Stat({
  label, value, n, total,
}: {
  label: string; value: number | null; n: number; total: number;
}) {
  return (
    <div className="stat">
      <div className="stat-value">{value === null ? 'None yet' : value.toLocaleString()}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-note">
        {n.toLocaleString()} of {total.toLocaleString()} {total === 1 ? 'row has' : 'rows have'}{' '}
        a figure
      </div>
    </div>
  );
}

/** Says plainly when a table is only showing the newest slice of what is stored. */
function Truncation({ shown, total }: { shown: number; total: number }) {
  if (shown >= total) return null;
  return (
    <p className="field-hint">
      Showing the latest {shown.toLocaleString()} of {total.toLocaleString()} rows, newest
      first. The totals above count all {total.toLocaleString()}.
    </p>
  );
}
