import { IntegrationCard } from '../components/DataGroups';
import { ProfileForm } from '../components/ProfileForm';
import { AccountsIcon } from '../components/icons';
import { readIdentity } from '../data/settings';

/**
 * The sender's own name, in the settings group with everything else editable.
 *
 * Small, and it matters out of proportion to its size: it is the only thing
 * standing between the assistant's first message and going out unsigned.
 */
export function ProfilePanel({ onSaved }: { onSaved?: () => void }) {
  const identity = readIdentity();
  const named = (identity.name ?? '').trim() !== '';

  return (
    <IntegrationCard
      Icon={AccountsIcon}
      title="How you introduce yourself"
      purpose="The name and business the assistant puts at the top of a first message."
      meta={
        named
          ? [{
              label: 'Signing as',
              value: identity.business ? `${identity.name}, ${identity.business}` : identity.name!,
            }]
          : []
      }
      details={
        <p>
          A first message to somebody you just met opens by saying who it is from. The
          assistant will not guess that: with nothing here it leaves the line out and says
          so, rather than sending a stranger a message signed with a name nobody chose.
          Nothing is read from your sign in address or from the app's own branding.
        </p>
      }
    >
      <ProfileForm onSaved={onSaved} />
    </IntegrationCard>
  );
}
