import { useEffect, useState } from 'react';
import { runtimeApi, type Job, type JobSummary, type RuntimeOverview, type User } from '../api';
import { ErrorMessage } from '../components';
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
  Technical,
  timeAgo,
  type Tone,
} from '../ui';
import { useLoad } from '../useLoad';
import { SecretsSection } from './Alerts';

/** What each component is, in plain words. */
const COMPONENTS: Record<string, { name: string; role: string }> = {
  'otel-collector': {
    name: 'Collector',
    role: "Receives your applications' metrics, logs and traces, and passes them on for storage.",
  },
  prometheus: {
    name: 'Metrics storage',
    role: 'Keeps numbers over time (requests, errors, response times) and checks the alert rules.',
  },
  loki: { name: 'Log storage', role: "Keeps your applications' log lines, searchable by time." },
  tempo: {
    name: 'Trace storage',
    role: 'Keeps traces: the path of each request through your applications, step by step.',
  },
  grafana: { name: 'Dashboards', role: 'Shows charts of everything Raion collects.' },
  alertmanager: {
    name: 'Alert delivery',
    role: 'Groups alerts and sends them to Slack, email or webhooks, if you set any up.',
  },
  'node-exporter': {
    name: 'Machine monitor',
    role: "Measures this machine's processor, memory, disk and network.",
  },
  cadvisor: { name: 'Container monitor', role: 'Measures the CPU and memory of each container.' },
  gateway: {
    name: 'Secure gateway',
    role: 'The only way into the stack. Only Raion holds its key.',
  },
};

const OPERATION_LABEL: Record<Job['kind'], string> = {
  apply: 'Deploy',
  rollback: 'Roll back',
  repair: 'Restore',
  destroy: 'Stop',
  verify: 'Pipeline test',
  connect: 'Connect an application',
};

const STATE_TONE: Record<Job['state'], { tone: Tone; label: string }> = {
  running: { tone: 'info', label: 'Running' },
  succeeded: { tone: 'ok', label: 'Succeeded' },
  failed: { tone: 'crit', label: 'Failed' },
  interrupted: { tone: 'warn', label: 'Interrupted' },
};

const where = (via: Job['via']) =>
  via === 'cli' ? 'command line' : via === 'api' ? 'API' : 'web UI';

const ACTION_LABEL: Record<string, string> = {
  add: 'will start',
  remove: 'will stop',
  recreate: 'will be recreated',
  restart: 'will restart',
};

type Tab = 'components' | 'changes' | 'activity' | 'releases' | 'secrets' | 'advanced';

export function RuntimePage({ user }: { user: User }) {
  const overview = useLoad(() => runtimeApi.overview(), 'runtime', { keepPrevious: true });
  const [startedJob, setJobId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('components');
  const [activityTick, setActivityTick] = useState(0);
  // Also follow an operation started elsewhere (another person, or the CLI).
  const jobId = startedJob ?? (overview.state === 'ready' ? overview.data.runningJob : null);

  if (overview.state === 'loading') return <Loading label="Checking the observability stack…" />;
  if (overview.state === 'error')
    return (
      <p className="notice notice-error" role="alert">
        Could not load the observability stack: {overview.error.message}
      </p>
    );
  const data = overview.data;
  const canEdit = user.role !== 'viewer';
  const isAdmin = user.role === 'admin';
  const busy = jobId !== null;
  const pending = !data.plan.noChanges || !data.status.deployed;

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'components', label: 'Components', show: true },
    { id: 'changes', label: pending ? 'Changes to deploy •' : 'Changes to deploy', show: true },
    { id: 'activity', label: 'Activity', show: true },
    { id: 'releases', label: `Releases (${data.releases.length})`, show: data.releases.length > 0 },
    { id: 'secrets', label: 'Secrets', show: isAdmin },
    { id: 'advanced', label: 'Advanced', show: true },
  ];

  return (
    <>
      <PageHeader
        title="Observability stack"
        description="The open-source tools Raion runs for you to collect, store and show your monitoring data. Raion sets them up from your workspace and keeps them healthy."
        actions={
          <>
            {canEdit && data.status.deployed && (
              <VerifyButton onStarted={setJobId} disabled={busy} />
            )}
            {data.status.deployed && (
              <a className="button secondary" href={data.grafanaUrl} target="_blank" rel="noopener">
                <Icon name="chart" /> Open dashboards
              </a>
            )}
          </>
        }
      />

      <StatusCard data={data} />

      {jobId && (
        <JobPanel
          id={jobId}
          onDone={() => {
            setJobId(null);
            setActivityTick((t) => t + 1);
            overview.reload();
          }}
        />
      )}

      {data.drift.items.length > 0 && (
        <DriftNotice drift={data.drift} canRepair={canEdit && !busy} onStarted={setJobId} />
      )}

      <div
        className="tabs"
        role="tablist"
        aria-label="Observability stack"
        style={{ marginTop: 24 }}
      >
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
        {tab === 'components' && <Components data={data} />}
        {tab === 'changes' && (
          <PlanSection data={data} user={user} disabled={busy} onStarted={setJobId} />
        )}
        {tab === 'activity' && <Activity key={activityTick} />}
        {tab === 'releases' && (
          <Releases data={data} canRollBack={canEdit && !busy} onStarted={setJobId} />
        )}
        {tab === 'secrets' && <SecretsSection />}
        {tab === 'advanced' && (
          <Advanced data={data} isAdmin={isAdmin} busy={busy} onStarted={setJobId} />
        )}
      </div>
    </>
  );
}

