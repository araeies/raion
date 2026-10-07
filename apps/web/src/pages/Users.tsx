import { useState } from 'react';
import { api, type Role, type User } from '../api';
import { ErrorMessage, Field, useSubmit } from '../components';
import { useLoad } from '../useLoad';

const ROLE_HELP: Record<Role, string> = {
  viewer: 'Can see services, health, SLOs, alerts and configuration.',
  editor: 'Can also change services and SLOs and deploy ordinary changes.',
  admin: 'Can also manage users, secrets and security-relevant changes.',
};

export function UsersPage({ currentUser }: { currentUser: User }) {
  const result = useLoad(() => api.users(), 'users');
  const [actionError, setActionError] = useState<unknown>(null);

  const update = async (user: User, changes: { role?: Role; disabled?: boolean }) => {
    setActionError(null);
    try {
      await api.updateUser(user.username, changes);
      result.reload();
    } catch (error) {
      setActionError(error);
    }
  };

  return (
    <>
      <h1>Users</h1>
      <p className="lead">
        Everyone who uses Raion has their own account. Changing a role or disabling an account signs
        that person out.
      </p>
      <ul className="role-help">
        {(Object.keys(ROLE_HELP) as Role[]).map((role) => (
          <li key={role}>
            <strong>{role}</strong>: {ROLE_HELP[role]}
          </li>
        ))}
      </ul>
      <ErrorMessage error={actionError} />
      {result.state === 'loading' && <p aria-busy="true">Loading users…</p>}
      {result.state === 'error' && <p role="alert">{result.error.message}</p>}
      {result.state === 'ready' && (
        <table>
          <caption className="visually-hidden">User accounts</caption>
          <thead>
            <tr>
              <th scope="col">Username</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {result.data.users.map((u) => (
              <tr key={u.id}>
                <th scope="row">
                  {u.username}
                  {u.id === currentUser.id && <span className="muted"> (you)</span>}
                </th>
                <td>
                  <label className="visually-hidden" htmlFor={`role-${u.id}`}>
                    Role for {u.username}
                  </label>
                  <select
                    id={`role-${u.id}`}
                    value={u.role}
                    onChange={(e) => void update(u, { role: e.target.value as Role })}
                  >
                    <option value="viewer">viewer</option>
                    <option value="editor">editor</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>{u.disabled ? 'disabled' : 'active'}</td>
                <td>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void update(u, { disabled: !u.disabled })}
                  >
                    {u.disabled ? 'Enable' : 'Disable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CreateUser onCreated={result.reload} />
    </>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const { pending, error, onSubmit } = useSubmit(async () => {
    await api.createUser(username, password, role);
    setUsername('');
    setPassword('');
    onCreated();
  });
  return (
    <section aria-labelledby="create-user-title">
      <h2 id="create-user-title">Add a user</h2>
      <form onSubmit={onSubmit} className="inline-form">
        <Field
          id="new-username"
          label="Username"
          autoComplete="off"
          value={username}
          onChange={setUsername}
        />
        <Field
          id="new-password"
          label="Initial password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          hint="At least 12 characters. Share it privately."
        />
        <div className="field">
          <label htmlFor="new-role">Role</label>
          <select id="new-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="viewer">viewer</option>
            <option value="editor">editor</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <ErrorMessage error={error} />
        <button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add user'}
        </button>
      </form>
    </section>
  );
}
