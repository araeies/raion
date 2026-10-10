import { useState } from 'react';
import { tokensApi, type ApiTokenView, type Role, type User } from '../api';
import { ErrorMessage, Field, useSubmit } from '../components';
import { useLoad } from '../useLoad';
import { Loading } from '../ui';

const ROLES: Role[] = ['viewer', 'editor', 'admin'];
const EXPIRY = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

function status(t: ApiTokenView): string {
  if (t.revokedAt) return 'revoked';
  if (Date.parse(t.expiresAt) <= Date.now()) return 'expired';
  return 'active';
}

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : 'never');

function TokenTable({
  tokens,
  showOwner,
  onRevoke,
}: {
  tokens: ApiTokenView[];
  showOwner: boolean;
  onRevoke: (t: ApiTokenView) => void;
}) {
  if (tokens.length === 0) return <p className="muted">No tokens.</p>;
  return (
    <div className="table-wrap" style={{ marginTop: 14 }}>
      <table>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {showOwner && <th scope="col">Owner</th>}
            <th scope="col">Role</th>
            <th scope="col">Expires</th>
            <th scope="col">Last used</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <th scope="row">{t.name}</th>
              {showOwner && <td>{t.username}</td>}
              <td>{t.role}</td>
              <td>{date(t.expiresAt)}</td>
              <td>{date(t.lastUsedAt)}</td>
              <td>{status(t)}</td>
              <td>
                {status(t) === 'active' && (
                  <button type="button" className="secondary" onClick={() => onRevoke(t)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The signed-in user's own API tokens: create, list, revoke. */
export function MyTokens({ user }: { user: User }) {
  const result = useLoad(() => tokensApi.list(), 'my-tokens');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [days, setDays] = useState(90);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const {
    pending,
    error: createError,
    onSubmit,
  } = useSubmit(async () => {
    const res = await tokensApi.create(name.trim(), role, days);
    setCreated(res.token);
    setName('');
    result.reload();
  });
  const revoke = async (t: ApiTokenView) => {
    setError(null);
    try {
      await tokensApi.revoke(t.id);
      result.reload();
    } catch (err) {
      setError(err);
    }
  };
  const allowed = ROLES.slice(0, ROLES.indexOf(user.role) + 1);
  return (
    <section className="card" aria-labelledby="tokens-title">
      <h2 id="tokens-title">API tokens</h2>
      <p className="muted">
        For scripts and automation that use Raion's HTTP API: send the token in an{' '}
        <code>Authorization: Bearer …</code> header. A token acts as you, with the role you give it,
        and never more than your own role. It cannot manage accounts or tokens.
      </p>
      {created && (
        <div className="notice notice-ok" role="status">
          <p>
            <strong>Copy your new token now.</strong> It is shown only once.
          </p>
          <pre>
            <code>{created}</code>
          </pre>
          <button type="button" className="secondary" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      )}
      <form onSubmit={onSubmit} className="stack">
        <Field
          id="token-name"
          label="Name"
          value={name}
          onChange={setName}
          hint="What it is for, for example ci-deploy."
        />
        <div className="field">
          <label htmlFor="token-role">Role</label>
          <select id="token-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {allowed.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="token-expiry">Expires after</label>
          <select id="token-expiry" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.days} value={x.days}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create token'}
        </button>
        <ErrorMessage error={createError} />
      </form>
      {result.state === 'ready' && (
        <TokenTable
          tokens={result.data.tokens}
          showOwner={false}
          onRevoke={(t) => void revoke(t)}
        />
      )}
      {result.state === 'error' && <ErrorMessage error={result.error} />}
      <ErrorMessage error={error} />
    </section>
  );
}

/** Every user's tokens (admins). */
export function AllTokens() {
  const result = useLoad(() => tokensApi.list(true), 'all-tokens');
  const [error, setError] = useState<unknown>(null);
  const revoke = async (t: ApiTokenView) => {
    setError(null);
    try {
      await tokensApi.revoke(t.id);
      result.reload();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <section className="card" aria-labelledby="all-tokens-title" style={{ marginTop: 20 }}>
      <h2 id="all-tokens-title">API tokens</h2>
      <p className="muted">
        Every user's tokens. Revoke one that is no longer needed or may have leaked.
      </p>
      {result.state === 'loading' && <Loading label="Loading tokens…" />}
      {result.state === 'error' && <ErrorMessage error={result.error} />}
      {result.state === 'ready' && (
        <TokenTable
          tokens={result.data.tokens.filter((t) => status(t) === 'active')}
          showOwner
          onRevoke={(t) => void revoke(t)}
        />
      )}
      <ErrorMessage error={error} />
    </section>
  );
}
