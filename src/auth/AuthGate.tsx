import { useState, type ReactNode } from 'react';
import { useAuth } from './context';

/**
 * Decides whether the app is allowed to load anything.
 *
 * This is a structural guard, not a cosmetic one. When Supabase is configured and
 * nobody is signed in, the children never mount, so the data layer underneath is
 * never constructed and never issues a request. There is no protected fetch to
 * cancel, because there is no component alive to make one.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { phase } = useAuth();

  if (phase === 'local' || phase === 'signed_in') return <>{children}</>;
  if (phase === 'checking') return <AuthChecking />;
  return <SignIn />;
}

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          SiteLaunch
          <br />
          Marketing Cockpit
        </div>
        {children}
      </div>
    </div>
  );
}

function AuthChecking() {
  return (
    <AuthShell>
      <p className="auth-lede">Checking whether you are already signed in.</p>
    </AuthShell>
  );
}

function SignIn() {
  const { sendMagicLink, error, clearError } = useAuth();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setProblem('Put in the email address you use for this.');
      return;
    }
    setState('sending');
    setProblem(null);
    clearError();
    try {
      await sendMagicLink(email.trim());
      setState('sent');
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setState('idle');
    }
  }

  if (state === 'sent') {
    return (
      <AuthShell>
        <h1 className="auth-title">Check your email</h1>
        <p className="auth-lede">
          A sign in link is on its way to <strong>{email.trim()}</strong>. Open it on this
          device and you will land straight back here.
        </p>
        <p className="auth-note">
          The link only works once and it expires after a little while. If it has gone
          stale by the time you get to it, come back and ask for another.
        </p>
        <button
          className="btn"
          onClick={() => {
            setState('idle');
            setEmail('');
          }}
        >
          Use a different address
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="auth-title">Sign in</h1>
      <p className="auth-lede">
        This cockpit holds your own data, so it is behind a sign in. Put in your email and
        you will get a link. There is no password to remember.
      </p>

      {error ? <p className="notice notice-crimson">{error}</p> : null}
      {problem ? <p className="notice notice-crimson">{problem}</p> : null}

      <form onSubmit={submit}>
        <label className="field">
          <span className="field-label">Email address</span>
          <input
            type="email"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@sitelaunchstudios.com"
          />
        </label>
        <div className="btn-row" style={{ marginTop: '1.1rem' }}>
          <button className="btn btn-primary" type="submit" disabled={state === 'sending'}>
            {state === 'sending' ? 'Sending the link…' : 'Send me a sign in link'}
          </button>
        </div>
      </form>

      <p className="auth-note">
        Nothing loads until you are signed in. The app does not read your data first and
        check afterwards.
      </p>
    </AuthShell>
  );
}
