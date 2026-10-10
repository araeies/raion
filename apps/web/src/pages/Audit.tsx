import { useState } from 'react';
import { api, type AuditEntry } from '../api';
import { ErrorMessage } from '../components';
import { useLoad } from '../useLoad';
import { Loading, PageHeader } from '../ui';

const ACTIONS = [
  { value: '', label: 'All actions' },
  { value: 'login', label: 'Sign-ins' },
  { value: 'user', label: 'User changes' },
  { value: 'password', label: 'Password changes' },
  { value: 'token', label: 'API tokens' },
  { value: 'secret', label: 'Secrets' },
  { value: 'runtime', label: 'Deployments, rollbacks and repairs' },
  { value: 'alert', label: 'Silences' },
  { value: 'slo', label: 'SLOs' },
  { value: 'advisor', label: 'Advisor fixes' },
];

function details(entry: AuditEntry): string {
  if (!entry.details) return '';
  return Object.entries(entry.details)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
}

/** Who did what, and when (admins). */
export function AuditPage() {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [filter, setFilter] = useState({ actor: '', action: '' });
  const first = useLoad(
    () => api.audit({ actor: filter.actor, action: filter.action }),
    `audit:${filter.actor}:${filter.action}`,
  );
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [olderKey, setOlderKey] = useState('');
  const [end, setEnd] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const key = `${filter.actor}:${filter.action}`;
  // Pages loaded for an earlier filter do not belong to this one.
  const extra = olderKey === key ? older : [];

  if (first.state === 'loading') return <Loading label="Loading the audit log…" />;
  if (first.state === 'error') return <ErrorMessage error={first.error} />;
  const entries = [...first.data.entries, ...extra];

  const loadOlder = async () => {
    setError(null);
    try {
      const last = entries.at(-1);
      const page = await api.audit({
        before: last?.id,
        actor: filter.actor,
        action: filter.action,
      });
      setOlder([...extra, ...page.entries]);
      setOlderKey(key);
      setEnd(page.entries.length < 100);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who did what, and when, from the web UI, the API and the command line: sign-ins, changes to people and settings, secrets (by name, never the value), deployments, silences and more. Newest first."
      />
      <form
        className="filters card"
        onSubmit={(e) => {
          e.preventDefault();
          setEnd(false);
          setFilter({ actor: actor.trim(), action });
        }}
      >
        <label htmlFor="audit-actor">Person</label>
        <input
          id="audit-actor"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="any"
        />
        <label htmlFor="audit-action">Action</label>
        <select id="audit-action" value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <button type="submit" className="secondary">
          Show
        </button>
      </form>
      {entries.length === 0 ? (
        <p className="muted">
          Nothing recorded{filter.actor || filter.action ? ' for this filter' : ''}.
        </p>
      ) : (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table>
            <caption className="visually-hidden">Audit log entries</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">On</th>
                <th scope="col">Result</th>
                <th scope="col">From</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>
                    <time dateTime={e.ts}>{new Date(e.ts).toLocaleString()}</time>
                  </td>
                  <td>{e.actor ?? <span className="muted">–</span>}</td>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td>{e.target ?? ''}</td>
                  <td>
                    <span
                      className={`badge ${e.outcome === 'success' ? 'badge-ok' : 'badge-error'}`}
                    >
                      {e.outcome}
                    </span>
                  </td>
                  <td>{e.ip ?? ''}</td>
                  <td className="muted">{details(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!end && entries.length >= 100 && (
        <button type="button" className="secondary" onClick={() => void loadOlder()}>
          Show older entries
        </button>
      )}
      <ErrorMessage error={error} />
    </>
  );
}
