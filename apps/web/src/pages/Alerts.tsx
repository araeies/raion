import { useState } from 'react';
import { alertsApi, type AlertRecord, type User } from '../api';
import { Disclosure, ErrorMessage, Field, useSubmit } from '../components';
import { linkHandler } from '../router';
import { useLoad } from '../useLoad';

const SEVERITY_ORDER = ['critical', 'warning', 'info', 'none'];

function since(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

function severityBadge(severity: string | null) {
  const cls =
    severity === 'critical' ? 'badge-error' : severity === 'warning' ? 'badge-warning' : '';
  return <span className={`badge ${cls}`}>{severity ?? 'none'}</span>;
}

export function AlertsPage({ user }: { user: User }) {
  const [tick, setTick] = useState(0);
  const overview = useLoad(() => alertsApi.overview(), `alerts:${tick}`, { keepPrevious: true });
  const silences = useLoad(
    () => alertsApi.silences().catch(() => ({ silences: [] })),
    `silences:${tick}`,
    { keepPrevious: true },
  );
  const reload = () => setTick((t) => t + 1);
  const canEdit = user.role !== 'viewer';

  if (overview.state === 'loading') return <p aria-busy="true">Loading alerts…</p>;
  if (overview.state === 'error')
    return <p role="alert">Could not load alerts: {overview.error.message}</p>;
  const data = overview.data;
  const firing = [...data.firing].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity ?? 'none') - SEVERITY_ORDER.indexOf(b.severity ?? 'none'),
  );

  return (
    <>
      <h1>Alerts</h1>
      <p className="lead">
        Alerts tell you when something needs attention. Every alert appears here, whoever else is
        notified. Silencing an alert stops notifications for a while; it stays visible here.
      </p>

      {!data.deployed ? (
        <div className="notice notice-warning">
          <h2>Not deployed yet</h2>
          <p>Alerts start once the observability stack is deployed.</p>
        </div>
      ) : data.health?.ok ? (
        <div className="notice notice-ok">
          <h2>Alerting works</h2>
          <p>{data.health.message}</p>
        </div>
      ) : (
        <div className="notice notice-error" role="alert">
          <h2>Alerting is broken</h2>
          <p>{data.health?.message ?? 'The alerting pipeline could not be checked.'}</p>
        </div>
      )}

      <div className="actions">
        <a className="button" href="/grafana/d/raion-alerts" target="_blank" rel="noopener">
          Alerts dashboard ↗
        </a>
        <button type="button" className="secondary" onClick={reload}>
          Refresh
        </button>
      </div>

      <section aria-labelledby="firing-title">
        <h2 id="firing-title">Firing now ({firing.length})</h2>
        {firing.length === 0 ? (
          <p className="muted">Nothing is firing.</p>
        ) : (
          <ul className="alert-list">
            {firing.map((a) => (
              <AlertCard
                key={`${a.fingerprint}-${a.startsAt}`}
                alert={a}
                canEdit={canEdit}
                onChange={reload}
              />
            ))}
          </ul>
        )}
      </section>

      {silences.state === 'ready' && silences.data.silences.length > 0 && (
        <section aria-labelledby="silences-title">
          <h2 id="silences-title">Silences</h2>
          <ul>
            {silences.data.silences.map((s) => (
              <li key={s.id}>
                <code>{s.matchers.map((m) => `${m.name}=${m.value}`).join(', ')}</code> until{' '}
                {new Date(s.endsAt).toLocaleString()} — {s.comment}{' '}
                <span className="muted">({s.createdBy})</span>{' '}
                {canEdit && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      void alertsApi.unsilence(s.id).then(reload);
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="resolved-title">
        <h2 id="resolved-title">Recently resolved</h2>
        {data.resolved.length === 0 ? (
          <p className="muted">No resolved alerts yet.</p>
        ) : (
          <table>
            <caption className="visually-hidden">Recently resolved alerts</caption>
            <thead>
              <tr>
                <th scope="col">Alert</th>
                <th scope="col">Service</th>
                <th scope="col">Severity</th>
                <th scope="col">Started</th>
                <th scope="col">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {data.resolved.map((a) => (
                <tr key={`${a.fingerprint}-${a.startsAt}`}>
                  <th scope="row">{a.alertname}</th>
                  <td>{a.service ?? <span className="muted">—</span>}</td>
                  <td>{severityBadge(a.severity)}</td>
                  <td>{new Date(a.startsAt).toLocaleString()}</td>
                  <td>{a.resolvedAt ? new Date(a.resolvedAt).toLocaleString() : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="rules-title">
        <h2 id="rules-title">What Raion watches</h2>
        <Disclosure summary={`Show the ${data.rules.length} alert rules`}>
          <table>
            <caption className="visually-hidden">Alert rules</caption>
            <thead>
              <tr>
                <th scope="col">Alert</th>
                <th scope="col">Applies to</th>
                <th scope="col">Severity</th>
                <th scope="col">Fires after</th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={`${r.group}-${r.alert}`}>
                  <th scope="row">{r.alert}</th>
                  <td>{r.service ?? r.group.replace('raion-', '')}</td>
                  <td>{severityBadge(r.severity)}</td>
                  <td>{r.for ?? 'immediately'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Thresholds are set per service in the workspace (<code>alerts:</code>); the full rules
            are in the generated configuration on the Observability stack page.
          </p>
        </Disclosure>
      </section>
    </>
  );
}

export function AlertCard({
  alert,
  canEdit,
  onChange,
}: {
  alert: AlertRecord;
  canEdit: boolean;
  onChange: () => void;
}) {
  const [silencing, setSilencing] = useState(false);
  return (
    <li className="card alert-card">
      <h3>
        {severityBadge(alert.severity)} {alert.alertname}
        {alert.service && (
          <>
            {' · '}
            <a
              href={`/services/${alert.service}`}
              onClick={linkHandler(`/services/${alert.service}`)}
            >
              {alert.service}
            </a>
          </>
        )}
        {alert.state === 'suppressed' && <span className="badge"> silenced</span>}
      </h3>
      <p>
        <strong>{alert.annotations.summary}</strong>
      </p>
      <p>{alert.annotations.description}</p>
      <p className="muted">
        Firing for {since(alert.startsAt)}
        {alert.annotations.dashboard_url && (
          <>
            {' · '}
            <a href={alert.annotations.dashboard_url} target="_blank" rel="noopener">
              Dashboard ↗
            </a>
          </>
        )}
        {alert.annotations.runbook_url && (
          <>
            {' · '}
            <a href={alert.annotations.runbook_url} target="_blank" rel="noopener noreferrer">
              Runbook ↗
            </a>
          </>
        )}
      </p>
      {canEdit && alert.state !== 'suppressed' && !silencing && (
        <button type="button" className="secondary" onClick={() => setSilencing(true)}>
          Silence…
        </button>
      )}
      {silencing && (
        <SilenceForm
          alert={alert}
          onDone={() => {
            setSilencing(false);
            onChange();
          }}
        />
      )}
    </li>
  );
}

function SilenceForm({ alert, onDone }: { alert: AlertRecord; onDone: () => void }) {
  const [minutes, setMinutes] = useState(60);
  const [comment, setComment] = useState('');
  const { pending, error, onSubmit } = useSubmit(async () => {
    await alertsApi.silence({
      alertname: alert.alertname,
      ...(alert.service ? { service: alert.service } : {}),
      minutes,
      comment,
    });
    onDone();
  });
  return (
    <form onSubmit={onSubmit} className="inline-form">
      <div className="field">
        <label htmlFor={`silence-${alert.fingerprint}`}>Silence for</label>
        <select
          id={`silence-${alert.fingerprint}`}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        >
          <option value={60}>1 hour</option>
          <option value={240}>4 hours</option>
          <option value={1440}>1 day</option>
          <option value={10080}>1 week</option>
        </select>
      </div>
      <Field
        id={`comment-${alert.fingerprint}`}
        label="Why?"
        value={comment}
        onChange={setComment}
        hint="Visible to everyone, e.g. “known issue, fix deploying”."
      />
      <ErrorMessage error={error} />
      <button type="submit" disabled={pending}>
        {pending ? 'Silencing…' : 'Silence'}
      </button>
    </form>
  );
}

/** Firing alerts of one service, for the service page. */
export function ServiceAlerts({ name, user }: { name: string; user: User }) {
  const [tick, setTick] = useState(0);
  const result = useLoad(() => alertsApi.overview(name), `service-alerts:${name}:${tick}`, {
    keepPrevious: true,
  });
  if (result.state !== 'ready') return null;
  const { firing, rules } = result.data;
  return (
    <>
      {firing.length === 0 ? (
        <p className="muted">No alerts are firing for this service.</p>
      ) : (
        <ul className="alert-list">
          {firing.map((a) => (
            <AlertCard
              key={`${a.fingerprint}-${a.startsAt}`}
              alert={a}
              canEdit={user.role !== 'viewer'}
              onChange={() => setTick((t) => t + 1)}
            />
          ))}
        </ul>
      )}
      <p className="muted">
        Watched:{' '}
        {rules.map((r) => r.alert).join(', ') || 'nothing (no HTTP metrics or alerts disabled)'}.
      </p>
    </>
  );
}

/** Admin: secrets needed by notification receivers. Values are write-only. */
export function SecretsSection() {
  const [tick, setTick] = useState(0);
  const result = useLoad(() => alertsApi.secrets(), `secrets:${tick}`);
  if (result.state !== 'ready' || result.data.needed.length === 0) return null;
  return (
    <section aria-labelledby="secrets-title">
      <h2 id="secrets-title">Notification secrets</h2>
      <p className="muted">
        Credentials your notification receivers use. Values are stored on the Raion server and can
        be replaced but never read back. Apply afterwards so Alertmanager picks them up.
      </p>
      <ul className="target-list">
        {result.data.needed.map((s) => (
          <li key={s.key}>
            <span className={`badge ${s.present ? 'badge-ok' : 'badge-error'}`}>
              {s.present ? 'set' : 'missing'}
            </span>{' '}
            <code>{s.key}</code>{' '}
            {s.source === 'env' ? (
              <span className="muted">
                read from the environment of the process that runs “raion apply”
              </span>
            ) : (
              <SecretForm name={s.key} onSaved={() => setTick((t) => t + 1)} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SecretForm({ name, onSaved }: { name: string; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const { pending, error, onSubmit } = useSubmit(async () => {
    await alertsApi.setSecret(name, value);
    setValue('');
    onSaved();
  });
  return (
    <form onSubmit={onSubmit} className="inline-form">
      <Field
        id={`secret-${name}`}
        label={`New value for ${name}`}
        type="password"
        autoComplete="off"
        value={value}
        onChange={setValue}
      />
      <ErrorMessage error={error} />
      <button type="submit" disabled={pending}>
        Save
      </button>
    </form>
  );
}
