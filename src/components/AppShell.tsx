import { NavLink, Outlet } from 'react-router-dom';
import { useData } from '../data/context';
import { useAuth } from '../auth/context';
import { today } from '../lib/dates';

export function AppShell() {
  const { data, mode, loading, error } = useData();
  const { phase, user, signOut } = useAuth();

  const now = today();
  const dueTasks = data.tasks.filter((t) => t.status === 'open' && t.due_date <= now).length;
  const dueLeads = data.leads.filter(
    (l) => !['won', 'lost'].includes(l.stage) && l.next_action_date && l.next_action_date <= now,
  ).length;
  const liveRecs = data.recommendations.filter((r) => !r.dismissed_at).length;

  const links: { to: string; label: string; count?: number }[] = [
    { to: '/', label: 'Today', count: dueTasks + dueLeads || undefined },
    { to: '/content', label: 'Content Log', count: data.contentItems.length || undefined },
    { to: '/website', label: 'Website Outcomes', count: data.traffic.length || undefined },
    { to: '/pipeline', label: 'Pipeline', count: dueLeads || undefined },
    { to: '/tasks', label: 'Tasks', count: dueTasks || undefined },
    { to: '/activity', label: 'Activity', count: data.activityEvents.length || undefined },
    { to: '/recommendations', label: 'Recommendations', count: liveRecs || undefined },
    { to: '/data', label: 'Data & Import' },
  ];

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <nav className="sidebar" aria-label="Sections">
        <NavLink to="/" className="brand">
          <span className="brand-mark">
            SiteLaunch
            <br />
            Marketing Cockpit
          </span>
          <span className="brand-sub">Internal · v1</span>
        </NavLink>

        <div className="nav">
          {links.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.to === '/'} className="nav-link">
              <span>{link.label}</span>
              {link.count ? <span className="nav-count">{link.count}</span> : null}
            </NavLink>
          ))}
        </div>

        {phase === 'signed_in' ? (
          <div className="sidebar-account">
            <span className="sidebar-account-email">{user?.email ?? 'Signed in'}</span>
            <button className="btn btn-quiet" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        ) : null}

        <div className="sidebar-foot">
          {mode === 'supabase'
            ? 'Saved to Supabase.'
            : 'Saved in this browser only. Export a backup before clearing site data.'}
          <br />
          Nothing is wired up to Instagram, Facebook or Google Analytics. Everything here
          was typed in or imported.
        </div>
      </nav>

      <main className="main" id="main">
        <div className="main-inner">
          {error ? (
            <p className="notice notice-crimson">Could not load data: {error}</p>
          ) : null}
          {loading && data.contentItems.length === 0 ? (
            <p className="page-kicker">Loading…</p>
          ) : (
            <Outlet />
          )}
        </div>
      </main>
    </div>
  );
}
