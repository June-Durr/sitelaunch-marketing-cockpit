import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuthContext, type AuthContextValue, type AuthPhase, type AuthUser } from './context';
import { getSupabase, supabaseConfigured } from '../data/supabaseClient';

/**
 * Supabase session handling.
 *
 * When Supabase is not configured this does nothing at all and the app stays in
 * local mode, which is the setup Alberto is actually using. When it is configured,
 * the phase starts at 'checking' and never at 'signed_in', so no screen can render
 * against a session that has not been confirmed yet.
 *
 * The only credential this file touches is the anon key, which is designed to be
 * public. It grants nothing on its own; row level security decides what the signed
 * in user can see. Service role keys and provider secrets never come near the
 * browser. See server/README.md.
 */

/** Supabase reports a dead or already used link in the URL fragment. */
function errorFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return null;

  const params = new URLSearchParams(hash);
  const code = params.get('error_code');
  const description = params.get('error_description');
  if (!code && !description) return null;

  // Clear it, so a refresh does not keep showing an error about an old link.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);

  if (code === 'otp_expired' || description?.toLowerCase().includes('expired')) {
    return 'That sign in link has expired. They are only good for a short while, so ask for a fresh one below.';
  }
  return description?.replace(/\+/g, ' ') ?? 'That sign in link did not work. Ask for a fresh one below.';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>(
    supabaseConfigured ? 'checking' : 'local',
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabaseConfigured) return;

    // Reading the URL fragment is exactly the external-system synchronisation an
    // effect is for, and it has to happen after mount because it also clears the
    // fragment from the address bar.
    const linkError = errorFromUrl();
    // oxlint-disable-next-line react/set-state-in-effect
    if (linkError) setError(linkError);

    const supabase = getSupabase();
    let cancelled = false;

    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (cancelled) return;
      if (sessionError) setError(sessionError.message);
      const session = data.session;
      setUser(
        session ? { id: session.user.id, email: session.user.email ?? null } : null,
      );
      setPhase(session ? 'signed_in' : 'signed_out');
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setUser(
        session ? { id: session.user.id, email: session.user.email ?? null } : null,
      );
      setPhase(session ? 'signed_in' : 'signed_out');
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  const sendMagicLink = useCallback(async (email: string) => {
    const supabase = getSupabase();
    const { error: sendError } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo:
          typeof window === 'undefined' ? undefined : window.location.origin,
      },
    });
    if (sendError) throw new Error(sendError.message);
  }, []);

  const signOut = useCallback(async () => {
    if (!supabaseConfigured) return;
    const supabase = getSupabase();
    await supabase.auth.signOut();
    setUser(null);
    setPhase('signed_out');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      phase,
      user,
      error,
      sendMagicLink,
      signOut,
      clearError: () => setError(null),
    }),
    [error, phase, sendMagicLink, signOut, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
