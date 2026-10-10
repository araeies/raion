import { useState } from 'react';
import { alertsApi, api, type ServiceDetail, type User } from '../api';
import { AppCard, languageLabel, typeIcon, typeLabel } from '../AppCard';
import { Diagnostics } from '../components';
import { EditError, EditResult, useEdit } from '../edits';
import { linkHandler, navigate } from '../router';
import { EmptyState, Explain, Icon, InfoTip, Loading, PageHeader, Pill, Technical } from '../ui';
import { useLoad } from '../useLoad';
import { ServiceAlerts } from './Alerts';
import { ServiceSlos } from './Slos';
import { ConnectService, ServiceHealth } from './ServiceTelemetry';

export function ServicesPage({ user }: { user: User }) {
  const result = useLoad(
    () =>
      Promise.all([api.services(), alertsApi.overview().catch(() => null)]).then(
        ([services, alerts]) => ({ ...services, firing: alerts?.firing ?? [] }),
      ),
    'services',
  );
  const [query, setQuery] = useState('');
  const canEdit = user.role !== 'viewer';
  const header = (
    <PageHeader
      title="Applications"
      description="Everything Raion monitors. Raion sets up metrics, logs, traces, dashboards, alerts and reliability goals for each one."
      actions={
        canEdit ? (
          <a className="button" href="/services/new" onClick={linkHandler('/services/new')}>
            <Icon name="plus" /> Add an application
          </a>
        ) : undefined
      }
    />
  );
  if (result.state === 'loading')
    return (
      <>
        {header}
        <Loading label="Loading applications…" />
      </>
    );
  if (result.state === 'error')
    return (
      <>
        {header}
        <p className="notice notice-error" role="alert">
          Could not load applications: {result.error.message}
        </p>
      </>
    );
  const { services, diagnostics, firing } = result.data;
  const shown = services.filter((s) =>
    `${s.name} ${s.type} ${s.language ?? ''} ${s.team ?? ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      {header}
      <Diagnostics diagnostics={diagnostics} />
      {services.length === 0 ? (
        <EmptyState
          icon="apps"
          title="No applications yet"
          action={
            canEdit ? (
              <a className="button" href="/services/new" onClick={linkHandler('/services/new')}>
                <Icon name="plus" /> Add your first application
              </a>
            ) : undefined
          }
        >
          Tell Raion about something you run, such as a website, an API or a database, and it sets
          up the monitoring for you.
        </EmptyState>
      ) : (
        <>
          {services.length > 6 && (
            <div className="field" style={{ maxWidth: 360, marginBottom: 16 }}>
              <label htmlFor="app-search" className="visually-hidden">
                Find an application
              </label>
              <input
                id="app-search"
                type="search"
                placeholder="Find an application…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <div className="grid">
            {shown.map((s) => (
              <AppCard
                key={s.name}
                service={s}
                firing={firing.filter((a) => a.service === s.name)}
              />
            ))}
          </div>
          {shown.length === 0 && <p className="muted">No application matches “{query}”.</p>}
        </>
      )}
    </>
  );
}

type Tab = 'overview' | 'connect' | 'goals' | 'settings' | 'config';

export function ServiceDetailPage({ name, user }: { name: string; user: User }) {
  const [tick, setTick] = useState(0);
  const result = useLoad<ServiceDetail>(() => api.service(name), `service:${name}:${tick}`, {
    keepPrevious: true,
  });
  const [tab, setTab] = useState<Tab>('overview');
  const back = { href: '/services', label: 'Applications' };
  if (result.state === 'loading') return <Loading label={`Loading ${name}…`} />;
  if (result.state === 'error')
    return (
      <>
        <PageHeader title={name} back={back} />
        <p className="notice notice-error" role="alert">
          Could not load {name}: {result.error.message}
        </p>
      </>
    );
  const { service, dependents, sources } = result.data;
  const canEdit = user.role !== 'viewer';
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'overview', label: 'Overview', show: true },
    { id: 'connect', label: 'Connect', show: true },
    { id: 'goals', label: `Reliability goals (${service.slos.length})`, show: true },
    { id: 'settings', label: 'Settings', show: canEdit },
    { id: 'config', label: 'Configuration', show: true },
  ];
  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="row" style={{ gap: 14 }}>
            <span className="app-icon" aria-hidden="true">
              <Icon name={typeIcon(service.type)} size={20} />
            </span>
            {service.name}
          </span>
        }
        description={
          service.description ??
          [
            typeLabel(service.type),
            languageLabel(service.language),
            service.team && `owned by ${service.team}`,
          ]
            .filter(Boolean)
            .join(' · ')
        }
        actions={
          <a
            className="button secondary"
            href={`/grafana/d/raion-svc-${service.name}`}
            target="_blank"
            rel="noopener"
          >
            <Icon name="chart" /> Open dashboard
          </a>
        }
      />
      <div className="row" style={{ marginTop: -12, marginBottom: 20 }}>
        <span className="pill">{typeLabel(service.type)}</span>
        {service.language && <span className="pill">{languageLabel(service.language)}</span>}
        {service.tier === 'critical' && <Pill tone="warn">Critical</Pill>}
        {service.team && <span className="pill">Team: {service.team}</span>}
        <span className="pill">
          {service.runtime.type === 'compose' ? 'Docker Compose' : 'This machine'}
        </span>
      </div>

      <div className="tabs" role="tablist" aria-label={service.name}>
        {tabs
          .filter((t) => t.show)
          .map((t) => (
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
        {tab === 'overview' && (
          <div className="stack">
            <ServiceHealth name={service.name} />
            <section className="card" aria-labelledby="alerts-title">
              <div className="card-header">
                <h2 id="alerts-title">Alerts</h2>
              </div>
              <ServiceAlerts name={service.name} user={user} />
            </section>
            <Dependencies service={service} dependents={dependents} />
          </div>
        )}
        {tab === 'connect' && (
          <section className="card">
            <ConnectService name={service.name} isAdmin={user.role === 'admin'} />
          </section>
        )}
        {tab === 'goals' && <ServiceSlos name={service.name} user={user} />}
        {tab === 'settings' && (
          <ServiceSettings
            service={service}
            isAdmin={user.role === 'admin'}
            onSaved={() => setTick((t) => t + 1)}
          />
        )}
        {tab === 'config' && (
          <section className="card">
            <p className="muted small" style={{ marginTop: 0 }}>
              The files that describe {service.name}. Raion edits them when you change settings
              here; you can also edit them yourself, or with <code>raion services set</code>.
            </p>
            {sources.map((file) => (
              <details className="technical" key={file.path} open={sources.length === 1}>
                <summary>
                  <code>{file.path}</code>
                </summary>
                <div className="technical-body">
                  <pre style={{ margin: 0 }}>
                    <code>{file.content}</code>
                  </pre>
                </div>
              </details>
            ))}
          </section>
        )}
      </div>
    </>
  );
}

function Dependencies({
  service,
  dependents,
}: {
  service: ServiceDetail['service'];
  dependents: string[];
}) {
  const link = (name: string) => (
    <a href={`/services/${name}`} onClick={linkHandler(`/services/${name}`)}>
      {name}
    </a>
  );
  return (
    <section className="card" aria-labelledby="deps-title">
      <div className="card-header">
        <h2 id="deps-title">
          Connections{' '}
          <InfoTip label="connections">
            What this application calls, and what calls it. Raion uses this to show how a problem in
            one application affects others.
          </InfoTip>
        </h2>
      </div>
      <div className="columns">
        <div>
          <h3 className="small muted">It calls</h3>
          {service.dependencies.length === 0 ? (
            <p className="muted small">Nothing declared.</p>
          ) : (
            <ul className="small">
              {service.dependencies.map((d) =>
                'service' in d ? (
                  <li key={d.service}>{link(d.service)}</li>
                ) : (
                  <li key={d.external.name}>
                    {d.external.name}{' '}
                    <span className="muted">({d.external.kind}, outside Raion)</span>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
        <div>
          <h3 className="small muted">Called by</h3>
          {dependents.length === 0 ? (
            <p className="muted small">No other application calls it.</p>
          ) : (
            <ul className="small">
              {dependents.map((d) => (
                <li key={d}>{link(d)}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

const TIERS = [
  {
    value: 'critical',
    title: 'Critical',
    text: 'People are affected as soon as it has a problem. Its alerts are urgent.',
  },
  {
    value: 'standard',
    title: 'Standard',
    text: 'Important, but a short problem can wait a little.',
  },
  {
    value: 'best-effort',
    title: 'Best effort',
    text: 'Nice to have: internal tools, experiments.',
  },
];

const WAIT_CHOICES = ['1m', '2m', '5m', '10m', '15m', '30m'];

/** Everything about an application a beginner may want to change, written to its file. */
function ServiceSettings({
  service,
  isAdmin,
  onSaved,
}: {
  service: ServiceDetail['service'];
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const workspace = useLoad(() => api.workspace(), 'workspace-settings');
  const [form, setForm] = useState({
    description: service.description ?? '',
    team: service.team ?? '',
    owner: service.owner ?? '',
    tier: service.tier,
    metrics: service.signals.metrics,
    logs: service.signals.logs,
    traces: service.signals.traces,
    containerLogs: service.containerLogs,
    alertsEnabled: service.alerts.enabled,
    errorRatePercent: service.alerts.errorRatePercent,
    latencyP95Ms: service.alerts.latencyP95Ms,
    alertFor: service.alerts.for,
    missingTelemetry: service.alerts.missingTelemetry,
    composeService: service.runtime.composeService ?? '',
    addresses: service.checks.map((c) => c.url).join('\n'),
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const edit = useEdit(onSaved);
  const remove = useEdit(() => navigate('/services'));
  const [confirmRemove, setConfirmRemove] = useState(false);

  const changes = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    const text = (key: string, now: string, before: string | undefined) => {
      if (now.trim() !== (before ?? '')) c[key] = now.trim() || null;
    };
    text('description', form.description, service.description);
    text('team', form.team, service.team);
    text('owner', form.owner, service.owner);
    if (form.tier !== service.tier) c.tier = form.tier;
    if (form.metrics !== service.signals.metrics) c['signals.metrics'] = form.metrics;
    if (form.logs !== service.signals.logs) c['signals.logs'] = form.logs;
    if (form.traces !== service.signals.traces) c['signals.traces'] = form.traces;
    if (form.containerLogs !== service.containerLogs) c.containerLogs = form.containerLogs;
    if (form.alertsEnabled !== service.alerts.enabled) c['alerts.enabled'] = form.alertsEnabled;
    if (form.errorRatePercent !== service.alerts.errorRatePercent)
      c['alerts.errorRatePercent'] = form.errorRatePercent;
    if (form.latencyP95Ms !== service.alerts.latencyP95Ms)
      c['alerts.latencyP95Ms'] = form.latencyP95Ms;
    if (form.alertFor !== service.alerts.for) c['alerts.for'] = form.alertFor;
    if (form.missingTelemetry !== service.alerts.missingTelemetry)
      c['alerts.missingTelemetry'] = form.missingTelemetry;
    const addresses = form.addresses
      .split(/\s+/)
      .map((a) => a.trim())
      .filter(Boolean);
    if (addresses.join('\n') !== service.checks.map((c) => c.url).join('\n'))
      c.checks = addresses.length > 0 ? addresses.map((url) => ({ url })) : null;
    if (
      service.runtime.type === 'compose' &&
      form.composeService.trim() !== (service.runtime.composeService ?? '')
    )
      c['runtime.composeService'] = form.composeService.trim() || null;
    return c;
  };
  const pendingChanges = changes();
  const known = workspace.state === 'ready' ? (workspace.data.workspace?.teams ?? []) : [];
  // Always offer the current team, even before the list has loaded.
  const teams =
    service.team && !known.some((t) => t.name === service.team)
      ? [{ name: service.team }, ...known]
      : known;

  return (
    <form
      className="stack wide"
      onSubmit={(e) => {
        e.preventDefault();
        void edit.save({ kind: 'service.update', name: service.name, set: pendingChanges });
      }}
    >
      <EditResult view={edit.saved} />

      <section className="card" aria-labelledby="about-title">
        <div className="card-header">
          <h2 id="about-title">About</h2>
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="svc-description">What it does</label>
            <input
              id="svc-description"
              value={form.description}
              placeholder="e.g. Takes card payments for the shop"
              onChange={(e) => set('description', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="svc-owner">Contact</label>
            <input
              id="svc-owner"
              value={form.owner}
              placeholder="e.g. payments-oncall@example.com"
              onChange={(e) => set('owner', e.target.value)}
            />
            <small className="hint">Who to ask when it has a problem.</small>
          </div>
          <div className="field">
            <label htmlFor="svc-team">
              Team{' '}
              <InfoTip label="a team">
                The team that owns it. Its alerts can go to the team's own notification channel.
                Admins add teams in Settings.
              </InfoTip>
            </label>
            <select id="svc-team" value={form.team} onChange={(e) => set('team', e.target.value)}>
              <option value="">No team</option>
              {teams.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {service.runtime.type === 'compose' && (
            <div className="field">
              <label htmlFor="svc-compose">Name in your Docker Compose file</label>
              <input
                id="svc-compose"
                value={form.composeService}
                placeholder={service.name}
                onChange={(e) => set('composeService', e.target.value)}
              />
              <small className="hint">
                The name under <code>services:</code> in your compose.yaml, if it is not{' '}
                <code>{service.name}</code>.
              </small>
            </div>
          )}
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: '16px 0 0' }}>
          <legend className="label" style={{ marginBottom: 8 }}>
            How important is it?
          </legend>
          <div className="choices">
            {TIERS.map((t) => (
              <label className="choice" key={t.value}>
                <input
                  type="radio"
                  name="tier"
                  value={t.value}
                  checked={form.tier === t.value}
                  onChange={() => set('tier', t.value)}
                />
                <span className="choice-title">{t.title}</span>
                <small>{t.text}</small>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="card" aria-labelledby="checks-title">
        <div className="card-header">
          <div>
            <h2 id="checks-title">
              Outside checks{' '}
              <InfoTip label="outside checks">
                Raion visits these addresses regularly, like a user would, and alerts you when they
                stop answering, get slow, or their HTTPS certificate is about to expire.
              </InfoTip>
            </h2>
            <span className="muted small">
              {service.runtime.type === 'remote'
                ? 'How Raion watches this application. One address per line.'
                : 'Optional: also check its public address from outside. One address per line.'}
            </span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="svc-checks" className="visually-hidden">
            Addresses to check
          </label>
          <textarea
            id="svc-checks"
            rows={Math.max(2, form.addresses.split('\n').length + 1)}
            placeholder="https://shop.example.com/health"
            value={form.addresses}
            onChange={(e) => set('addresses', e.target.value)}
          />
        </div>
      </section>

      {service.runtime.type !== 'remote' && (
        <section className="card" aria-labelledby="collect-title">
          <div className="card-header">
            <div>
              <h2 id="collect-title">What Raion collects</h2>
              <span className="muted small">
                Turn something off if it is not useful, to save space.
              </span>
            </div>
          </div>
          <div className="stack">
            <Toggle
              id="sig-metrics"
              checked={form.metrics}
              onChange={(v) => set('metrics', v)}
              title="Measurements (metrics)"
              text="Numbers over time: how many requests, how many fail, how fast. Alerts are built on these."
            />
            <Toggle
              id="sig-logs"
              checked={form.logs}
              onChange={(v) => set('logs', v)}
              title="Logs"
              text="The lines your application writes about what it is doing, searchable by time."
            />
            <Toggle
              id="sig-traces"
              checked={form.traces}
              onChange={(v) => set('traces', v)}
              title="Traces"
              text="The path of each request through your applications, step by step: shows where time is spent."
            />
            {service.runtime.type === 'compose' && (
              <Toggle
                id="sig-container"
                checked={form.containerLogs}
                onChange={(v) => set('containerLogs', v)}
                title="Container output"
                text="Collect what the container prints, for applications that cannot send logs themselves (databases, Nginx)."
              />
            )}
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="alerting-title">
        <div className="card-header">
          <div>
            <h2 id="alerting-title">When to alert</h2>
            <span className="muted small">
              Raion's defaults suit most applications. Change them if alerts come too often or too
              late.
            </span>
          </div>
        </div>
        <Toggle
          id="alerts-on"
          checked={form.alertsEnabled}
          onChange={(v) => set('alertsEnabled', v)}
          title="Alerts for this application"
          text="Turn off only for something you never want to be told about."
        />
        {form.alertsEnabled && (
          <div className="grid-2" style={{ marginTop: 14 }}>
            <div className="field">
              <label htmlFor="al-errors">Alert when more than this share of requests fail</label>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input
                  id="al-errors"
                  type="number"
                  min={0.1}
                  max={99}
                  step={0.1}
                  value={form.errorRatePercent}
                  onChange={(e) => set('errorRatePercent', Number(e.target.value))}
                />
                <span>%</span>
              </div>
              <small className="hint">Recommended: 5%. Lower for critical applications.</small>
            </div>
            <div className="field">
              <label htmlFor="al-latency">Alert when 1 in 20 requests takes longer than</label>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input
                  id="al-latency"
                  type="number"
                  min={1}
                  max={600000}
                  step={50}
                  value={form.latencyP95Ms}
                  onChange={(e) => set('latencyP95Ms', Number(e.target.value))}
                />
                <span>ms</span>
              </div>
              <small className="hint">Recommended: 1000 ms for most web requests.</small>
            </div>
            <div className="field">
              <label htmlFor="al-for">Wait before alerting</label>
              <select
                id="al-for"
                value={form.alertFor}
                onChange={(e) => set('alertFor', e.target.value)}
              >
                {[...new Set([...WAIT_CHOICES, form.alertFor])].map((w) => (
                  <option key={w} value={w}>
                    {w.replace('m', ' minutes').replace('h', ' hours')}
                  </option>
                ))}
              </select>
              <small className="hint">
                So that a short blip does not wake anyone up. Recommended: 5 minutes.
              </small>
            </div>
            <div className="field" style={{ justifyContent: 'center' }}>
              <Toggle
                id="al-missing"
                checked={form.missingTelemetry}
                onChange={(v) => set('missingTelemetry', v)}
                title="Alert if it stops reporting"
                text="When it was sending data and suddenly stops."
              />
            </div>
          </div>
        )}
      </section>

      <div className="row">
        <button type="submit" disabled={edit.pending || Object.keys(pendingChanges).length === 0}>
          {edit.pending ? 'Saving…' : 'Save changes'}
        </button>
        <span className="small muted">
          {Object.keys(pendingChanges).length === 0
            ? 'No changes yet.'
            : `${Object.keys(pendingChanges).length} change${Object.keys(pendingChanges).length === 1 ? '' : 's'} to save.`}
        </span>
      </div>
      <EditError error={edit.error} />
      <Technical summary="Do the same from a terminal">
        <pre style={{ margin: 0 }}>
          <code>
            raion services set {service.name}{' '}
            {Object.entries(pendingChanges)
              .map(
                ([k, v]) =>
                  `${k}=${v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)}`,
              )
              .join(' ') || 'tier=critical'}
          </code>
        </pre>
      </Technical>

      <section
        className="card"
        aria-labelledby="remove-title"
        style={{ borderColor: '#f3c3be', marginTop: 12 }}
      >
        <div className="card-header">
          <div>
            <h2 id="remove-title">Stop monitoring {service.name}</h2>
            <span className="muted small">
              Raion forgets this application, its reliability goals and its alerts. Your application
              itself is not touched.
            </span>
          </div>
        </div>
        {!confirmRemove ? (
          <button type="button" className="secondary" onClick={() => setConfirmRemove(true)}>
            Stop monitoring…
          </button>
        ) : (
          <div className="row">
            <button
              type="button"
              className="danger"
              disabled={remove.pending}
              onClick={() => void remove.save({ kind: 'service.remove', name: service.name })}
            >
              Yes, stop monitoring {service.name}
            </button>
            <button type="button" className="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
          </div>
        )}
        <EditError error={remove.error} />
        {!isAdmin && (
          <Explain summary="Why might this be refused?">
            <p>
              If another application depends on it, Raion refuses: remove that connection first.
            </p>
          </Explain>
        )}
      </section>
    </form>
  );
}

export function Toggle({
  id,
  checked,
  onChange,
  title,
  text,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  text?: string;
}) {
  return (
    <label className="checkbox" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <strong>{title}</strong>
        {text && (
          <span className="small muted" style={{ display: 'block' }}>
            {text}
          </span>
        )}
      </span>
    </label>
  );
}
