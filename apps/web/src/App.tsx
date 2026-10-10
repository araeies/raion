import { useEffect, useState } from 'react';
import { api, type User } from './api';
import { LoginPage, SetupPage, readSetupToken } from './pages/Auth';
import { AccountPage } from './pages/Account';
import { AddApplicationPage } from './pages/AddApplication';
import { AdvisorPage } from './pages/Advisor';
import { AlertsPage } from './pages/Alerts';
import { AuditPage } from './pages/Audit';
import { MyTokens } from './pages/Tokens';
import { IntegrationDetailPage, IntegrationsPage } from './pages/Integrations';
import { RuntimePage } from './pages/Runtime';
import { SettingsPage } from './pages/Settings';
import { SlosPage } from './pages/Slos';
import { ServiceDetailPage, ServicesPage } from './pages/Services';
import { UsersPage } from './pages/Users';
import { navigate, usePath } from './router';
import { Shell } from './Shell';
import { HomePage, NotFound } from './pages/Home';
import { Loading } from './ui';

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
    if (path === '/login' || path === '/setup') navigate('/');
  };

  switch (session.state) {
    case 'loading':
      return (
        <div className="auth-page">
          <Loading label="Starting Raion…" />
        </div>
      );
    case 'setup':
      return <SetupPage initialToken={session.token} onDone={signedIn} />;
    case 'anonymous':
      return <LoginPage onLogin={signedIn} />;
    case 'signed-in':
      return (
        <Pages
          user={session.user}
          path={path}
          onSignOut={() => setSession({ state: 'anonymous' })}
        />
      );
  }
}

function Pages({ user, path, onSignOut }: { user: User; path: string; onSignOut: () => void }) {
  const serviceMatch = /^\/services\/([a-z0-9-]+)$/.exec(path);
  const integrationMatch = /^\/integrations\/([a-z0-9-]+)$/.exec(path);

  let page;
  if (path === '/services/new') page = <AddApplicationPage user={user} />;
  else if (serviceMatch) page = <ServiceDetailPage name={serviceMatch[1]!} user={user} />;
  else if (integrationMatch) page = <IntegrationDetailPage name={integrationMatch[1]!} />;
  else if (path === '/services') page = <ServicesPage user={user} />;
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
  else if (path === '/settings' && user.role !== 'viewer') page = <SettingsPage user={user} />;
  else if (path === '/') page = <HomePage user={user} />;
  else page = <NotFound path={path} />;

  return (
    <Shell user={user} path={path} onSignOut={onSignOut}>
      {page}
    </Shell>
  );
}
