import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useData } from '../data/context';
import { Notice, Section, Tag } from '../components/primitives';
import { formatDateTime } from '../lib/dates';
import type {
  CalendarDisconnectOutcome, CalendarStatus, CalendarSyncOutcome,
} from '../data/repository';
import { STATUS_EXPLANATIONS, STATUS_LABELS, type IntegrationStatus } from '../types/integrations';

/**
 * Connecting a Google account, and the follow-up events that then appear on it.
 *
 * WHAT THIS SCREEN ASKS OF SOMEBODY
 *
 * One button, once. They sign in to Google, they approve one permission, and they
 * come back. There is no calendar to create, no calendar id to copy, no file to
 * download and nothing to share with a service account. If this screen ever asks
 * for any of those again, something has gone backwards.
 *
 * WHAT IT SHOWS, AND WHY IT IS READ BACK
 *
 * Everything here comes from the database rather than from an assumption. The
 * account and the destination are what the server recorded when it last
 * succeeded, so if the screen and the intention ever disagree, the screen shows
 * the truth.
 *
 * NO CREDENTIAL PASSES THROUGH
 *
 * This browser never holds a Google token. Connecting sends this person's own
 * session to a server function, which records a one-use state and hands back a
 * URL. The code exchange, the refresh token and the client secret all stay server
 * side, and the only thing that comes back here is a connection row with no token
 * column in it.
 */

/**
 * The exact promise this screen makes, kept in one place.
 *
 * Worth a constant rather than inline copy: it is the sentence somebody reads
 * before granting access to their real diary, and it should be impossible to
 * reword by accident while editing the layout around it.
 */
export const CALENDAR_PROMISE =
  'Follow-ups created by the Cockpit will appear on your primary Google Calendar. '
  + 'The Cockpit will not alter unrelated calendar events.';

/**
 * When the job runs, once it is scheduled.
 *
 * Ten minutes after the lead mirror, which is itself fifteen after Search
 * Console, so the jobs do not contend for the same outbound connections. The
 * order matters as well as the spacing: the mirror writes the follow-up state,
 * and the calendar reads it.
 */
const SCHEDULE = '08:40 UTC daily';

function tone(status: IntegrationStatus) {
  if (status === 'connected') return 'violet';
  if (status === 'error') return 'crimson';
  if (status === 'syncing') return 'amber';
  return 'quiet';
}

