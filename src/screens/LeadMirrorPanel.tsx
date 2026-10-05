import { useCallback, useEffect, useState } from 'react';
import { useData } from '../data/context';
import { Empty, Notice, Section, Tag } from '../components/primitives';
import { formatDateTime } from '../lib/dates';
import type { LeadMirrorOutcome, LeadMirrorStatus } from '../data/repository';
import { STATUS_EXPLANATIONS, STATUS_LABELS, type IntegrationStatus } from '../types/integrations';

/**
 * The Google Sheet mirror, and the two buttons that drive it.
 *
 * WHICH WAY THE DATA GOES
 *
 * Out, nearly always. Supabase is the authoritative copy and the spreadsheet is a
 * readable mirror of it, so the sync rewrites the sheet and never reads it back as
 * truth. The one exception is the reconciliation, which exists to bring a
 * hand-built history in once, and which is deliberately a two-step: look at what
 * it would do, then do it. After that there is nothing left to import.
 *
 * NO CREDENTIAL PASSES THROUGH HERE
 *
 * This browser holds no Google key and does not know which spreadsheet it is.
 * Both live in the server function's secrets. Pressing a button sends this
 * person's own Supabase session and asks the server to do the work, and what comes
 * back is counts and sanitized text.
 *
 * WHAT HAPPENS WHEN IT BREAKS
 *
 * The panel says so and nothing else changes. A failed sheet sync cannot damage
 * Supabase, because the export only ever reads from it, and it cannot stop the
 * rest of the Cockpit working, because nothing else on any screen depends on the
 * spreadsheet being current.
 */

function tone(status: IntegrationStatus) {
  if (status === 'connected') return 'violet';
  if (status === 'error') return 'crimson';
  if (status === 'syncing') return 'amber';
  return 'quiet';
}

/** Counts in the order a person would want to read them, with plain names. */
const COUNT_LABELS: [string, string][] = [
  ['leadRowsRead', 'Relationship rows read'],
  ['touchRowsRead', 'Touch rows read'],
  ['leadsToCreate', 'Leads to create'],
  ['leadsToUpdate', 'Leads to update'],
  ['leadsUnchanged', 'Leads already correct'],
  ['ambiguousMatches', 'Ambiguous matches'],
  ['touchesToCreate', 'Touches to create'],
  ['touchesAlreadyPresent', 'Touches already there'],
  ['rejectedRows', 'Rows that could not be read'],
];

