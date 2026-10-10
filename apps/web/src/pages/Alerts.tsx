import { useState } from 'react';
import {
  alertsApi,
  type AlertRecord,
  type AlertRule,
  type AlertsOverview,
  type PendingAlert,
  type User,
} from '../api';
import { ErrorMessage, Field, useSubmit } from '../components';
import { linkHandler } from '../router';
import {
  dateTime,
  duration,
  EmptyState,
  Explain,
  Icon,
  InfoTip,
  Loading,
  PageHeader,
  Pill,
  Stat,
  Technical,
  timeAgo,
  type Tone,
} from '../ui';
import { useLoad } from '../useLoad';

const SEVERITY_ORDER = ['critical', 'warning', 'info', 'none'];

export function severityTone(severity: string | null | undefined): { tone: Tone; label: string } {
  if (severity === 'critical') return { tone: 'crit', label: 'Urgent' };
  if (severity === 'warning') return { tone: 'warn', label: 'Warning' };
  return { tone: 'neutral', label: 'Info' };
}

/** Where an alert comes from, in words. */
function origin(rule: AlertRule): string {
  switch (rule.scope) {
    case 'service':
      return `One of the checks Raion runs for ${rule.service ?? 'this application'}, because its alerts are turned on.`;
    case 'slo':
      return `Created from the reliability goal "${rule.slo ?? ''}" of ${rule.service ?? 'this application'}.`;
    case 'infrastructure':
      return 'Raion watches the machine it runs on.';
    case 'platform':
      return 'Raion watches its own components, so you know when monitoring itself has a problem.';
  }
}

const SCOPES: { scope: AlertRule['scope']; title: string; description: string }[] = [
  {
    scope: 'service',
    title: 'Your applications',
    description: 'Errors, slow responses and applications that stop reporting.',
  },
  {
    scope: 'slo',
    title: 'Reliability goals',
    description: 'Warnings when an application is on course to miss its reliability goal.',
  },
  {
    scope: 'infrastructure',
    title: 'This machine',
    description: 'Disk space, memory and processor of the machine Raion runs on.',
  },
  {
    scope: 'platform',
    title: 'Raion itself',
    description: 'The components that collect, store and deliver your monitoring data.',
  },
];

type Tab = 'firing' | 'pending' | 'history' | 'rules';