export function CalendarPanel() {
  const {
    loadCalendar, triggerCalendarSync, startCalendarOAuth, disconnectCalendar, mode,
  } = useData();
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [lastRun, setLastRun] = useState<CalendarSyncOutcome | null>(null);
  const [farewell, setFarewell] = useState<CalendarDisconnectOutcome | null>(null);

  /**
   * How the callback tells this screen how it went.
   *
   * One word from a fixed set, put there by the server function after it
   * redirected the browser back. It is read into state and then removed from the
   * address, which is what keeps the notice on screen while making sure a reload
   * does not announce a connection that happened minutes ago.
   */
  const [params, setParams] = useSearchParams();
  const [returned, setReturned] = useState<string | null>(null);

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

  useEffect(() => {
    const outcome = params.get('calendar');
    if (!outcome) return;
    // oxlint-disable-next-line react/set-state-in-effect
    setReturned(outcome);
    const next = new URLSearchParams(params);
    next.delete('calendar');
    setParams(next, { replace: true });
  }, [params, setParams]);

  if (mode === 'local' || !loadCalendar || !triggerCalendarSync) {
    return (
      <Section title="Follow-up calendar" note="not available here">
        <Notice>
          You are running on this browser alone. Connecting a Google account needs a
          server to hold the authorization, so this starts working once the cockpit is
          on Supabase.
        </Notice>
      </Section>
    );
  }

  async function connect() {
    if (!startCalendarOAuth) return;
    setBusy('connect');
    setProblem(null);
    try {
      const start = await startCalendarOAuth();
      if (start.authorizeUrl) {
        // Leaving the app on purpose. Google's consent screen has to be Google's,
        // and showing it in a frame of ours would be the shape of a phishing page.
        window.location.assign(start.authorizeUrl);
        return;
      }
      setProblem(
        start.error
          ?? 'Could not start the connection. Nothing has changed, so you can try again.',
      );
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    // Narrowed above, but the closure cannot see that, and asserting it here is
    // honest about why: the early return has already ruled null out.
    if (!triggerCalendarSync) return;
    setBusy('sync');
    setProblem(null);
    setFarewell(null);
    try {
      setLastRun(await triggerCalendarSync());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function disconnect() {
    if (!disconnectCalendar) return;
    setBusy('disconnect');
    setProblem(null);
    setLastRun(null);
    try {
      setFarewell(await disconnectCalendar());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      await load();
    }
  }

  const connection = status?.connection ?? null;
  const state: IntegrationStatus = connection?.status ?? 'not_configured';
  const connected = state === 'connected' || state === 'error';
  const runs = status?.runs ?? [];
  const lastSuccess = runs.find((r) => r.status === 'succeeded') ?? null;
  const lastAttempt = runs[0] ?? null;

  return (
    <Section title="Follow-up calendar" note="Google Calendar">
      <p className="page-lede" style={{ marginTop: 0 }}>
        Connect your Google account once and every open follow-up turns into an all day
        entry, so your week can be read without opening this app. {CALENDAR_PROMISE} It
        only goes one way: nothing on your calendar is ever read back and counted as
        business activity, because an appointment is not evidence that you spoke to
        anybody. Nothing is ever removed either, because you may have planned your day
        around it.
      </p>

      {returned ? <ReturnNotice outcome={returned} /> : null}
      {problem ? <p className="notice notice-crimson">{problem}</p> : null}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>State</th>
              <th>Google account</th>
              <th>Where events go</th>
              <th>Last successful</th>
              <th>Last attempted</th>
              <th>Next scheduled</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="State">
                <Tag tone={tone(state)} title={STATUS_EXPLANATIONS[state]}>
                  {STATUS_LABELS[state]}
                </Tag>
              </td>
              <td data-label="Google account">
                {/* Learned from an event Google accepted, not from an identity
                    scope the Cockpit has no other use for, so it stays blank
                    until the first event lands. */}
                {connection?.display_name ?? (
                  <span className="quiet">
                    {connected ? 'Shown after the first event' : 'Not connected'}
                  </span>
                )}
              </td>
              <td data-label="Where events go">
                {connected ? (
                  'Primary Google Calendar'
                ) : (
                  <span className="quiet">Nowhere yet</span>
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
              <td data-label="Next scheduled">
                {connected ? SCHEDULE : <span className="quiet">Not scheduled</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="btn-row" style={{ marginTop: '1rem' }}>
        {connected ? (
          <>
            <button className="btn" disabled={busy !== null} onClick={() => void sync()}>
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              className="btn btn-quiet"
              disabled={busy !== null}
              onClick={() => void disconnect()}
            >
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        ) : (
          <button
            className="btn btn-primary"
            disabled={busy !== null || !startCalendarOAuth}
            onClick={() => void connect()}
          >
            {busy === 'connect' ? 'Opening Google…' : 'Connect Google Calendar'}
          </button>
        )}
      </div>

      {connection?.status === 'error' && connection.error_message ? (
        <p className="notice notice-crimson">
          The last attempt failed at {formatDateTime(connection.error_at)}:{' '}
          {connection.error_message}
        </p>
      ) : null}

      {lastRun ? <CalendarRunResult outcome={lastRun} /> : null}
      {farewell ? <DisconnectResult outcome={farewell} /> : null}

      {connected ? (
        <p className="notice">
          Only open follow-ups are written, and each one keeps the same entry for the
          life of the follow-up, so moving a date moves the entry rather than adding a
          second. Running this twice changes nothing, which is why the button is safe to
          press as often as you like.
        </p>
      ) : (
        <p className="notice">
          Pressing Connect sends you to Google to sign in and approve one permission:
          managing events on calendars you own. You will not be asked to create a
          calendar, to copy an id, or to share anything with anybody. You can disconnect
          here at any time.
        </p>
      )}
    </Section>
  );
}

/** What the OAuth callback said, once the browser landed back here. */
function ReturnNotice({ outcome }: { outcome: string }) {
  if (outcome === 'connected') {
    return (
      <p className="notice notice-violet">
        Google Calendar is connected. Press Sync now to put your open follow-ups on it,
        or leave it to the daily sync.
      </p>
    );
  }
  if (outcome === 'refused') {
    return (
      <p className="notice notice-amber">
        The connection was cancelled at Google, so nothing changed. You can try again
        whenever you like.
      </p>
    );
  }
  return (
    <p className="notice notice-crimson">
      The connection did not complete, so nothing changed. Press Connect Google Calendar
      to start again.
    </p>
  );
}

function CalendarRunResult({ outcome }: { outcome: CalendarSyncOutcome }) {
  if (outcome.status === 'not_connected') {
    return (
      <div className="notice notice-amber">
        <strong>No Google account is connected yet.</strong>{' '}
        {outcome.error ?? 'Press Connect Google Calendar to start.'}
      </div>
    );
  }

  if (outcome.status === 'not_configured') {
    return (
      <div className="notice notice-amber">
        <strong>Google Calendar is not set up on this deployment yet.</strong>{' '}
        {outcome.error}
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
      {outcome.tasks ?? 0}{' '}
      {outcome.stoppedEarly ? 'attempted' : 'open'}{' '}
      {outcome.tasks === 1 ? 'follow-up' : 'follow-ups'}.
      {/* A run that gave up early must not read as a run that covered
          everything, which is what "out of 3 open follow-ups" would say when
          nineteen are open. */}
      {outcome.stoppedEarly === 'repeated_failure'
        ? ' Google refused the same way several times, so the rest were not'
          + ' attempted. Fixing the reason below and syncing again will pick them up.'
        : ''}
      {failed > 0 ? ` ${outcome.error ?? ''}` : ''}
    </p>
  );
}

/**
 * What disconnecting actually did, said without overclaiming.
 *
 * Two separate facts, because they can differ: the Cockpit has forgotten the
 * authorization either way, and Google may or may not have been told as well.
 * Rolling them into one reassuring sentence would leave somebody believing the
 * app had been removed from their Google account when it had not.
 */
function DisconnectResult({ outcome }: { outcome: CalendarDisconnectOutcome }) {
  if (!outcome.ok) {
    return (
      <p className="notice notice-crimson">
        Disconnecting did not finish: {outcome.error ?? outcome.status}. The connection
        may still be in place, so check the state above before trying again.
      </p>
    );
  }

  return (
    <p className="notice notice-violet">
      Disconnected. The Cockpit has forgotten the authorization and will not write to
      your calendar again.{' '}
      {outcome.revokedAtGoogle
        ? 'Google was told to cancel it as well.'
        : 'Google could not be reached to cancel it, so you may also want to remove '
          + 'SiteLaunch Cockpit from your Google account permissions.'}{' '}
      Follow-ups already on your calendar were left exactly where they are.
    </p>
  );
}
