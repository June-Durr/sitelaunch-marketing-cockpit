/**
 * The one thing the Cockpit asks for before it can write on your behalf.
 *
 * Shown at the top of Today while there is no name on file, which is the
 * nearest thing this app has to onboarding: it is the screen you land on. It
 * disappears for good once answered, and can be put off for the session, since
 * nothing else in the Cockpit needs it.
 */

import { useState } from 'react';

import { ProfileForm } from './ProfileForm';
import { hasIdentity } from '../data/settings';
import { useIdentity } from '../data/useIdentity';

export function ProfilePrompt() {
  const identity = useIdentity();
  const [putOff, setPutOff] = useState(false);

  if (hasIdentity(identity) || putOff) return null;

  return (
    <section className="profile-prompt" aria-label="Tell the Cockpit who you are">
      <div className="profile-prompt-say">
        <h2 className="profile-prompt-title">Who should your messages say they are from?</h2>
        <p className="profile-prompt-lede">
          The assistant opens a first message by saying who is writing. It will not guess
          that, so until this is filled in it leaves the line out. One answer, once.
        </p>
      </div>

      <ProfileForm compact />

      <button className="btn btn-quiet profile-prompt-later" onClick={() => setPutOff(true)}>
        Not now
      </button>
    </section>
  );
}
