import { useEffect, useState, type ReactNode } from 'react';
import { alertsApi, api, type User } from './api';
import { linkHandler } from './router';
import { useLoad } from './useLoad';
import { Icon, type IconName } from './ui';

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  show: boolean;
  /** Paths that also highlight this item. */
  match?: (path: string) => boolean;
  count?: number;
}

/** The signed-in layout: navigation on the left, the page on the right. */
export function Shell({
  user,
  path,
  onSignOut,
  children,
}: {
  user: User;
  path: string;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const workspace = useLoad(() => api.workspace(), 'workspace');
  const firing = useFiringCount();
  // The mobile menu is open on the page where it was opened, so navigating closes it.
  const [navOpenAt, setNavOpenAt] = useState<string | null>(null);
  const navOpen = navOpenAt === path;

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    onSignOut();
  };

  const groups: { label: string; items: NavItem[] }[] = [
    {
      label: 'Monitor',
      items: [
        { href: '/', label: 'Home', icon: 'home', show: true, match: (p) => p === '/' },
        {
          href: '/services',
          label: 'Applications',
          icon: 'apps',
          show: true,
          match: (p) => p.startsWith('/services'),
        },
        { href: '/alerts', label: 'Alerts', icon: 'bell', show: true, count: firing },
        { href: '/slos', label: 'Reliability goals', icon: 'target', show: true },
        { href: '/advisor', label: 'Advisor', icon: 'spark', show: true },
      ],
    },
    {
      label: 'Set up',
      items: [
        {
          href: '/integrations',
          label: 'Integrations',
          icon: 'plug',
          show: true,
          match: (p) => p.startsWith('/integrations'),
        },
        { href: '/runtime', label: 'Observability stack', icon: 'layers', show: true },
        { href: '/settings', label: 'Settings', icon: 'settings', show: user.role !== 'viewer' },
        { href: '/users', label: 'People', icon: 'users', show: user.role === 'admin' },
        { href: '/audit', label: 'Audit log', icon: 'scroll', show: user.role === 'admin' },
      ],
    },
  ];

  const ws = workspace.state === 'ready' ? workspace.data.workspace : null;

  return (
    <div className="app" data-nav-open={navOpen}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="mobile-bar">
        <button
          type="button"
          className="ghost"
          aria-label={navOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={navOpen}
          aria-controls="sidebar"
          onClick={() => setNavOpenAt(navOpen ? null : path)}
        >
          <Icon name={navOpen ? 'close' : 'menu'} />
        </button>
        <Brand />
      </div>
      <aside className="sidebar" id="sidebar">
        <Brand />
        {ws && (
          <div className="workspace-chip" title="Your workspace: everything Raion monitors">
            <strong>{ws.name}</strong>
            <span className="muted">
              {ws.environment} · level {ws.level}
            </span>
          </div>
        )}
        <nav aria-label="Main" className="stack">
          {groups.map((g) => (
            <div className="nav-group" key={g.label}>
              <span className="nav-label">{g.label}</span>
              {g.items
                .filter((i) => i.show)
                .map((i) => {
                  const active = i.match ? i.match(path) : path.startsWith(i.href);
                  return (
                    <a
                      key={i.href}
                      className="nav-link"
                      href={i.href}
                      onClick={linkHandler(i.href)}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon name={i.icon} />
                      {i.label}
                      {i.count ? (
                        <span className="nav-count" aria-label={`${i.count} firing`}>
                          {i.count}
                        </span>
                      ) : null}
                    </a>
                  );
                })}
            </div>
          ))}
          <div className="nav-group">
            <span className="nav-label">Explore</span>
            <a className="nav-link" href="/grafana/" target="_blank" rel="noopener">
              <Icon name="chart" />
              Dashboards
              <span className="visually-hidden">(opens Grafana in a new tab)</span>
              <span style={{ marginLeft: 'auto' }}>
                <Icon name="external" size={14} />
              </span>
            </a>
          </div>
        </nav>
        <div className="sidebar-footer">
          <a
            className="user-chip"
            href="/account"
            onClick={linkHandler('/account')}
            aria-current={path === '/account' ? 'page' : undefined}
            title="Your account: password and API tokens"
          >
            <span className="avatar" aria-hidden="true">
              {user.username.slice(0, 2)}
            </span>
            <span>
              {user.username}
              <small>{user.role}</small>
            </span>
          </a>
          <button type="button" className="ghost" onClick={() => void signOut()}>
            <Icon name="logout" /> Sign out
          </button>
        </div>
      </aside>
      <main id="main" className="content">
        <div className="content-inner" key={path}>
          {children}
        </div>
      </main>
    </div>
  );
}

function Brand() {
  return (
    <a className="brand" href="/" onClick={linkHandler('/')}>
      <span className="brand-mark" aria-hidden="true">
        <Icon name="heart" size={17} />
      </span>
      Raion
    </a>
  );
}

/** Number of alerts firing now, refreshed every minute, for the navigation badge. */
function useFiringCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      alertsApi
        .overview()
        .then((a) => !cancelled && setCount(a.firing.length))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return count;
}
