/**
 * The sender's identity, kept current while a screen is open.
 *
 * Settings live in localStorage, which tells a page about writes from other
 * tabs and never about its own. Without this hook the assistant panel would
 * sit there composing messages from the identity as it was when the panel
 * opened, which is exactly what happens when somebody fills their profile in
 * while the review card is still on screen waiting for it.
 */

import { useEffect, useState } from 'react';

import { readIdentity, subscribeToSettings, type Introduction } from './settings';

export function useIdentity(): Introduction {
  const [identity, setIdentity] = useState<Introduction>(readIdentity);

  useEffect(
    () => subscribeToSettings((settings) => setIdentity(settings.introduction)),
    [],
  );

  return identity;
}
