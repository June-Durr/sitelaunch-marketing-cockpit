/**
 * Who a message is from, asked once and editable afterwards.
 *
 * WHY THIS IS A COMPONENT AND NOT A FIELD ON A CARD
 *
 * It used to be two inputs sitting inside the assistant's message card, which
 * put a settings form in the middle of the one thing somebody came to read. It
 * belongs where the other settings are, and in a prompt at the top of Today
 * until it has been answered. This is that one form, rendered in both places,
 * so the two can never ask for different things.
 *
 * It stays empty until somebody fills it in. Nothing here guesses a name from
 * a signed in email address or from the application's own branding: a message
 * that goes out under a name nobody chose is worse than one that waits a minute.
 */

import { useState } from 'react';

import { Field } from './primitives';
import { readIdentity, writeIdentity } from '../data/settings';

export function ProfileForm({
  onSaved,
  compact = false,
}: {
  onSaved?: () => void;
  /** True in the onboarding band, where there is less room and no heading. */
  compact?: boolean;
}) {
  const saved = readIdentity();
  const [name, setName] = useState(saved.name ?? '');
  const [business, setBusiness] = useState(saved.business ?? '');
  const [done, setDone] = useState(false);

  const save = () => {
    writeIdentity({ name, business });
    setDone(true);
    onSaved?.();
  };

  const changed = name.trim() !== (saved.name ?? '') || business.trim() !== (saved.business ?? '');

  return (
    <div className={compact ? 'profile-form profile-form-compact' : 'profile-form'}>
      <div className="form-grid">
        <Field
          label="Your name"
          hint={compact ? undefined : 'The name you would give somebody you just met.'}
        >
          <input
            type="text"
            value={name}
            placeholder="Alberto"
            onChange={(event) => {
              setName(event.target.value);
              setDone(false);
            }}
          />
        </Field>
        <Field
          label="Your business"
          hint={compact ? undefined : 'Left blank, messages just say your name.'}
        >
          <input
            type="text"
            value={business}
            placeholder="SiteLaunch Studios"
            onChange={(event) => {
              setBusiness(event.target.value);
              setDone(false);
            }}
          />
        </Field>
      </div>

      <div className="btn-row">
        <button className="btn" disabled={name.trim() === '' || !changed} onClick={save}>
          Save
        </button>
        {done ? <span className="profile-form-done">Saved. Messages will say so.</span> : null}
      </div>
    </div>
  );
}
