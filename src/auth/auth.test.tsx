/**
 * Authentication behaviour.
 *
 * The one that matters: when Supabase is configured and nobody is signed in, the
 * app must not reach for protected data at all. Not fetch and discard, not fetch
 * and fail. Never issue the request.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AuthGate } from './AuthGate';
import { AuthContext, type AuthContextValue, type AuthPhase } from './context';

function withPhase(phase: AuthPhase, children: ReactNode, error: string | null = null) {
  const value: AuthContextValue = {
    phase,
    user: phase === 'signed_in' ? { id: 'u1', email: 'a@b.com' } : null,
    error,
    sendMagicLink: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    clearError: vi.fn(),
  };
  return render(<AuthContext.Provider value={value}>{children}</AuthContext.Provider>);
}

/** Stands in for the data layer, and records whether it was ever constructed. */
function ProtectedData({ onMount }: { onMount: () => void }) {
  onMount();
  return <div>protected data</div>;
}

describe('signed out never loads protected data', () => {
  it('does not mount the data layer when nobody is signed in', async () => {
    const loaded = vi.fn();
    withPhase(
      'signed_out',
      <AuthGate>
        <ProtectedData onMount={loaded} />
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText('Sign in')).toBeTruthy());
    expect(loaded).not.toHaveBeenCalled();
    expect(screen.queryByText('protected data')).toBeNull();
  });

  it('does not mount the data layer while the session is still being checked', () => {
    const loaded = vi.fn();
    withPhase(
      'checking',
      <AuthGate>
        <ProtectedData onMount={loaded} />
      </AuthGate>,
    );

    expect(loaded).not.toHaveBeenCalled();
    expect(screen.getByText(/Checking whether you are already signed in/)).toBeTruthy();
  });

  it('mounts the data layer once signed in', () => {
    const loaded = vi.fn();
    withPhase(
      'signed_in',
      <AuthGate>
        <ProtectedData onMount={loaded} />
      </AuthGate>,
    );

    expect(loaded).toHaveBeenCalled();
    expect(screen.getByText('protected data')).toBeTruthy();
  });
});

describe('local mode still works with no configuration', () => {
  it('goes straight through without asking anyone to sign in', () => {
    const loaded = vi.fn();
    withPhase(
      'local',
      <AuthGate>
        <ProtectedData onMount={loaded} />
      </AuthGate>,
    );

    expect(loaded).toHaveBeenCalled();
    expect(screen.getByText('protected data')).toBeTruthy();
    expect(screen.queryByText('Sign in')).toBeNull();
  });
});

describe('the signed out screen', () => {
  it('asks for an email and offers a magic link, with no password field', async () => {
    withPhase('signed_out', <AuthGate>{null}</AuthGate>);

    await waitFor(() => expect(screen.getByText('Sign in')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Send me a sign in link/ })).toBeTruthy();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.querySelector('input[type="email"]')).toBeTruthy();
  });

  it('shows an expired link clearly and still offers a fresh one', async () => {
    withPhase(
      'signed_out',
      <AuthGate>{null}</AuthGate>,
      'That sign in link has expired. They are only good for a short while, so ask for a fresh one below.',
    );

    await waitFor(() => expect(screen.getByText(/has expired/)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Send me a sign in link/ })).toBeTruthy();
  });

  it('says plainly that nothing loads before sign in', async () => {
    withPhase('signed_out', <AuthGate>{null}</AuthGate>);
    await waitFor(() =>
      expect(screen.getByText(/Nothing loads until you are signed in/)).toBeTruthy(),
    );
  });
});
