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
    // No count on Website Outcomes. The manual traffic_snapshots total used to sit
    // here, which read as the whole of the website story when in fact the synced GA4
    // and Search Console rows live in their own tables. Showing the honest number
    // would mean a second analytics read in the shell, on every screen, so the badge
    // is gone instead of wrong.
    { to: '/website', label: 'Website Outcomes' },
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

        {/*
          The storage line and the sync line both follow the adapter, so this text
          cannot claim a sync that browser-only mode has no server to run. Nothing
          here reads the sync tables: that would put an analytics request behind
          every screen in the app just to word a caption.
        */}
        <div className="sidebar-foot">
          {mode === 'supabase' ? (
            <>
              Saved to Supabase.
              <br />
              Google Analytics and Search Console sync themselves daily. Instagram,
              Facebook, LinkedIn and TikTok numbers are still typed in by hand, because
              those are not connected yet.
            </>
          ) : (
            <>
              Saved in this browser only. Export a backup before clearing site data.
              <br />
              Nothing syncs in this mode, so everything here was typed in or imported.
            </>
          )}
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
