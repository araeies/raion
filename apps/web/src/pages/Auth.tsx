import { useState } from 'react';
import { api, type User } from '../api';
import { ErrorMessage, Field, useSubmit } from '../components';
import { useLoad } from '../useLoad';

const SSO_ERRORS: Record<string, string> = {
  provider_unavailable:
    'Raion could not reach the identity provider. Try again, or ask your Raion admin.',
  invalid_state: 'The sign-in took too long or was started elsewhere. Please try again.',
  provider_rejected: 'The identity provider did not complete the sign-in. Please try again.',
  no_role:
    'You signed in, but you are not in a group that has access to Raion. Ask your Raion admin for access.',
  no_username: 'Your identity provider did not send a usable username. Ask your Raion admin.',
  username_taken:
    'A Raion account with your username already exists. Ask your Raion admin to sort this out.',
  disabled: 'Your Raion account is disabled. Ask your Raion admin.',
};

/** Where to go after signing in: the page the person asked for, if it is on this site. */
function nextPath(): string {
  const params = new URLSearchParams(window.location.search);
  const next = params.get('next');
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')) return next;
  const here = window.location.pathname;
  return here === '/login' || here === '/setup' ? '/services' : here;
}

export function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const methods = useLoad(() => api.signInMethods(), 'sign-in-methods');
  const ssoError = new URLSearchParams(window.location.search).get('sso_error');
  const { pending, error, onSubmit } = useSubmit(async () => {
    const { user } = await api.login(username, password);
    onLogin(user);
  });
  const sso = methods.state === 'ready' ? methods.data.sso : null;
  // If the methods cannot be read, offer the password form rather than nothing.
  const passwordForm = methods.state !== 'ready' || methods.data.password;
  return (
    <main id="main" className="auth">
      <h1>Sign in to Raion</h1>
      {ssoError && (
        <p className="notice notice-error" role="alert">
          {SSO_ERRORS[ssoError] ?? 'Single sign-on did not work. Please try again.'}
        </p>
      )}
      {sso && (
        <p>
          <a
            className="button"
            href={`/api/v1/auth/oidc/start?next=${encodeURIComponent(nextPath())}`}
          >
            Sign in with {sso.displayName}
          </a>
        </p>
      )}
      {sso && passwordForm && <p className="muted">Or sign in with a Raion password:</p>}
      {passwordForm && (
        <form onSubmit={onSubmit} noValidate={false}>
          <Field
            id="username"
            label="Username"
            autoComplete="username"
            value={username}
            onChange={setUsername}
          />
          <Field
            id="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
          />
          <ErrorMessage error={error} />
          <button type="submit" disabled={pending}>
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
      <p className="muted">
        {sso
          ? `Your account is created the first time you sign in with ${sso.displayName}.`
          : 'Accounts are created by a Raion admin.'}
      </p>
    </main>
  );
}

/** Reads the one-time setup token from the URL fragment, then removes it from the address bar. */
export function readSetupToken(): string {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  if (token) window.history.replaceState(null, '', window.location.pathname);
  return token;
}

export function SetupPage({
  onDone,
  initialToken,
}: {
  onDone: (user: User) => void;
  initialToken: string;
}) {
  const [token, setToken] = useState(initialToken);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { pending, error, onSubmit } = useSubmit(async () => {
    if (password !== confirm) throw new Error('The passwords do not match.');
    const { user } = await api.setup(token, username, password);
    onDone(user);
  });
  return (
    <main id="main" className="auth">
      <h1>Welcome to Raion</h1>
      <p>
        Create the first administrator account. Admins can invite other people and choose what they
        are allowed to do.
      </p>
      <form onSubmit={onSubmit}>
        {!initialToken && (
          <Field
            id="token"
            label="Setup token"
            value={token}
            onChange={setToken}
            hint="Printed by “raion server” when it started. Use the full link it printed, or paste the token here."
          />
        )}
        <Field
          id="username"
          label="Admin username"
          autoComplete="username"
          value={username}
          onChange={setUsername}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          hint="At least 12 characters. A short sentence works well."
        />
        <Field
          id="confirm"
          label="Repeat password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
        />
        <ErrorMessage error={error} />
        <button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create admin account'}
        </button>
      </form>
    </main>
  );
}
