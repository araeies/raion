import { useState } from 'react';
import { alertsApi, api, type User, type WorkspaceSummary } from '../api';
import { Diagnostics } from '../components';
import { EditError, EditResult, useEdit } from '../edits';
import {
  EmptyState,
  Explain,
  Icon,
  InfoTip,
  Loading,
  PageHeader,
  Pill,
  Technical,
  type IconName,
} from '../ui';
import { useLoad } from '../useLoad';
import { Toggle } from './Services';

type Workspace = NonNullable<WorkspaceSummary['workspace']>;
type Tab = 'general' | 'notifications' | 'teams';

const LEVELS = [
  {
    value: 1,
    title: 'Basic',
    text: 'Measurements, logs, dashboards and alerts for errors and slowness. A good start.',
  },
  {
    value: 2,
    title: 'Production',
    text: 'Adds tracing: follow each request through your applications, and see how they depend on each other.',
  },
  {
    value: 3,
    title: 'Reliability (SRE)',
    text: 'Adds reliability goals with error budgets, and alerts that fire when a goal is at risk.',
  },
];

const KEEP = ['3d', '7d', '15d', '30d', '90d'];
const keepLabel = (v: string) => v.replace('d', ' days');

/** Workspace-wide settings: level, data retention, notification channels and teams. */
export function SettingsPage({ user }: { user: User }) {
  const [tick, setTick] = useState(0);
  const result = useLoad(() => api.workspace(), `settings:${tick}`, { keepPrevious: true });
  const [tab, setTab] = useState<Tab>('general');
  const isAdmin = user.role === 'admin';
  const reload = () => setTick((t) => t + 1);
  const header = (
    <PageHeader
      title="Settings"
      description="How Raion monitors everything in this workspace, where alerts are sent, and who owns what."
    />
  );
  if (result.state === 'loading')
    return (
      <>
        {header}
        <Loading />
      </>
    );
  if (result.state === 'error' || !result.data.workspace)
    return (
      <>
        {header}
        {result.state === 'ready' && <Diagnostics diagnostics={result.data.diagnostics} />}
        {result.state === 'error' && (
          <p className="notice notice-error" role="alert">
            {result.error.message}
          </p>
        )}
      </>
    );
  const ws = result.data.workspace;
  return (
    <>
      {header}
      <Diagnostics diagnostics={result.data.diagnostics} />
      {!isAdmin && (
        <p className="notice notice-info">
          You can see these settings. Only admins can change them, because they affect everyone.
        </p>
      )}
      <div className="tabs" role="tablist" aria-label="Settings">
        {(
          [
            ['general', 'General'],
            ['notifications', `Notifications (${ws.receivers.length})`],
            ['teams', `Teams (${ws.teams.length})`],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'general' && <General ws={ws} isAdmin={isAdmin} onSaved={reload} />}
        {tab === 'notifications' && <Notifications ws={ws} isAdmin={isAdmin} onSaved={reload} />}
        {tab === 'teams' && <Teams ws={ws} isAdmin={isAdmin} onSaved={reload} />}
      </div>
    </>
  );
}

function General({
  ws,
  isAdmin,
  onSaved,
}: {
  ws: Workspace;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    level: ws.level,
    environment: ws.environment,
    metrics: ws.retention.metrics,
    logs: ws.retention.logs,
    traces: ws.retention.traces,
    host: ws.infrastructure.host,
    containers: ws.infrastructure.containers,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const edit = useEdit(onSaved);
  const changes: Record<string, unknown> = {};
  if (form.level !== ws.level) changes.level = form.level;
  if (form.environment.trim() !== ws.environment) changes.environment = form.environment.trim();
  if (form.metrics !== ws.retention.metrics) changes['retention.metrics'] = form.metrics;
  if (form.logs !== ws.retention.logs) changes['retention.logs'] = form.logs;
  if (form.traces !== ws.retention.traces) changes['retention.traces'] = form.traces;
  if (form.host !== ws.infrastructure.host) changes['infrastructure.host'] = form.host;
  if (form.containers !== ws.infrastructure.containers)
    changes['infrastructure.containers'] = form.containers;
  const count = Object.keys(changes).length;

  return (
    <form
      className="stack wide"
      onSubmit={(e) => {
        e.preventDefault();
        void edit.save({ kind: 'workspace.update', set: changes });
      }}
    >
      <EditResult view={edit.saved} />
      <fieldset className="card" disabled={!isAdmin} style={{ margin: 0 }}>
        <div className="card-header">
          <div>
            <h2>How much Raion sets up</h2>
            <span className="muted small">
              For every application, unless an application sets its own.
            </span>
          </div>
        </div>
        <div className="choices">
          {LEVELS.map((l) => (
            <label className="choice" key={l.value}>
              <input
                type="radio"
                name="level"
                checked={form.level === l.value}
                onChange={() => set('level', l.value)}
              />
              <span className="choice-title">
                {l.title}
                {l.value === 2 && <Pill tone="accent">Recommended</Pill>}
              </span>
              <small>{l.text}</small>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="card" disabled={!isAdmin} style={{ margin: 0 }}>
        <div className="card-header">
          <div>
            <h2>
              How long to keep data{' '}
              <InfoTip label="data retention">
                Older data is deleted automatically. Keeping data longer lets you look further back,
                but uses more disk space.
              </InfoTip>
            </h2>
            <span className="muted small">
              Measurements are always kept long enough for your reliability goals.
            </span>
          </div>
        </div>
        <div className="grid">
          {(
            [
              ['metrics', 'Measurements'],
              ['logs', 'Logs'],
              ['traces', 'Traces'],
            ] as const
          ).map(([k, label]) => (
            <div className="field" key={k}>
              <label htmlFor={`keep-${k}`}>{label}</label>
              <select id={`keep-${k}`} value={form[k]} onChange={(e) => set(k, e.target.value)}>
                {[...new Set([...KEEP, form[k]])].map((v) => (
                  <option key={v} value={v}>
                    {keepLabel(v)}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="card" disabled={!isAdmin} style={{ margin: 0 }}>
        <div className="card-header">
          <h2>This machine</h2>
        </div>
        <div className="stack">
          <Toggle
            id="infra-host"
            checked={form.host}
            onChange={(v) => set('host', v)}
            title="Monitor this machine"
            text="Processor, memory, disk and network, with alerts before the disk fills up."
          />
          <Toggle
            id="infra-containers"
            checked={form.containers}
            onChange={(v) => set('containers', v)}
            title="Monitor each container"
            text="CPU and memory per Docker container. Needs extra access to the machine, so deploying it needs an admin's approval."
          />
          <div className="field" style={{ maxWidth: 320 }}>
            <label htmlFor="ws-env">
              Environment name{' '}
              <InfoTip label="the environment">
                A label on all data, such as production or staging, so data from different
                environments is never mixed.
              </InfoTip>
            </label>
            <input
              id="ws-env"
              value={form.environment}
              onChange={(e) => set('environment', e.target.value)}
            />
          </div>
        </div>
      </fieldset>

      {isAdmin && (
        <div className="row">
          <button type="submit" disabled={edit.pending || count === 0}>
            {edit.pending ? 'Saving…' : 'Save changes'}
          </button>
          <span className="small muted">
            {count === 0 ? 'No changes yet.' : `${count} change${count === 1 ? '' : 's'} to save.`}
          </span>
        </div>
      )}
      <EditError error={edit.error} />
      <Technical summary="Do the same from a terminal">
        <pre style={{ margin: 0 }}>
          <code>raion settings level=3 retention.logs=14d</code>
        </pre>
      </Technical>
    </form>
  );
}

const CHANNEL: Record<
  'slack' | 'email' | 'webhook',
  { title: string; icon: IconName; text: string }
> = {
  slack: { title: 'Slack', icon: 'bell', text: 'Posts alerts to a Slack channel.' },
  email: {
    title: 'Email',
    icon: 'scroll',
    text: 'Sends alerts by email through your mail server.',
  },
  webhook: {
    title: 'Webhook',
    icon: 'code',
    text: 'Calls an address, e.g. an incident tool such as PagerDuty or Opsgenie.',
  },
};

const secretName = (name: string, what: string) =>
  `${name}_${what}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

function Notifications({
  ws,
  isAdmin,
  onSaved,
}: {
  ws: Workspace;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const edit = useEdit(onSaved);
  const [adding, setAdding] = useState(false);
  return (
    <div className="stack">
      <div className="notice notice-info callout">
        <Icon name="bell" />
        <div>
          Every alert always appears on the <strong>Alerts</strong> page. Notification channels also
          send them to where your team works. Teams can have their own channel (Teams tab).
        </div>
      </div>
      <EditResult view={edit.saved} />
      <EditError error={edit.error} />
      {ws.receivers.length === 0 && !adding ? (
        <EmptyState
          icon="bell"
          title="No notification channels yet"
          action={
            isAdmin ? (
              <button type="button" onClick={() => setAdding(true)}>
                <Icon name="plus" /> Add a channel
              </button>
            ) : undefined
          }
        >
          Add Slack, email or a webhook so people hear about alerts without opening Raion.
        </EmptyState>
      ) : (
        <section className="card">
          <div className="card-header">
            <h2>Channels</h2>
            {isAdmin && !adding && (
              <button type="button" className="secondary small" onClick={() => setAdding(true)}>
                <Icon name="plus" /> Add a channel
              </button>
            )}
          </div>
          <ul className="checklist">
            {ws.receivers.map((r) => (
              <li key={r.name}>
                <span className="app-icon" aria-hidden="true">
                  <Icon name={CHANNEL[r.type].icon} />
                </span>
                <div style={{ flex: 1 }}>
                  <strong>{r.name}</strong>
                  <div className="small muted">
                    {CHANNEL[r.type].title}
                    {ws.defaultReceiver === r.name ? ' · receives alerts no team claims' : ''}
                  </div>
                </div>
                {isAdmin && (
                  <div className="row">
                    {ws.defaultReceiver !== r.name && (
                      <button
                        type="button"
                        className="ghost small"
                        onClick={() =>
                          void edit.save({
                            kind: 'workspace.update',
                            set: { 'notifications.defaultReceiver': r.name },
                          })
                        }
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => void edit.save({ kind: 'receiver.remove', name: r.name })}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {adding && <AddChannel onDone={() => setAdding(false)} onSaved={onSaved} />}
    </div>
  );
}

function AddChannel({ onDone, onSaved }: { onDone: () => void; onSaved: () => void }) {
  const [type, setType] = useState<'slack' | 'email' | 'webhook'>('slack');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [channel, setChannel] = useState('');
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [smarthost, setSmarthost] = useState('');
  const [username, setUsername] = useState('');
  const [url, setUrl] = useState('');
  const edit = useEdit(() => {
    onSaved();
    onDone();
  });
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const submit = async () => {
    let receiver: Record<string, unknown>;
    if (type === 'slack') {
      const key = secretName(slug, 'webhook');
      await alertsApi.setSecret(key, secret);
      receiver = {
        name: slug,
        type,
        webhookUrl: `\${secret:${key}}`,
        ...(channel ? { channel } : {}),
      };
    } else if (type === 'email') {
      const key = secretName(slug, 'password');
      if (secret) await alertsApi.setSecret(key, secret);
      receiver = {
        name: slug,
        type,
        to: to.split(/[\s,]+/).filter(Boolean),
        from,
        smarthost,
        ...(username ? { username } : {}),
        ...(secret ? { password: `\${secret:${key}}` } : {}),
      };
    } else {
      const key = secretName(slug, 'token');
      if (secret) await alertsApi.setSecret(key, secret);
      receiver = { name: slug, type, url, ...(secret ? { bearerToken: `\${secret:${key}}` } : {}) };
    }
    await edit.save({ kind: 'receiver.add', receiver });
  };
  return (
    <form
      className="card stack wide"
      onSubmit={(e) => {
        e.preventDefault();
        void submit().catch(() => undefined);
      }}
    >
      <h2 style={{ margin: 0 }}>Add a notification channel</h2>
      <div className="choices">
        {(Object.keys(CHANNEL) as (keyof typeof CHANNEL)[]).map((t) => (
          <label className="choice" key={t}>
            <input
              type="radio"
              name="channel-type"
              checked={type === t}
              onChange={() => setType(t)}
            />
            <span className="choice-title">
              <Icon name={CHANNEL[t].icon} /> {CHANNEL[t].title}
            </span>
            <small>{CHANNEL[t].text}</small>
          </label>
        ))}
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="ch-name">Name</label>
          <input
            id="ch-name"
            value={name}
            placeholder="e.g. ops-slack"
            onChange={(e) => setName(e.target.value)}
          />
          {slug && slug !== name && <small className="hint">Saved as {slug}.</small>}
        </div>
        {type === 'slack' && (
          <>
            <div className="field">
              <label htmlFor="ch-secret">Slack webhook address</label>
              <input
                id="ch-secret"
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <small className="hint">
                From Slack: <em>Apps → Incoming Webhooks → Add to Slack</em>. Stored securely, never
                in your files.
              </small>
            </div>
            <div className="field">
              <label htmlFor="ch-channel">Channel (optional)</label>
              <input
                id="ch-channel"
                value={channel}
                placeholder="#ops"
                onChange={(e) => setChannel(e.target.value)}
              />
            </div>
          </>
        )}
        {type === 'email' && (
          <>
            <div className="field">
              <label htmlFor="ch-to">Send to</label>
              <input
                id="ch-to"
                value={to}
                placeholder="ops@example.com, oncall@example.com"
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="ch-from">From</label>
              <input
                id="ch-from"
                value={from}
                placeholder="raion@example.com"
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="ch-smarthost">Mail server</label>
              <input
                id="ch-smarthost"
                value={smarthost}
                placeholder="smtp.example.com:587"
                onChange={(e) => setSmarthost(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="ch-user">Mail user (optional)</label>
              <input id="ch-user" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="ch-secret">Mail password (optional)</label>
              <input
                id="ch-secret"
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </div>
          </>
        )}
        {type === 'webhook' && (
          <>
            <div className="field">
              <label htmlFor="ch-url">Address to call</label>
              <input
                id="ch-url"
                value={url}
                placeholder="https://events.example.com/raion"
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="ch-secret">Access token (optional)</label>
              <input
                id="ch-secret"
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
            </div>
          </>
        )}
      </div>
      <Explain summary="Where is the secret stored?">
        <p>
          Webhook addresses, passwords and tokens are stored by Raion on this server, readable only
          by Raion. Your workspace files only contain a reference to them, so they are safe to share
          or put in Git.
        </p>
      </Explain>
      <EditError error={edit.error} />
      <div className="row">
        <button type="submit" disabled={edit.pending || !slug}>
          {edit.pending ? 'Adding…' : 'Add channel'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Teams({ ws, isAdmin, onSaved }: { ws: Workspace; isAdmin: boolean; onSaved: () => void }) {
  const edit = useEdit(onSaved);
  const [name, setName] = useState('');
  return (
    <div className="stack">
      <EditResult view={edit.saved} />
      <EditError error={edit.error} />
      <section className="card">
        <div className="card-header">
          <div>
            <h2>Teams</h2>
            <span className="muted small">
              A team owns applications. Its alerts can go to its own notification channel.
              {ws.level < 3 && ' Routing alerts per team is part of the Reliability (SRE) level.'}
            </span>
          </div>
        </div>
        {ws.teams.length === 0 ? (
          <p className="muted">No teams yet.</p>
        ) : (
          <ul className="checklist">
            {ws.teams.map((t) => (
              <li key={t.name}>
                <span className="app-icon" aria-hidden="true">
                  <Icon name="users" />
                </span>
                <div style={{ flex: 1 }}>
                  <strong>{t.name}</strong>
                  <div className="small muted">
                    Alerts go to: {t.route ?? 'the Alerts page only'}
                  </div>
                </div>
                {isAdmin && (
                  <div className="row">
                    <label className="visually-hidden" htmlFor={`route-${t.name}`}>
                      Channel for {t.name}
                    </label>
                    <select
                      id={`route-${t.name}`}
                      value={t.route ?? ''}
                      style={{ minWidth: 160 }}
                      onChange={(e) =>
                        void edit.save({
                          kind: 'team.update',
                          name: t.name,
                          set: { route: e.target.value || null },
                        })
                      }
                    >
                      <option value="">Alerts page only</option>
                      {ws.receivers.map((r) => (
                        <option key={r.name} value={r.name}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => void edit.save({ kind: 'team.remove', name: t.name })}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {isAdmin && (
          <form
            className="inline-form"
            style={{ marginTop: 16 }}
            onSubmit={(e) => {
              e.preventDefault();
              const slug = name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
              void edit
                .save({ kind: 'team.add', team: { name: slug } })
                .then((v) => v && setName(''));
            }}
          >
            <div className="field">
              <label htmlFor="team-name">New team</label>
              <input
                id="team-name"
                value={name}
                placeholder="e.g. payments"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <button type="submit" disabled={!name.trim() || edit.pending}>
              Add team
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