function StatusCard({ data }: { data: RuntimeOverview }) {
  const deployed = data.status.deployed;
  if (!deployed) {
    return (
      <div className="notice notice-info callout">
        <Icon name="rocket" />
        <div>
          <strong>Raion is not running yet.</strong> Open <em>Changes to deploy</em> below and
          deploy: Raion downloads and starts the tools (the first time takes a few minutes) and
          checks each one works.
        </div>
      </div>
    );
  }
  const healthy = data.status.healthy;
  return (
    <div
      className={`notice ${healthy ? 'notice-ok' : 'notice-error'} callout`}
      role={healthy ? undefined : 'alert'}
    >
      <Icon name={healthy ? 'ok' : 'alert'} />
      <div style={{ flex: 1 }}>
        <div className="spread">
          <strong>{healthy ? 'Everything is running' : 'Something needs attention'}</strong>
          <Pill tone={healthy ? 'ok' : 'crit'} live={healthy}>
            {healthy ? 'Healthy' : 'Unhealthy'}
          </Pill>
        </div>
        <p style={{ margin: '4px 0 0' }}>
          {healthy
            ? 'Every component is running and ready.'
            : 'At least one component is not running or not ready. The Components tab shows which.'}{' '}
          <span className="muted">
            Release <code>{deployed.id}</code>, deployed {timeAgo(deployed.createdAt)} by{' '}
            {deployed.createdBy}.
          </span>
        </p>
      </div>
    </div>
  );
}

