import { Notice, Tag } from '../components/primitives';
import { Details, IntegrationCard } from '../components/DataGroups';
import { WebsiteFormsIcon } from '../components/icons';
import { PROVIDER_ICONS } from '../components/providerIcons';
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
 *
 * WHY THESE ARE CARDS AND NOT A TABLE
 *
 * The table gave five services one shape and one weight, so picking Instagram
 * out of it meant reading the second column five times. Each now carries its own
 * mark, which is the whole point of a list you scan rather than read.
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
    <>
      {mode === 'local' ? (
        <Notice>
          You are running on this browser alone, so there is nothing for a service to
          connect to yet, Google included. Supabase comes first, then these.
        </Notice>
      ) : null}

      {REMAINING_ORDER.map((provider, index) => {
        const status = statusOf(provider);
        const connection = connections.find((c) => c.provider === provider) ?? null;
        const Icon = PROVIDER_ICONS[provider] ?? WebsiteFormsIcon;

        return (
          <IntegrationCard
            key={provider}
            Icon={Icon}
            title={PROVIDER_LABELS[provider]}
            purpose={PROVIDER_NOTES[provider]}
            chip={
              <Tag tone={tone(status)} title={STATUS_EXPLANATIONS[status]}>
                {STATUS_LABELS[status]}
              </Tag>
            }
            meta={[
              { label: 'Order', value: `${index + 1} of ${REMAINING_ORDER.length}` },
              {
                label: 'Account',
                value: connection?.provider_account_id ?? (
                  <span className="quiet">Not connected yet</span>
                ),
              },
            ]}
            error={
              status === 'error' && connection?.error_message
                ? connection.error_message
                : null
            }
          />
        );
      })}

      <Details summary="Why these are in this order">
        <p>
          Enquiry forms come first because an enquiry is the only thing in this app that
          counts as a real business result, and Google already covers the visits that lead
          to one. Social platforms come last, because their post level numbers are the
          least reliable and the furthest from revenue.
        </p>
        <p>
          Google Analytics, Search Console, the Sheet mirror and the follow-up calendar
          are not in this list on purpose.{' '}
          {mode === 'supabase'
            ? 'Each has its own card above reporting what it has actually done, so repeating them here would only give you two answers to the same question, and the two would eventually disagree.'
            : 'Each has its own card above, and in this browser-only mode they say plainly that there is nothing to report yet.'}
        </p>
        <p>
          When one of these is connected, the fetching happens on a server that holds the
          credentials, and this browser only ever reads the results. That is why no
          password or token for any of them is stored on this machine.
        </p>
      </Details>
    </>
  );
}
