import { Notice, Section, Tag } from '../components/primitives';
import { useData } from '../data/context';
import {
  PROVIDER_LABELS, PROVIDER_NOTES, RECOMMENDED_ORDER, STATUS_EXPLANATIONS,
  STATUS_LABELS, type IntegrationConnection, type IntegrationProvider,
  type IntegrationStatus,
} from '../types/integrations';

/**
 * What each outside service is doing, honestly.
 *
 * Nothing is connected. Rather than showing a hopeful "coming soon", each provider
 * reports its real state, which today is "not set up" for every one of them. A
 * status is only ever read from a stored connection row, never assumed, so this
 * screen cannot claim a service is connected when it is not.
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

  return (
    <Section title="Outside services" note="none connected">
      <p className="page-lede" style={{ marginTop: 0 }}>
        None of these are connected, and nothing in this app talks to them. When they are
        connected, the fetching happens on a server that holds the credentials, and this
        browser only ever reads the results. That is why no password or token for any of
        these is stored on this machine.
      </p>

      {mode === 'local' ? (
        <Notice>
          You are running on this browser alone, so there is nothing for a service to
          connect to yet. Supabase comes first, then these.
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
            {RECOMMENDED_ORDER.map((provider, index) => {
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
        The order is deliberate. Website numbers come first because they are the ones tied
        to enquiries, and an enquiry is the only thing in this app that counts as a real
        business result. Social platforms come last, because their post level numbers are
        the least reliable and the furthest from revenue.
      </p>
    </Section>
  );
}