function Components({ data }: { data: RuntimeOverview }) {
  return (
    <div className="stack">
      <div className="grid">
        {data.components.map((c) => {
          const s = data.status.components.find((x) => x.component === c.id);
          const ok = s?.state === 'running' && s.ready !== false;
          const info = COMPONENTS[c.id];
          return (
            <div className="card" key={c.id}>
              <div className="spread">
                <strong>{info?.name ?? c.id}</strong>
                <Pill tone={!s ? 'neutral' : ok ? 'ok' : 'crit'}>
                  {!s ? 'Not started' : ok ? 'Healthy' : s.ready === false ? 'Not ready' : s.state}
                </Pill>
              </div>
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                {info?.role ?? c.purpose}
              </p>
              {!ok && s?.detail && (
                <p className="small" style={{ margin: '8px 0 0', color: 'var(--crit)' }}>
                  {s.detail.split('\n')[0]}
                </p>
              )}
              <Technical>
                <p className="small" style={{ margin: 0 }}>
                  <code>{c.id}</code>: {c.purpose}
                </p>
                {c.privileges.length > 0 && (
                  <p className="small" style={{ margin: '6px 0 0' }}>
                    Extra access it needs: {c.privileges.join('; ')}
                  </p>
                )}
              </Technical>
            </div>
          );
        })}
      </div>
      {data.status.scrapeTargets && (
        <section className="card" aria-labelledby="scrape-title">
          <div className="card-header">
            <h2 id="scrape-title">
              Raion watching itself{' '}
              <InfoTip label="self-monitoring">
                Raion's metrics storage checks every component every 15 seconds. If a check fails,
                part of the monitoring itself is broken, and Raion raises an alert.
              </InfoTip>
            </h2>
          </div>
          <div className="row">
            {data.status.scrapeTargets.map((t) => (
              <span key={t.job} title={t.lastError || undefined}>
                <Pill tone={t.health === 'up' ? 'ok' : 'crit'}>
                  {COMPONENTS[t.job]?.name ?? t.job}
                </Pill>
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function PlanSection(props: {
  data: RuntimeOverview;
  user: User;
  disabled: boolean;
  onStarted: (id: string) => void;
}) {
  const { plan } = props.data;
  const [allowPrivileged, setAllowPrivileged] = useState(false);
  const [allowDataChanges, setAllowDataChanges] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const changed = plan.components.filter((c) => c.action !== 'unchanged');
  const gated = plan.securityRelevant.length > 0 || plan.dataAffecting.length > 0;
  const isAdmin = props.user.role === 'admin';
  const canApply = props.user.role !== 'viewer' && (!gated || isAdmin);
  const deployed = Boolean(props.data.status.deployed);

  const apply = async () => {
    setError(null);
    try {
      const { job } = await runtimeApi.apply({ allowPrivileged, allowDataChanges });
      props.onStarted(job);
    } catch (err) {
      setError(err);
    }
  };

  if (plan.noChanges && deployed) {
    return (
      <EmptyState icon="ok" title="Nothing to deploy">
        What is running matches your workspace. When you change something (add an application, a
        reliability goal, a notification channel), the changes appear here.
      </EmptyState>
    );
  }

  return (
    <section className="card" aria-labelledby="plan-title">
      <div className="card-header">
        <div>
          <h2 id="plan-title">{deployed ? 'Changes to deploy' : 'Start monitoring'}</h2>
          <span className="muted small">
            {deployed
              ? 'Your workspace changed since the last deployment. Deploying applies these changes.'
              : 'Deploying starts these components on this machine.'}
          </span>
        </div>
      </div>
      {changed.length > 0 && (
        <ul className="checklist">
          {changed.map((c) => (
            <li key={c.component}>
              <Icon name="box" />
              <div>
                <strong>{COMPONENTS[c.component]?.name ?? c.component}</strong>{' '}
                {ACTION_LABEL[c.action] ?? c.action}
                {c.reasons.length > 0 && <div className="small muted">{c.reasons.join(', ')}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Technical summary={`Changed configuration files (${plan.files.length})`}>
        <ul className="small" style={{ margin: 0, paddingLeft: '1.2em' }}>
          {plan.files.map((f) => (
            <li key={f.path}>
              <code>
                {f.change === 'add' ? '+' : f.change === 'remove' ? '−' : '~'} {f.path}
              </code>{' '}
              <span className="muted">{f.description}</span>
            </li>
          ))}
        </ul>
      </Technical>
      {plan.notes.map((n, i) => (
        <p key={i} className={`small ${n.severity === 'warning' ? '' : 'muted'}`}>
          {n.message}
        </p>
      ))}
      {plan.hostAccess.length > 0 && (
        <Explain summary="Why does Raion read this machine?">
          <p>
            To measure the machine's processor, memory and disk, one component reads (never
            changes): {plan.hostAccess.join('; ')}.
          </p>
        </Explain>
      )}
      {plan.securityRelevant.length > 0 && (
        <div className="notice notice-warning" style={{ marginTop: 14 }}>
          <h3>This needs extra access to the machine</h3>
          <ul>
            {plan.securityRelevant.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {isAdmin ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={allowPrivileged}
                onChange={(e) => setAllowPrivileged(e.target.checked)}
              />
              I approve this access
            </label>
          ) : (
            <p className="small">An admin must approve and deploy this change.</p>
          )}
        </div>
      )}
      {plan.dataAffecting.length > 0 && (
        <div className="notice notice-warning" style={{ marginTop: 14 }}>
          <h3>This affects stored data</h3>
          <ul>
            {plan.dataAffecting.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {isAdmin ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={allowDataChanges}
                onChange={(e) => setAllowDataChanges(e.target.checked)}
              />
              I understand some stored data may be lost
            </label>
          ) : (
            <p className="small">An admin must approve and deploy this change.</p>
          )}
        </div>
      )}
      <ErrorMessage error={error} />
      {canApply && (
        <div className="row" style={{ marginTop: 16 }}>
          <button type="button" disabled={props.disabled} onClick={() => void apply()}>
            <Icon name="rocket" />{' '}
            {deployed ? 'Deploy these changes' : 'Deploy and start monitoring'}
          </button>
          <span className="small muted">
            Raion checks every configuration file first, and puts the previous version back if
            anything fails.
          </span>
        </div>
      )}
      <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
        From a terminal: <code>raion plan</code>, then <code>raion apply</code>.
      </p>
    </section>
  );
}

/** Deployments, restores and tests from every interface: this page, the API and the CLI. */
function Activity() {
  const result = useLoad(() => runtimeApi.jobs(), 'activity');
  const [open, setOpen] = useState<string | null>(null);
  if (result.state === 'loading') return <Loading />;
  if (result.state === 'error') return <ErrorMessage error={result.error} />;
  const jobs = result.data.jobs;
  if (jobs.length === 0)
    return (
      <EmptyState icon="clock" title="Nothing has run yet">
        Deployments, restores and pipeline tests appear here, whether they were started on this page
        or with the <code>raion</code> command.
      </EmptyState>
    );
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Everything that changed or tested the stack, from this page and from the command line (
        <code>raion activity</code> shows the same list).
      </p>
      <div className="table-wrap">
        <table>
          <caption className="visually-hidden">Recent operations</caption>
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Result</th>
              <th scope="col">Who</th>
              <th scope="col">When</th>
              <th scope="col">
                <span className="visually-hidden">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <ActivityRow
                key={j.id}
                job={j}
                open={open === j.id}
                onToggle={() => setOpen(open === j.id ? null : j.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActivityRow({
  job,
  open,
  onToggle,
}: {
  job: JobSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const state = STATE_TONE[job.state];
  return (
    <>
      <tr>
        <th scope="row">{OPERATION_LABEL[job.kind]}</th>
        <td>
          <Pill tone={state.tone}>{state.label}</Pill>
          {job.error && <div className="small muted">{job.error}</div>}
        </td>
        <td>
          {job.actor}
          <div className="small muted">from the {where(job.via)}</div>
        </td>
        <td className="nowrap">
          {timeAgo(job.startedAt)}
          <div className="small muted">
            {job.finishedAt ? `took ${duration(job.startedAt, job.finishedAt)}` : 'still running'}
          </div>
        </td>
        <td>
          <button type="button" className="ghost small" aria-expanded={open} onClick={onToggle}>
            {open ? 'Hide log' : 'Log'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
            <JobLog id={job.id} />
          </td>
        </tr>
      )}
    </>
  );
}

function JobLog({ id }: { id: string }) {
  const job = useLoad(() => runtimeApi.job(id), `job:${id}`);
  if (job.state !== 'ready') return <Loading label="Loading the log…" />;
  return (
    <pre className="job-log" style={{ margin: 0 }}>
      {job.data.log.join('\n') || '(no output)'}
    </pre>
  );
}

function Releases({
  data,
  canRollBack,
  onStarted,
}: {
  data: RuntimeOverview;
  canRollBack: boolean;
  onStarted: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const current = data.status.deployed?.id;
  return (
    <section className="card" aria-labelledby="releases-title">
      <div className="card-header">
        <div>
          <h2 id="releases-title">
            Releases{' '}
            <InfoTip label="a release">
              Every deployment is saved as a release: the exact configuration that ran. You can go
              back to an earlier one if a change caused problems.
            </InfoTip>
          </h2>
          <span className="muted small">Newest first.</span>
        </div>
      </div>
      <ErrorMessage error={error} />
      <ul className="checklist">
        {data.releases.map((r) => (
          <li key={r.id}>
            <div style={{ flex: 1 }}>
              <div className="row">
                <code>{r.id}</code>
                {r.id === current && <Pill tone="ok">Running now</Pill>}
              </div>
              <span className="small muted">
                {dateTime(r.createdAt)} by {r.createdBy}
              </span>
              {confirming === r.id && (
                <div className="notice notice-warning" style={{ margin: '10px 0 0' }}>
                  <p>
                    Raion will run release <code>{r.id}</code> again. Your workspace files are not
                    changed, so the next deployment brings back what they describe.
                  </p>
                  <div className="row">
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        runtimeApi.rollback(r.id).then(({ job }) => {
                          setConfirming(null);
                          onStarted(job);
                        }, setError);
                      }}
                    >
                      Roll back
                    </button>
                    <button type="button" className="ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
            {canRollBack && r.id !== current && confirming !== r.id && (
              <button type="button" className="secondary small" onClick={() => setConfirming(r.id)}>
                Roll back to this
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="small muted" style={{ margin: '12px 0 0' }}>
        From a terminal: <code>raion rollback --to &lt;release&gt;</code>.
      </p>
    </section>
  );
}

function Advanced({
  data,
  isAdmin,
  busy,
  onStarted,
}: {
  data: RuntimeOverview;
  isAdmin: boolean;
  busy: boolean;
  onStarted: (id: string) => void;
}) {
  return (
    <div className="stack">
      <section className="card" aria-labelledby="otlp-title">
        <div className="card-header">
          <h2 id="otlp-title">
            Where applications send data{' '}
            <InfoTip label="OTLP">
              OpenTelemetry (OTLP) is the standard way applications send metrics, logs and traces.
              Raion sets it up for the applications you add; these addresses are for anything else.
            </InfoTip>
          </h2>
        </div>
        <dl className="properties">
          <dt>From this machine (gRPC)</dt>
          <dd>
            <code>{data.otlp.grpc}</code>
          </dd>
          <dt>From this machine (HTTP)</dt>
          <dd>
            <code>{data.otlp.http}</code>
          </dd>
          <dt>From Docker containers</dt>
          <dd>
            <code>otel-collector:4317</code> on the <code>{data.ingestNetwork}</code> network
          </dd>
        </dl>
      </section>

      <section className="card" aria-labelledby="config-title">
        <div className="card-header">
          <div>
            <h2 id="config-title">Generated configuration</h2>
            <span className="muted small">
              The standard configuration files Raion writes for each tool, from your workspace. To
              change them, change your workspace and deploy.
            </span>
          </div>
        </div>
        {data.files.map((f) => (
          <GeneratedFile key={f.path} path={f.path} description={f.description} />
        ))}
      </section>

      {isAdmin && data.status.deployed && <StopSection busy={busy} onStarted={onStarted} />}
    </div>
  );
}

function StopSection({ busy, onStarted }: { busy: boolean; onStarted: (id: string) => void }) {
  const [deleteData, setDeleteData] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <section className="card" aria-labelledby="stop-title" style={{ borderColor: '#f3c3be' }}>
      <div className="card-header">
        <div>
          <h2 id="stop-title">Stop monitoring</h2>
          <span className="muted small">
            Stops every component. Nothing is monitored and no alerts fire until you deploy again.
          </span>
        </div>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={deleteData}
          onChange={(e) => setDeleteData(e.target.checked)}
        />
        <span>
          Also delete all stored data (metrics, logs, traces and dashboards settings). This cannot
          be undone.
        </span>
      </label>
      {deleteData && (
        <div className="field" style={{ marginTop: 10, maxWidth: 360 }}>
          <label htmlFor="stop-confirm">Type the workspace name to confirm</label>
          <input id="stop-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
      )}
      <ErrorMessage error={error} />
      <div className="row" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            setError(null);
            runtimeApi
              .stop(deleteData, deleteData ? confirm : undefined)
              .then(({ job }) => onStarted(job), setError);
          }}
        >
          {deleteData ? 'Stop and delete data' : 'Stop the stack'}
        </button>
        <span className="small muted">
          From a terminal: <code>raion destroy</code>
        </span>
      </div>
    </section>
  );
}

const DRIFT_LABELS: Record<string, string> = {
  'file-modified': 'A configuration file was edited',
  'file-missing': 'A configuration file is missing',
  'file-extra': 'An unexpected file was added',
  'component-missing': 'A component is missing',
  'component-stopped': 'A component was stopped',
  'component-extra': 'An unexpected container is running',
  'image-changed': 'A component runs a different version',
};

/** Changes made to the running stack outside Raion, and a way to undo them. */
function DriftNotice({
  drift,
  canRepair,
  onStarted,
}: {
  drift: RuntimeOverview['drift'];
  canRepair: boolean;
  onStarted: (id: string) => void;
}) {
  const [error, setError] = useState<unknown>(null);
  return (
    <section className="notice notice-warning callout" aria-labelledby="drift-title">
      <Icon name="alert" />
      <div style={{ flex: 1 }}>
        <h2 id="drift-title">Something was changed outside Raion</h2>
        <p>
          What is running no longer matches release <code>{drift.release}</code>. Raion can put it
          back exactly as it was deployed.
        </p>
        <ul>
          {drift.items.map((item) => (
            <li key={`${item.kind}:${item.subject}`}>
              <strong>{DRIFT_LABELS[item.kind] ?? item.kind}:</strong>{' '}
              {COMPONENTS[item.subject]?.name ?? <code>{item.subject}</code>}{' '}
              <span className="muted small">({item.detail})</span>
            </li>
          ))}
        </ul>
        {canRepair && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              runtimeApi.repair().then(({ job }) => onStarted(job), setError);
            }}
          >
            Restore release {drift.release}
          </button>
        )}
        <ErrorMessage error={error} />
      </div>
    </section>
  );
}

function VerifyButton({
  onStarted,
  disabled,
}: {
  onStarted: (id: string) => void;
  disabled: boolean;
}) {
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={disabled}
        title="Sends a test metric, log line and trace, and checks each one is stored"
        onClick={() => {
          setError(null);
          runtimeApi.verify().then(({ job }) => onStarted(job), setError);
        }}
      >
        <Icon name="check" /> Test the pipeline
      </button>
      <ErrorMessage error={error} />
    </>
  );
}

/** Follows an operation while it runs, wherever it was started. */
function JobPanel({ id, onDone }: { id: string; onDone: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const next = await runtimeApi.job(id);
        if (stopped) return;
        setJob(next);
        if (next.state === 'running') setTimeout(() => void poll(), 1500);
      } catch {
        if (!stopped) setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [id]);

  const state = job ? STATE_TONE[job.state] : { tone: 'info' as Tone, label: 'Starting' };
  const tone =
    job?.state === 'failed' || job?.state === 'interrupted'
      ? 'notice-error'
      : job?.state === 'succeeded'
        ? 'notice-ok'
        : 'notice-info';
  return (
    <section className={`notice ${tone}`} aria-live="polite" style={{ marginTop: 16 }}>
      <div className="spread">
        <h2 style={{ margin: 0 }}>
          {job ? OPERATION_LABEL[job.kind] : 'Operation'}
          {job && (
            <span className="small muted" style={{ fontWeight: 500 }}>
              {' '}
              · started by {job.actor} from the {where(job.via)}
            </span>
          )}
        </h2>
        <Pill tone={state.tone} live={job?.state === 'running'}>
          {state.label}
        </Pill>
      </div>
      <pre className="job-log" style={{ margin: '12px 0' }}>
        {job?.log.join('\n') || 'Starting…'}
      </pre>
      {job?.error && <p className="form-error">{job.error}</p>}
      {job?.state === 'interrupted' && (
        <p className="small">
          The process running it stopped before it finished. Check the Components tab, then deploy
          again if needed.
        </p>
      )}
      {job && job.state !== 'running' && (
        <button type="button" className="secondary" onClick={onDone}>
          Close
        </button>
      )}
    </section>
  );
}

function GeneratedFile({ path, description }: { path: string; description: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <details
      className="technical"
      onToggle={(e) => {
        if (e.currentTarget.open && content === null) {
          runtimeApi.file(path).then((f) => setContent(f.content), setError);
        }
      }}
    >
      <summary>
        <code>{path}</code> <span className="muted small">{description}</span>
      </summary>
      <div className="technical-body">
        <ErrorMessage error={error} />
        {content !== null ? (
          <pre style={{ margin: 0 }}>
            <code>{content || '(empty file)'}</code>
          </pre>
        ) : (
          !error && <Loading />
        )}
      </div>
    </details>
  );
}