export function AlertsPage({ user }: { user: User }) {
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<Tab>('firing');
  const overview = useLoad(() => alertsApi.overview(), `alerts:${tick}`, { keepPrevious: true });
  const silences = useLoad(
    () => alertsApi.silences().catch(() => ({ silences: [] })),
    `silences:${tick}`,
    { keepPrevious: true },
  );
  const reload = () => setTick((t) => t + 1);
  const canEdit = user.role !== 'viewer';

  const header = (
    <PageHeader
      title="Alerts"
      description="Raion tells you here when something needs attention, what it means and what to do. Every alert appears here, whoever else is notified."
      actions={
        <>
          <button type="button" className="secondary" onClick={reload}>
            Refresh
          </button>
          <a
            className="button secondary"
            href="/grafana/d/raion-alerts"
            target="_blank"
            rel="noopener"
          >
            <Icon name="chart" /> Alert history chart
          </a>
        </>
      }
    />
  );
  if (overview.state === 'loading')
    return (
      <>
        {header}
        <Loading label="Loading alerts…" />
      </>
    );
  if (overview.state === 'error')
    return (
      <>
        {header}
        <p className="notice notice-error" role="alert">
          Could not load alerts: {overview.error.message}
        </p>
      </>
    );
  const data = overview.data;
  const firing = [...data.firing].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity ?? 'none') - SEVERITY_ORDER.indexOf(b.severity ?? 'none'),
  );

  const tabs: { id: Tab; label: string }[] = [
    { id: 'firing', label: `Firing now (${firing.length})` },
    { id: 'pending', label: `About to fire (${data.pending.length})` },
    { id: 'history', label: 'History' },
    { id: 'rules', label: `What Raion watches (${data.rules.length})` },
  ];

  return (
    <>
      {header}
      <SelfTest data={data} />

      <div className="stats" style={{ margin: '20px 0 24px' }}>
        <Stat
          label="Firing now"
          value={firing.length}
          sub={firing.length ? 'need attention' : 'all clear'}
        />
        <Stat
          label="About to fire"
          value={data.pending.length}
          sub="problems Raion is watching"
          help="The problem is happening, but Raion waits a few minutes before alerting, so that a short blip does not wake anyone up."
        />
        <Stat label="Resolved recently" value={data.resolved.length} sub="last 30 days" />
      </div>

      <div className="tabs" role="tablist" aria-label="Alerts">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'firing' &&
          (firing.length === 0 ? (
            <EmptyState icon="ok" title="Nothing needs attention">
              {data.deployed
                ? 'No alert is firing. Raion keeps checking every 30 seconds.'
                : 'Alerts start once the observability stack is deployed.'}
            </EmptyState>
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
          ))}

        {tab === 'pending' &&
          (data.pending.length === 0 ? (
            <EmptyState icon="clock" title="Nothing is about to fire">
              When a problem starts, it appears here first. If it lasts, it becomes an alert.
            </EmptyState>
          ) : (
            <ul className="alert-list">
              {data.pending.map((a) => (
                <PendingCard key={`${a.alertname}-${JSON.stringify(a.labels)}`} alert={a} />
              ))}
            </ul>
          ))}

        {tab === 'history' && <History resolved={data.resolved} />}

        {tab === 'rules' && <WatchList rules={data.rules} />}
      </div>

      {silences.state === 'ready' && silences.data.silences.length > 0 && (
        <section className="card" aria-labelledby="silences-title" style={{ marginTop: 24 }}>
          <div className="card-header">
            <h2 id="silences-title">
              Silenced{' '}
              <InfoTip label="a silence">
                A silence stops notifications for a while, for example while a fix is being
                deployed. The alert stays visible here.
              </InfoTip>
            </h2>
          </div>
          <ul className="checklist">
            {silences.data.silences.map((s) => (
              <li key={s.id}>
                <span className="grow" style={{ flex: 1 }}>
                  <strong>{s.matchers.map((m) => m.value).join(' · ')}</strong>
                  <br />
                  <span className="muted small">
                    Until {dateTime(s.endsAt)} · by {s.createdBy} · “{s.comment}”
                  </span>
                </span>
                {canEdit && (
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => {
                      void alertsApi.unsilence(s.id).then(reload);
                    }}
                  >
                    End silence
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** The always-firing self-test, explained instead of hidden. */
function SelfTest({ data }: { data: AlertsOverview }) {
  const rule = data.selfTest.rule;
  if (!data.deployed) {
    return (
      <div className="notice notice-info callout">
        <Icon name="info" />
        <div>
          <strong>Alerts start once Raion is deployed.</strong> Deploy it from the Observability
          stack page, and Raion starts watching your applications, this machine and itself.
        </div>
      </div>
    );
  }
  const ok = data.health?.ok ?? false;
  return (
    <div
      className={`notice ${ok ? 'notice-ok' : 'notice-error'} callout`}
      role={ok ? undefined : 'alert'}
    >
      <Icon name={ok ? 'ok' : 'alert'} />
      <div style={{ flex: 1 }}>
        <div className="spread">
          <strong>{ok ? 'Alerting works' : 'Alerts are not being delivered'}</strong>
          <Pill tone={ok ? 'ok' : 'crit'} live={ok}>
            Self-test {ok ? 'arriving' : 'missing'}
          </Pill>
        </div>
        <p style={{ margin: '4px 0 0' }}>
          {ok
            ? 'Raion checks continuously that its alerts are evaluated and delivered.'
            : (data.health?.message ?? 'Raion could not check its alerting.')}
        </p>
        {rule && (
          <Explain summary="How does Raion know?">
            <p>{rule.meaning}</p>
            <p className="muted small" style={{ marginBottom: 0 }}>
              In Grafana and in the raw configuration, this self-test is the alert named{' '}
              <code>{rule.alert}</code>. It is never listed among your alerts and never notifies
              anyone.
            </p>
          </Explain>
        )}
      </div>
    </div>
  );
}

function ServiceLink({ service }: { service: string }) {
  return (
    <a href={`/services/${service}`} onClick={linkHandler(`/services/${service}`)}>
      {service}
    </a>
  );
}

/** The explanation shared by firing, pending and resolved alerts. */
function Facts({
  rule,
  summary,
  started,
  ended,
}: {
  rule: AlertRule | null;
  summary?: string;
  started: { label: string; at: string };
  ended?: string | null;
}) {
  return (
    <dl className="facts">
      {summary && (
        <>
          <dt>Right now</dt>
          <dd>{summary}</dd>
        </>
      )}
      {rule?.meaning && (
        <>
          <dt>What it means</dt>
          <dd>{rule.meaning}</dd>
        </>
      )}
      {rule?.condition && (
        <>
          <dt>Why it fired</dt>
          <dd>{rule.condition}</dd>
        </>
      )}
      {rule && rule.action.length > 0 && (
        <>
          <dt>What to do</dt>
          <dd>
            <ol>
              {rule.action.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ol>
          </dd>
        </>
      )}
      <dt>{started.label}</dt>
      <dd>
        {dateTime(started.at)}{' '}
        <span className="muted">
          ({ended ? `lasted ${duration(started.at, ended)}` : timeAgo(started.at)})
        </span>
      </dd>
      {rule && (
        <>
          <dt>Where it comes from</dt>
          <dd>{origin(rule)}</dd>
        </>
      )}
    </dl>
  );
}

function TechnicalAlert({
  alertname,
  labels,
  rule,
}: {
  alertname: string;
  labels: Record<string, string>;
  rule: AlertRule | null;
}) {
  return (
    <Technical>
      <dl className="properties">
        <dt>Alert rule</dt>
        <dd>
          <code>{alertname}</code>
          {rule && (
            <>
              {' '}
              in group <code>{rule.group}</code>
            </>
          )}
        </dd>
        {rule?.for && (
          <>
            <dt>Must last</dt>
            <dd>{rule.for}</dd>
          </>
        )}
        <dt>Labels</dt>
        <dd>
          {Object.entries(labels)
            .filter(([k]) => k !== 'alertname')
            .map(([k, v]) => (
              <code key={k} style={{ marginRight: 6, display: 'inline-block' }}>
                {k}={v}
              </code>
            ))}
        </dd>
      </dl>
      {rule && (
        <>
          <p className="small muted" style={{ margin: '12px 0 6px' }}>
            Condition (PromQL), evaluated by Prometheus every 30 seconds:
          </p>
          <pre>
            <code>{rule.expr}</code>
          </pre>
        </>
      )}
    </Technical>
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
  const sev = severityTone(alert.severity);
  const silenced = alert.state === 'suppressed';
  return (
    <li className={`alert-card sev-${alert.severity === 'critical' ? 'critical' : 'warning'}`}>
      <div className="alert-head">
        <h3>{alert.rule?.title ?? alert.alertname}</h3>
        <div className="row">
          <Pill tone={sev.tone}>{sev.label}</Pill>
          {silenced ? (
            <Pill tone="neutral">Silenced</Pill>
          ) : (
            <Pill tone="crit" live>
              Firing
            </Pill>
          )}
        </div>
      </div>
      <div className="alert-meta">
        {alert.service && (
          <span>
            Application: <ServiceLink service={alert.service} />
          </span>
        )}
        <span>Firing for {duration(alert.startsAt)}</span>
      </div>
      <Facts
        rule={alert.rule}
        summary={alert.annotations.summary}
        started={{ label: 'Started', at: alert.startsAt }}
      />
      <div className="row" style={{ marginTop: 14 }}>
        {alert.annotations.dashboard_url && (
          <a
            className="button secondary small"
            href={alert.annotations.dashboard_url}
            target="_blank"
            rel="noopener"
          >
            <Icon name="chart" size={15} /> Open dashboard
          </a>
        )}
        {alert.annotations.runbook_url && (
          <a
            className="button secondary small"
            href={alert.annotations.runbook_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Your team's runbook <Icon name="external" size={14} />
          </a>
        )}
        {canEdit && !silenced && !silencing && (
          <button type="button" className="secondary small" onClick={() => setSilencing(true)}>
            Silence…
          </button>
        )}
      </div>
      {silencing && (
        <SilenceForm
          alert={alert}
          onCancel={() => setSilencing(false)}
          onDone={() => {
            setSilencing(false);
            onChange();
          }}
        />
      )}
      <TechnicalAlert alertname={alert.alertname} labels={alert.labels} rule={alert.rule} />
    </li>
  );
}

function PendingCard({ alert }: { alert: PendingAlert }) {
  const service = alert.labels.service_name;
  const sev = severityTone(alert.labels.severity);
  return (
    <li className="alert-card sev-pending">
      <div className="alert-head">
        <h3>{alert.rule?.title ?? alert.alertname}</h3>
        <div className="row">
          <Pill tone={sev.tone}>{sev.label}</Pill>
          <Pill tone="info">About to fire</Pill>
        </div>
      </div>
      <div className="alert-meta">
        {service && (
          <span>
            Application: <ServiceLink service={service} />
          </span>
        )}
        <span>
          Problem seen for {duration(alert.activeAt)}
          {alert.rule?.for ? `; it becomes an alert if it lasts ${alert.rule.for}` : ''}
        </span>
      </div>
      <Facts rule={alert.rule} started={{ label: 'Problem started', at: alert.activeAt }} />
      <TechnicalAlert alertname={alert.alertname} labels={alert.labels} rule={alert.rule} />
    </li>
  );
}

function History({ resolved }: { resolved: AlertRecord[] }) {
  if (resolved.length === 0)
    return (
      <EmptyState icon="clock" title="No past alerts">
        Alerts that stop firing are kept here for 30 days.
      </EmptyState>
    );
  return (
    <div className="table-wrap">
      <table>
        <caption className="visually-hidden">Alerts that fired in the last 30 days</caption>
        <thead>
          <tr>
            <th scope="col">Alert</th>
            <th scope="col">Application</th>
            <th scope="col">Started</th>
            <th scope="col">Lasted</th>
          </tr>
        </thead>
        <tbody>
          {resolved.map((a) => {
            const sev = severityTone(a.severity);
            return (
              <tr key={`${a.fingerprint}-${a.startsAt}`}>
                <th scope="row">
                  <span className="row" style={{ gap: 8 }}>
                    <Pill tone={sev.tone}>{sev.label}</Pill>
                    {a.rule?.title ?? a.alertname}
                  </span>
                  {a.source === 'prometheus-history' && (
                    <span className="small muted">
                      Recovered from history{' '}
                      <InfoTip label="a recovered alert">
                        This alert fired while the Raion server was not running. Raion found it in
                        the monitoring data afterwards, so its details are limited.
                      </InfoTip>
                    </span>
                  )}
                </th>
                <td>
                  {a.service ? (
                    <ServiceLink service={a.service} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="nowrap">{dateTime(a.startsAt)}</td>
                <td className="nowrap">{a.resolvedAt ? duration(a.startsAt, a.resolvedAt) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WatchList({ rules }: { rules: AlertRule[] }) {
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        Raion sets these checks up for you from your workspace. Each one runs every 30 seconds.
      </p>
      {SCOPES.map((s) => {
        const list = rules.filter((r) => r.scope === s.scope && r.alert !== 'Watchdog');
        if (list.length === 0) return null;
        return (
          <section className="card" key={s.scope} aria-labelledby={`scope-${s.scope}`}>
            <div className="card-header">
              <div>
                <h2 id={`scope-${s.scope}`}>{s.title}</h2>
                <span className="muted small">{s.description}</span>
              </div>
              <span className="pill">{list.length}</span>
            </div>
            <ul className="checklist">
              {list.map((r) => {
                const sev = severityTone(r.severity);
                return (
                  <li key={`${r.group}-${r.alert}`}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="spread">
                        <strong>{r.title}</strong>
                        <span className="row" style={{ gap: 6 }}>
                          {r.service && <span className="pill">{r.service}</span>}
                          <Pill tone={sev.tone}>{sev.label}</Pill>
                        </span>
                      </div>
                      <span className="small muted">{r.condition}</span>
                      <Technical>
                        <p className="small" style={{ margin: '0 0 6px' }}>
                          <code>{r.alert}</code> · group <code>{r.group}</code>
                          {r.for ? ` · must last ${r.for}` : ''}
                        </p>
                        <pre>
                          <code>{r.expr}</code>
                        </pre>
                      </Technical>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function SilenceForm({
  alert,
  onDone,
  onCancel,
}: {
  alert: AlertRecord;
  onDone: () => void;
  onCancel: () => void;
}) {
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
    <form
      onSubmit={onSubmit}
      className="card"
      style={{ marginTop: 14, background: 'var(--surface-2)' }}
    >
      <p className="small" style={{ marginTop: 0 }}>
        Silencing stops notifications for this alert for a while. It stays visible here, and comes
        back by itself when the silence ends.
      </p>
      <div className="inline-form">
        <div className="field">
          <label htmlFor={`silence-${alert.fingerprint}`}>For how long</label>
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
          hint="Everyone sees this, e.g. “known issue, fix deploying”."
        />
      </div>
      <ErrorMessage error={error} />
      <div className="row" style={{ marginTop: 12 }}>
        <button type="submit" disabled={pending}>
          {pending ? 'Silencing…' : 'Silence'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Alerts of one application, for its page. */
export function ServiceAlerts({ name, user }: { name: string; user: User }) {
  const [tick, setTick] = useState(0);
  const result = useLoad(() => alertsApi.overview(name), `service-alerts:${name}:${tick}`, {
    keepPrevious: true,
  });
  if (result.state !== 'ready') return null;
  const { firing, pending, rules } = result.data;
  return (
    <>
      {firing.length === 0 && pending.length === 0 ? (
        <p className="muted">Nothing needs attention for this application.</p>
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
          {pending.map((a) => (
            <PendingCard key={`${a.alertname}-${JSON.stringify(a.labels)}`} alert={a} />
          ))}
        </ul>
      )}
      <Explain summary={`What Raion watches for this application (${rules.length})`}>
        {rules.length === 0 ? (
          <p>
            Nothing yet: Raion needs request measurements from it, or its alerts are turned off.
          </p>
        ) : (
          <ul>
            {rules.map((r) => (
              <li key={`${r.group}-${r.alert}`}>
                <strong>{r.title}</strong>: {r.condition}
              </li>
            ))}
          </ul>
        )}
      </Explain>
    </>
  );
}

/** Admin: secrets needed by notification receivers. Values are write-only. */
export function SecretsSection() {
  const [tick, setTick] = useState(0);
  const result = useLoad(() => alertsApi.secrets(), `secrets:${tick}`);
  if (result.state !== 'ready') return null;
  const unused = result.data.stored.filter((k) => !result.data.needed.some((n) => n.key === k));
  if (result.data.needed.length === 0 && unused.length === 0)
    return (
      <EmptyState icon="key" title="No secrets needed">
        Secrets appear here when a notification channel or a database needs a password.
      </EmptyState>
    );
  return (
    <section className="card" aria-labelledby="secrets-title">
      <div className="card-header">
        <h2 id="secrets-title">
          Secrets{' '}
          <InfoTip label="a secret">
            Passwords and private addresses that Raion needs, for example to send alerts to Slack or
            read a database. They are stored on the Raion server, never in your workspace files, and
            can be replaced but never read back.
          </InfoTip>
        </h2>
      </div>
      <p className="muted small">Deploy afterwards so the components pick up new values.</p>
      <ul className="checklist">
        {result.data.needed.map((s) => (
          <li key={s.key}>
            <div style={{ flex: 1 }}>
              <div className="row">
                <code>{s.key}</code>
                <Pill tone={s.present ? 'ok' : 'crit'}>{s.present ? 'Set' : 'Missing'}</Pill>
              </div>
              {s.source === 'env' ? (
                <p className="muted small" style={{ margin: '6px 0 0' }}>
                  Read from the environment of the process that deploys Raion.
                </p>
              ) : (
                <SecretForm name={s.key} onSaved={() => setTick((t) => t + 1)} />
              )}
            </div>
          </li>
        ))}
      </ul>
      {unused.length > 0 && (
        <>
          <h3 className="small muted" style={{ margin: '16px 0 6px' }}>
            Stored but no longer used
          </h3>
          <ul className="checklist">
            {unused.map((key) => (
              <li key={key}>
                <code style={{ flex: 1 }}>{key}</code>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => void alertsApi.removeSecret(key).then(() => setTick((t) => t + 1))}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
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
    <form onSubmit={onSubmit} className="inline-form" style={{ marginTop: 8 }}>
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
