import { Notice, Section, Tag } from '../components/primitives';
import { useData } from '../data/context';
import {
  PROVIDER_LABELS, PROVIDER_NOTES, REMAINING_ORDER, STATUS_EXPLANATIONS,
  STATUS_LABELS, type IntegrationConnection, type IntegrationProvider,
  type IntegrationStatus,
} from '../types/integrations';

/**
 * The outside services that are still to come, and what each one is really doing.
 *
 * GA4 and Search Console are deliberately absent. They are connected and syncing,
 * and GoogleSyncPanel already reports their state from the sync tables, so listing
 * them again here only invited the two to disagree. This panel takes its statuses
 * from stored connection rows and never assumes one, which is why it is safe for
 * the caller to pass nothing: with no rows to read it says "not set up" rather
 * than inventing a state. It makes no request of its own, because the one read of
 * the sync tables belongs to the panel above.
 */
export function IntegrationsPanel({
  connections = [],
}: {
  connections?: IntegrationConnection[];
}) {
  const { mode } = useData();

  const statusOf = (provider: IntegrationProvider): IntegrationStatus =>
    connections.find((c) => c.provider === provider)?.status ?? 'not_configured';

  const tone = (status: IntegrationStatus) =>
    status === 'connected'
      ? 'violet'
      : status === 'error'
        ? 'crimson'
        : status === 'syncing'
          ? 'amber'
          : 'quiet';

  const connected = REMAINING_ORDER.filter((p) => statusOf(p) === 'connected');

  return (
    <Section
      title="Remaining integrations"
      note={
        connected.length === 0
          ? `none of these ${REMAINING_ORDER.length} yet`
          : `${connected.length} of ${REMAINING_ORDER.length} connected`
      }
    >
      <p className="page-lede" style={{ marginTop: 0 }}>
        Google Analytics and Search Console are not in this list on purpose.{' '}
        {mode === 'supabase'
          ? 'They are connected and syncing, and Automatic analytics above reports what they have actually done, so repeating them here would only give you two answers to the same question.'
          : 'Automatic analytics above is the one place they are reported, and in this browser-only mode it says plainly that there is nothing to report yet.'}{' '}
        What is left below is the services still to come.{' '}
        {connected.length === 0
          ? 'None of these is connected, and nothing in this app talks to them yet.'
          : 'Each row reports what that service is really doing.'}{' '}
        When one is connected, the fetching happens on a server that holds the credentials,
        and this browser only ever reads the results. That is why no password or token for
        any of these is stored on this machine.
      </p>

      {mode === 'local' ? (
        <Notice>
          You are running on this browser alone, so there is nothing for a service to
          connect to yet, Google included. Supabase comes first, then these.
        </Notice>
      ) : null}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Order</th>
              <th>Service</th>
              <th>What it would bring in</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {REMAINING_ORDER.map((provider, index) => {
              const status = statusOf(provider);
              return (
                <tr key={provider}>
                  <td data-label="Order">{index + 1}</td>
                  <td data-label="Service">{PROVIDER_LABELS[provider]}</td>
                  <td data-label="What it would bring in">{PROVIDER_NOTES[provider]}</td>
                  <td data-label="State">
                    <Tag tone={tone(status)} title={STATUS_EXPLANATIONS[status]}>
                      {STATUS_LABELS[status]}
                    </Tag>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="notice">
        The order is deliberate. Enquiry forms come first because an enquiry is the only
        thing in this app that counts as a real business result, and Google already covers
        the visits that lead to one. Social platforms come last, because their post level
        numbers are the least reliable and the furthest from revenue.
      </p>
    </Section>
  );
}
