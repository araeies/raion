import { useEffect, useState } from 'react';
import { api, type User } from './api';
import { LoginPage, SetupPage, readSetupToken } from './pages/Auth';
import { AccountPage } from './pages/Account';
import { AdvisorPage } from './pages/Advisor';
import { AlertsPage } from './pages/Alerts';
import { AuditPage } from './pages/Audit';
import { MyTokens } from './pages/Tokens';
import { IntegrationDetailPage, IntegrationsPage } from './pages/Integrations';
import { RuntimePage } from './pages/Runtime';
import { SlosPage } from './pages/Slos';
import { ServiceDetailPage, ServicesPage } from './pages/Services';
import { UsersPage } from './pages/Users';
import { linkHandler, navigate, usePath } from './router';
import { useLoad } from './useLoad';

type Session =
  | { state: 'loading' }
  | { state: 'setup'; token: string }
  | { state: 'anonymous' }
  | { state: 'signed-in'; user: User };

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const path = usePath();

  useEffect(() => {
    void (async () => {
      try {
        const { needed } = await api.setupStatus();
        if (needed) {
          setSession({ state: 'setup', token: readSetupToken() });
          return;
        }
        const { user } = await api.me();
        setSession({ state: 'signed-in', user });
      } catch {
        // Not signed in (401) or session expired: show the sign-in page.
        setSession({ state: 'anonymous' });
      }
    })();
  }, []);

  const signedIn = (user: User) => {
    // Return to where the user was going (e.g. Grafana), but only to a path on this site.
    const next = new URLSearchParams(window.location.search).get('next');
    if (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')) {
      window.location.assign(next);
      return;
    }
    setSession({ state: 'signed-in', user });
    if (path === '/login' || path === '/setup') navigate('/services');
  };

  switch (session.state) {
    case 'loading':
      return <p aria-busy="true">Loading…</p>;
    case 'setup':
      return <SetupPage initialToken={session.token} onDone={signedIn} />;
    case 'anonymous':
      return <LoginPage onLogin={signedIn} />;
    case 'signed-in':
      return (
        <Shell
          user={session.user}
          path={path}
          onSignOut={() => setSession({ state: 'anonymous' })}
        />
      );
  }
}

function Shell({ user, path, onSignOut }: { user: User; path: string; onSignOut: () => void }) {
  const workspace = useLoad(() => api.workspace(), 'workspace');
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    onSignOut();
  };
  const serviceMatch = /^\/services\/([a-z0-9-]+)$/.exec(path);
  const integrationMatch = /^\/integrations\/([a-z0-9-]+)$/.exec(path);

  let page;
  if (serviceMatch) page = <ServiceDetailPage name={serviceMatch[1]!} user={user} />;
  else if (integrationMatch) page = <IntegrationDetailPage name={integrationMatch[1]!} />;
  else if (path === '/integrations') page = <IntegrationsPage />;
  else if (path === '/users' && user.role === 'admin') page = <UsersPage currentUser={user} />;
  else if (path === '/runtime') page = <RuntimePage user={user} />;
  else if (path === '/alerts') page = <AlertsPage user={user} />;
  else if (path === '/slos') page = <SlosPage user={user} />;
  else if (path === '/advisor') page = <AdvisorPage user={user} />;
  else if (path === '/account')
    page = (
      <AccountPage user={user}>
        <MyTokens user={user} />
      </AccountPage>
    );
  else if (path === '/audit' && user.role === 'admin') page = <AuditPage />;
  else page = <ServicesPage />;

  const nav = [
    { href: '/services', label: 'Services', show: true },
    { href: '/slos', label: 'SLOs', show: true },
    { href: '/alerts', label: 'Alerts', show: true },
    { href: '/advisor', label: 'Advisor', show: true },
    { href: '/integrations', label: 'Integrations', show: true },
    { href: '/runtime', label: 'Observability stack', show: true },
    { href: '/users', label: 'Users', show: user.role === 'admin' },
    { href: '/audit', label: 'Audit log', show: user.role === 'admin' },
  ];

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href="/services" onClick={linkHandler('/services')}>
          Raion
        </a>
        {workspace.state === 'ready' && workspace.data.workspace && (
          <span className="workspace">
            {workspace.data.workspace.name} · {workspace.data.workspace.environment} · level{' '}
            {workspace.data.workspace.level}
          </span>
        )}
        <nav aria-label="Main">
          <ul>
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <li key={n.href}>
                  <a
                    href={n.href}
                    onClick={linkHandler(n.href)}
                    aria-current={
                      path.startsWith(n.href) || (n.href === '/services' && path === '/')
                        ? 'page'
                        : undefined
                    }
                  >
                    {n.label}
                  </a>
                </li>
              ))}
          </ul>
        </nav>
        <a className="external" href="/grafana/" target="_blank" rel="noopener">
          Grafana ↗
        </a>
        <a
          className="user"
          href="/account"
          onClick={linkHandler('/account')}
          aria-current={path === '/account' ? 'page' : undefined}
          title="Your account: password and API tokens"
        >
          {user.username} <span className="badge">{user.role}</span>
        </a>
        <button type="button" className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <main id="main">{page}</main>
    </>
  );
}
