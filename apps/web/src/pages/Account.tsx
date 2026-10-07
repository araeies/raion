import { useState, type ReactNode } from 'react';
import { api, type User } from '../api';
import { ErrorMessage, Field, useSubmit } from '../components';

/** The signed-in user's own account: password (and, below it, API tokens). */
export function AccountPage({ user, children }: { user: User; children?: ReactNode }) {
  return (
    <>
      <h1>Your account</h1>
      <p className="lead">
        Signed in as <strong>{user.username}</strong>, with the <strong>{user.role}</strong> role.
      </p>
      {user.sso ? (
        <section aria-labelledby="password-title">
          <h2 id="password-title">Password</h2>
          <p className="muted">
            You sign in with single sign-on. Your password and your role are managed by your
            organization's identity provider, not by Raion.
          </p>
        </section>
      ) : (
        <ChangePassword username={user.username} />
      )}
      {children}
    </>
  );
}

function ChangePassword({ username }: { username: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [done, setDone] = useState(false);
  const { pending, error, onSubmit } = useSubmit(async () => {
    setDone(false);
    if (next !== repeat) throw new Error('The new passwords do not match.');
    await api.changePassword(current, next);
    setCurrent('');
    setNext('');
    setRepeat('');
    setDone(true);
  });
  return (
    <section aria-labelledby="password-title">
      <h2 id="password-title">Change your password</h2>
      <p className="muted">
        At least 12 characters, and not containing your username. Changing it signs you out
        everywhere else.
      </p>
      <form onSubmit={onSubmit} className="stack">
        {/* Lets password managers associate the new password with the account. */}
        <input type="hidden" autoComplete="username" value={username} readOnly />
        <Field
          id="current-password"
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
        />
        <Field
          id="new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={setNext}
        />
        <Field
          id="repeat-password"
          label="Repeat the new password"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={setRepeat}
        />
        <button type="submit" disabled={pending}>
          {pending ? 'Changing…' : 'Change password'}
        </button>
        <ErrorMessage error={error} />
        {done && (
          <p className="notice notice-ok" role="status">
            Your password was changed.
          </p>
        )}
      </form>
    </section>
  );
}
