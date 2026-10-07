import { useState } from 'react';
import { api, type User } from '../api';
import { ErrorMessage, Field, useSubmit } from '../components';

export function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { pending, error, onSubmit } = useSubmit(async () => {
    const { user } = await api.login(username, password);
    onLogin(user);
  });
  return (
    <main id="main" className="auth">
      <h1>Sign in to Raion</h1>
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
      <p className="muted">Accounts are created by a Raion admin.</p>
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