export function LeadMirrorPanel() {
  const { loadLeadMirror, triggerLeadMirror, mode } = useData();
  const [status, setStatus] = useState<LeadMirrorStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The last dry run, which is also what a live import is allowed to expect. */
  const [dryRun, setDryRun] = useState<LeadMirrorOutcome | null>(null);
  const [lastExport, setLastExport] = useState<LeadMirrorOutcome | null>(null);
  const [applied, setApplied] = useState<LeadMirrorOutcome | null>(null);

  const load = useCallback(async () => {
    if (!loadLeadMirror) return;
    try {
      setStatus(await loadLeadMirror());
      setProblem(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  }, [loadLeadMirror]);

  useEffect(() => {
    // Reading the stored connection state is exactly the external-system
    // synchronisation an effect is for; the state writes happen after the await.
    // oxlint-disable-next-line react/set-state-in-effect
    void load();
  }, [load]);

  if (mode === 'local' || !loadLeadMirror || !triggerLeadMirror) {
    return (
      <Section title="Google Sheet lead mirror" note="not available here">
        <Notice>
          You are running on this browser alone. Writing to a Google Sheet needs a server
          to hold the Google credentials, so this starts working once the cockpit is on
          Supabase. Nothing is lost in the meantime: the Export a backup button above
          saves everything to a file.
        </Notice>
      </Section>
    );
  }

  async function run(
    label: string,
    work: () => Promise<LeadMirrorOutcome>,
    keep: (outcome: LeadMirrorOutcome) => void,
  ) {
    setBusy(label);
    setProblem(null);
    try {
      keep(await work());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      await load();
    }
  }

  const connection = status?.connection ?? null;
  const state: IntegrationStatus = connection?.status ?? 'not_configured';
  const runs = status?.runs ?? [];
  const lastSuccess = runs.find((r) => r.status === 'succeeded') ?? null;
  const lastAttempt = runs[0] ?? null;

  /**
   * Is the sheet safe to import?
   *
   * Only a clean dry run says so: no ambiguity, no rejected row, and something
   * actually there to bring in. The expectation sent to the server comes from what
   * the dry run saw, so if the sheet changes between looking and importing, the
   * server refuses rather than importing something nobody reviewed.
   */
  const counts = dryRun?.counts ?? null;
  const importable =
    dryRun !== null &&
    dryRun.ok &&
    counts !== null &&
    dryRun.ambiguous.length === 0 &&
    dryRun.rejected.length === 0 &&
    (counts.leadsToCreate > 0 || counts.leadsToUpdate > 0 || counts.touchesToCreate > 0);

  return (
    <Section title="Google Sheet lead mirror" note="Google Sheets">
      <p className="page-lede" style={{ marginTop: 0 }}>
        The spreadsheet is a readable copy of the pipeline, not where it lives. This
        cockpit is the real record; the sheet is there so the whole thing can be read on a
        phone, handed to somebody else, or used to get everything back if this app
        disappears. Syncing rewrites the sheet from here, so an edit made in the
        spreadsheet is replaced the next time it runs rather than quietly becoming true.
      </p>

      {problem ? <p className="notice notice-crimson">{problem}</p> : null}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>State</th>
              <th>Spreadsheet</th>
              <th>Last successful</th>
              <th>Last attempted</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="State">
                <Tag tone={tone(state)} title={STATUS_EXPLANATIONS[state]}>
                  {STATUS_LABELS[state]}
                </Tag>
              </td>
              <td data-label="Spreadsheet">
                {/* Written by the server when it last connected, so this is the
                    sheet it really opened. The spreadsheet id is a server secret
                    and is deliberately not shown or stored. */}
                {connection?.provider_account_id ?? (
                  <span className="quiet">Not connected yet</span>
                )}
              </td>
              <td data-label="Last successful">
                {lastSuccess ? (
                  formatDateTime(lastSuccess.completed_at ?? lastSuccess.started_at)
                ) : (
                  <span className="quiet">Never</span>
                )}
              </td>
              <td data-label="Last attempted">
                {lastAttempt ? (
                  formatDateTime(lastAttempt.started_at)
                ) : (
                  <span className="quiet">Never</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {connection?.status === 'error' && connection.error_message ? (
        <p className="notice notice-crimson">
          The last attempt failed at {formatDateTime(connection.error_at)}:{' '}
          {connection.error_message}
        </p>
      ) : null}

      <div className="btn-row" style={{ marginTop: '1.25rem' }}>
        <button
          className="btn btn-primary"
          disabled={busy !== null}
          title="Rewrites both tabs of the spreadsheet from what is in this cockpit right now."
          onClick={() =>
            void run('export', () => triggerLeadMirror('export'), setLastExport)
          }
        >
          {busy === 'export' ? 'Syncing…' : 'Sync lead mirror now'}
        </button>
        <button
          className="btn"
          disabled={busy !== null}
          title="Reads the spreadsheet and reports what importing it would change. Writes nothing."
          onClick={() =>
            void run(
              'dry_run',
              () => triggerLeadMirror('reconcile', { mode: 'dry_run' }),
              (outcome) => {
                setDryRun(outcome);
                setApplied(null);
              },
            )
          }
        >
          {busy === 'dry_run' ? 'Reading…' : 'Check what the sheet would change'}
        </button>
        {importable && counts ? (
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() =>
              void run(
                'live',
                () =>
                  triggerLeadMirror('reconcile', {
                    mode: 'live',
                    // What the dry run actually saw. If the sheet has changed
                    // since, the server refuses rather than importing blind.
                    expect: {
                      leadRows: counts.leadRowsRead,
                      touchRows: counts.touchRowsRead,
                    },
                  }),
                setApplied,
              )
            }
          >
            {busy === 'live' ? 'Importing…' : 'Bring the sheet in'}
          </button>
        ) : null}
      </div>

      {lastExport ? <ExportResult outcome={lastExport} /> : null}
      {dryRun ? <ReconcileReport outcome={dryRun} heading="What importing would do" /> : null}
      {applied ? <ReconcileReport outcome={applied} heading="What the import did" /> : null}

      {dryRun === null && applied === null ? (
        <p className="notice">
          The import is a one-off. It brings a spreadsheet of relationships and touches
          that were kept by hand into this database, after which the sheet is written to
          and never read. Checking first is free and changes nothing, so start there.
        </p>
      ) : null}
    </Section>
  );
}

function ExportResult({ outcome }: { outcome: LeadMirrorOutcome }) {
  if (!outcome.ok) {
    return (
      <p className="notice notice-crimson">
        The sheet was not updated: {outcome.error ?? outcome.status}. Nothing in this
        cockpit changed, and nothing here depends on the spreadsheet being current.
      </p>
    );
  }
  return (
    <p className="notice notice-violet">
      Wrote {outcome.leadRows ?? 0} relationship{' '}
      {outcome.leadRows === 1 ? 'row' : 'rows'} and {outcome.touchRows ?? 0} touch{' '}
      {outcome.touchRows === 1 ? 'row' : 'rows'}. The title, the notes at the top, the
      frozen header and any filters are untouched, because the sync only ever writes the
      rows below them.
    </p>
  );
}

function ReconcileReport({
  outcome,
  heading,
}: {
  outcome: LeadMirrorOutcome;
  heading: string;
}) {
  if (!outcome.ok && outcome.status !== 'blocked') {
    return (
      <p className="notice notice-crimson">
        {heading}: nothing, because the sheet could not be read.{' '}
        {outcome.error ?? outcome.status}
      </p>
    );
  }

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <div className="fieldset-legend">{heading}</div>

      {outcome.status === 'blocked' ? (
        <div className="notice notice-amber">
          <strong>Stopped before writing anything.</strong>
          <ul>
            {outcome.gateReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          Nothing was created, changed or deleted. Fix the spreadsheet, check again, then
          import.
        </div>
      ) : null}

      {outcome.counts ? (
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {COUNT_LABELS.filter(([key]) => outcome.counts?.[key] !== undefined).map(
                ([key, label]) => (
                  <tr key={key}>
                    <td data-label="What">{label}</td>
                    <td className="num" data-label="How many">
                      {outcome.counts?.[key]}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {outcome.applied ? (
        <p className="notice notice-violet">
          Created {outcome.applied.leadsCreated}{' '}
          {outcome.applied.leadsCreated === 1 ? 'lead' : 'leads'}, updated{' '}
          {outcome.applied.leadsUpdated}, and added {outcome.applied.touchesCreated} touch{' '}
          {outcome.applied.touchesCreated === 1 ? 'record' : 'records'}. Running this again
          would change nothing: every lead and every touch now carries a key the import
          recognises.
        </p>
      ) : null}

      {outcome.ambiguous.length > 0 ? (
        <>
          <div className="fieldset-legend">
            Left alone because more than one person could have been meant
          </div>
          <Notice tone="amber">
            These rows were not touched at all. Deciding which existing person a row
            refers to is a guess about somebody real, so the app refuses to make it.
            Resolve it by hand in the Pipeline, then check again.
          </Notice>
          <ul className="queue">
            {outcome.ambiguous.map((row) => (
              <li key={`${row.tab}-${row.rowNumber}`}>
                <div className="queue-main">
                  <div className="queue-title">
                    {row.label} · {row.tab} row {row.rowNumber}
                  </div>
                  <div className="queue-meta">{row.reason}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {outcome.rejected.length > 0 ? (
        <>
          <div className="fieldset-legend">Rows that could not be read</div>
          <ul className="queue">
            {outcome.rejected.map((row) => (
              <li key={`${row.tab}-${row.rowNumber}-${row.label}`}>
                <div className="queue-main">
                  <div className="queue-title">
                    {row.label} · {row.tab} row {row.rowNumber}
                  </div>
                  <div className="queue-meta">{row.reason}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {outcome.warnings.length > 0 ? (
        <>
          <div className="fieldset-legend">Worth knowing</div>
          <ul className="queue">
            {outcome.warnings.map((warning) => (
              <li key={warning}>
                <div className="queue-main">
                  <div className="queue-meta">{warning}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {outcome.status === 'dry_run' &&
      outcome.ambiguous.length === 0 &&
      outcome.rejected.length === 0 ? (
        <p className="notice">
          Nothing was written. Every blank cell stays blank in the database rather than
          becoming a zero or a guessed date, no two people are merged, and importing the
          same sheet again would add nothing.
        </p>
      ) : null}

      {outcome.counts &&
      outcome.counts.leadsToCreate === 0 &&
      outcome.counts.leadsToUpdate === 0 &&
      outcome.counts.touchesToCreate === 0 &&
      outcome.status === 'dry_run' ? (
        <Empty title="There is nothing left to import">
          Everything in the spreadsheet is already here. From now on the sync runs the
          other way: this cockpit is the record, and the sheet is rewritten from it.
        </Empty>
      ) : null}
    </div>
  );
}
