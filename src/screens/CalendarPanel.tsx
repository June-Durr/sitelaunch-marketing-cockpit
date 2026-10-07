import { useCallback, useEffect, useState } from 'react';
import { useData } from '../data/context';
import { Notice, Section, Tag } from '../components/primitives';
import { formatDateTime } from '../lib/dates';
import type { CalendarStatus, CalendarSyncOutcome } from '../data/repository';
import { STATUS_EXPLANATIONS, STATUS_LABELS, type IntegrationStatus } from '../types/integrations';

/**
 * The follow-up calendar, and the one button that writes to it.
 *
 * Everything here is read back from the database rather than assumed. The
 * calendar shown below is the one the server actually wrote to when it last
 * connected, not a value compiled into this page, so if the two ever disagree
 * this screen shows the truth rather than the intention.
 *
 * No credential passes through. This browser holds no Google key; pressing Sync
 * now sends this person's own session to a server function, and the function
 * does the rest.
 */

/**
 * When the job runs, as scheduled on the project.
 *
 * Ten minutes after the lead mirror, which is itself fifteen after Search
 * Console, so the four jobs do not contend for the same outbound connections.
 * The order matters as well as the spacing: the mirror writes the follow-up
 * state, and the calendar reads it.
 */
const SCHEDULE = '08:40 UTC daily';

function tone(status: IntegrationStatus) {
  if (status === 'connected') return 'violet';
  if (status === 'error') return 'crimson';
  if (status === 'syncing') return 'amber';
  return 'quiet';
}

export function CalendarPanel() {
  const { loadCalendar, triggerCalendarSync, mode } = useData();
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<CalendarSyncOutcome | null>(null);

  const load = useCallback(async () => {
    if (!loadCalendar) return;
    try {
      setStatus(await loadCalendar());
      setProblem(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  }, [loadCalendar]);

  useEffect(() => {
    // Reading stored connection state is exactly the external synchronisation an
    // effect is for, and the state writes happen after the await.
    // oxlint-disable-next-line react/set-state-in-effect
    void load();
  }, [load]);

  if (mode === 'local' || !loadCalendar || !triggerCalendarSync) {
    return (
      <Section title="Follow-up calendar" note="not available here">
        <Notice>
          You are running on this browser alone. Writing to a calendar needs a server to
          hold the Google credentials, so this starts working once the cockpit is on
          Supabase.
        </Notice>
      </Section>
    );
  }

  async function sync() {
    // Narrowed above, but the closure cannot see that, and asserting it here is
    // honest about why: the early return has already ruled null out.
    if (!triggerCalendarSync) return;
    setBusy(true);
    setProblem(null);
    try {
      setLastRun(await triggerCalendarSync());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await load();
    }
  }

  const connection = status?.connection ?? null;
  const state: IntegrationStatus = connection?.status ?? 'not_configured';
  const runs = status?.runs ?? [];
  const lastSuccess = runs.find((r) => r.status === 'succeeded') ?? null;
  const lastAttempt = runs[0] ?? null;

  return (
    <Section title="Follow-up calendar" note="Google Calendar">
      <p className="page-lede" style={{ marginTop: 0 }}>
        Every open follow-up goes onto a calendar of its own, as an all day entry, so the
        week can be read without opening this app. It only goes one way. Nothing on that
        calendar is ever read back and counted as business activity, because an
        appointment is not evidence that you spoke to anybody. Nothing is ever deleted
        from it either: the calendar may be shared, and removing something from somebody
        else's week is not this app's decision to make.
      </p>

      {problem ? <p className="notice notice-crimson">{problem}</p> : null}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>State</th>
              <th>Calendar</th>
              <th>Last successful</th>
              <th>Last attempted</th>
              <th>Next scheduled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="State">
                <Tag tone={tone(state)} title={STATUS_EXPLANATIONS[state]}>
                  {STATUS_LABELS[state]}
                </Tag>
              </td>
              <td data-label="Calendar">
                {/* Written by the server on connect, so this is the calendar it
                    really wrote to. A calendar id is configuration, not a secret. */}
                {connection?.provider_account_id ?? (
                  <span className="quiet">No calendar configured yet</span>
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
              <td data-label="Next scheduled">{SCHEDULE}</td>
              <td data-label="">
                <button className="btn" disabled={busy} onClick={() => void sync()}>
                  {busy ? 'Syncing…' : 'Sync now'}
                </button>
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

      {lastRun ? <CalendarRunResult outcome={lastRun} /> : null}

      <p className="notice">
        Only open follow-ups are written, and each one keeps the same calendar entry for
        the life of the follow-up, so moving a date moves the entry rather than adding a
        second. Running this twice changes nothing, which is why the button is safe to
        press as often as you like.
      </p>
    </Section>
  );
}

function CalendarRunResult({ outcome }: { outcome: CalendarSyncOutcome }) {
  if (outcome.status === 'not_configured') {
    return (
      <div className="notice notice-amber">
        <strong>No calendar is set up yet.</strong> {outcome.error}
      </div>
    );
  }

  if (!outcome.ok) {
    return (
      <p className="notice notice-crimson">
        The calendar was not updated: {outcome.error ?? outcome.status}. Nothing in this
        cockpit changed, and nothing here depends on the calendar being current.
      </p>
    );
  }

  const created = outcome.created ?? 0;
  const updated = outcome.updated ?? 0;
  const failed = outcome.failed ?? 0;

  return (
    <p className={failed > 0 ? 'notice notice-amber' : 'notice notice-violet'}>
      {created} added, {updated} brought up to date
      {failed > 0 ? `, ${failed} could not be written` : ''}, out of{' '}
      {outcome.tasks ?? 0} open {outcome.tasks === 1 ? 'follow-up' : 'follow-ups'}.
      {failed > 0 ? ` ${outcome.error ?? ''}` : ''}
    </p>
  );
}
