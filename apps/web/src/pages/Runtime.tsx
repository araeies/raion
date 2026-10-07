import { useEffect, useState } from 'react';
import { runtimeApi, type Job, type RuntimeOverview, type User } from '../api';
import { Disclosure, ErrorMessage } from '../components';
import { useLoad } from '../useLoad';
import { SecretsSection } from './Alerts';

const ACTION_LABEL: Record<string, string> = {
  add: 'will start',
  remove: 'will stop',
  recreate: 'will be recreated',
  restart: 'will restart',
};

export function RuntimePage({ user }: { user: User }) {
  const overview = useLoad(() => runtimeApi.overview(), 'runtime');
  const [startedJob, setJobId] = useState<string | null>(null);
  // Show a job someone else started, too (the server runs one at a time).
  const jobId = startedJob ?? (overview.state === 'ready' ? overview.data.runningJob : null);

  if (overview.state === 'loading') return <p aria-busy="true">Loading the observability stack…</p>;
  if (overview.state === 'error')
    return <p role="alert">Could not load the runtime: {overview.error.message}</p>;
  const data = overview.data;
  const canEdit = user.role === 'editor' || user.role === 'admin';

  return (
    <>
      <h1>Observability stack</h1>
      <p className="lead">
        These open-source components collect, store and display your telemetry. Raion generates
        their configuration from your workspace and keeps them running.
      </p>
      <StatusBanner data={data} />

      <div className="actions">
        {data.status.deployed && (
          <a className="button" href={data.grafanaUrl} target="_blank" rel="noopener">
            Open Grafana
          </a>
        )}
        {canEdit && data.status.deployed && (
          <VerifyButton onStarted={setJobId} disabled={jobId !== null} />
        )}
      </div>

      {data.drift.items.length > 0 && (
        <DriftNotice
          drift={data.drift}
          canRepair={canEdit && jobId === null}
          onStarted={setJobId}
        />
      )}

      {jobId && (
        <JobPanel
          id={jobId}
          onDone={() => {
            setJobId(null);
            overview.reload();
          }}
        />
      )}

      {data.status.deployed && data.dashboards.length > 0 && (
        <section aria-labelledby="dashboards-title">
          <h2 id="dashboards-title">Dashboards</h2>
          <p className="muted">
            Generated from your services and kept up to date on every apply. They open in Grafana;
            you are signed in automatically.
          </p>
          <ul className="dashboard-list">
            {data.dashboards.map((d) => (
              <li key={d.uid}>
                <a href={d.url} target="_blank" rel="noopener">
                  {d.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="components-title">
        <h2 id="components-title">Components</h2>
        <table>
          <caption className="visually-hidden">Components of the observability stack</caption>
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">What it does</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.components.map((c) => {
              const s = data.status.components.find((x) => x.component === c.id);
              const ok = s?.state === 'running' && s.ready !== false;
              return (
                <tr key={c.id}>
                  <th scope="row">{c.id}</th>
                  <td>
                    {c.purpose}
                    {c.privileges.length > 0 && (
                      <div className="hint">Needs: {c.privileges.join('; ')}</div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${ok ? 'badge-ok' : 'badge-error'}`}>
                      {s
                        ? ok
                          ? 'healthy'
                          : s.ready === false
                            ? 'not ready'
                            : s.state
                        : 'not deployed'}
                    </span>
                    {!ok && s?.detail && <div className="hint">{s.detail.split('\n')[0]}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {data.status.scrapeTargets && (
        <section aria-labelledby="scrape-title">
          <h2 id="scrape-title">Monitoring of the stack itself</h2>
          <p className="muted">
            Prometheus checks every component every 15 seconds. If a check fails, the monitoring
            itself is broken.
          </p>
          <ul className="target-list">
            {data.status.scrapeTargets.map((t) => (
              <li key={t.job}>
                <span className={`badge ${t.health === 'up' ? 'badge-ok' : 'badge-error'}`}>
                  {t.health}
                </span>{' '}
                {t.job}
                {t.lastError && <span className="hint"> — {t.lastError}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <PlanSection data={data} user={user} disabled={jobId !== null} onStarted={setJobId} />

      {user.role === 'admin' && <SecretsSection />}

      <section aria-labelledby="config-title">
        <h2 id="config-title">Generated configuration</h2>
        <p className="muted">
          Standard configuration files for each tool. They are generated from your workspace; to
          change them, change the workspace and apply.
        </p>
        {data.files.map((f) => (
          <GeneratedFile key={f.path} path={f.path} description={f.description} />
        ))}
      </section>

      {data.releases.length > 0 && (
        <section aria-labelledby="releases-title">
          <h2 id="releases-title">Releases</h2>
          <p className="muted">
            Every apply is kept, so a previous configuration can be restored with{' '}
            <code>raion rollback</code>.
          </p>
          <ul>
            {data.releases.map((r) => (
              <li key={r.id}>
                <code>{r.id}</code> — {new Date(r.createdAt).toLocaleString()} by {r.createdBy}
                {r.id === data.status.deployed?.id && <strong> (deployed)</strong>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="connect-title">
        <h2 id="connect-title">Sending telemetry</h2>
        <p>Applications on this machine send OpenTelemetry data (OTLP) to:</p>
        <ul>
          <li>
            gRPC: <code>{data.otlp.grpc}</code>
          </li>
          <li>
            HTTP: <code>{data.otlp.http}</code>
          </li>
        </ul>
        <p className="muted">
          Applications in Docker Compose join the <code>{data.ingestNetwork}</code> network and use{' '}
          <code>otel-collector:4317</code>.
        </p>
      </section>
    </>
  );
}

function StatusBanner({ data }: { data: RuntimeOverview }) {
  if (!data.status.deployed) {
    return (
      <div className="notice notice-warning">
        <h2>Not deployed yet</h2>
        <p>Review the changes below and apply them to start the observability stack.</p>
      </div>
    );
  }
  return data.status.healthy ? (
    <div className="notice notice-ok">
      <h2>Healthy</h2>
      <p>
        Release <code>{data.status.deployed.id}</code> is running and every component is ready.
      </p>
    </div>
  ) : (
    <div className="notice notice-error" role="alert">
      <h2>Something is wrong</h2>
      <p>
        At least one component is not running or not ready. Details are in the table below and in{' '}
        <code>raion status</code>.
      </p>
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

  const apply = async () => {
    setError(null);
    try {
      const { job } = await runtimeApi.apply({ allowPrivileged, allowDataChanges });
      props.onStarted(job);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section aria-labelledby="plan-title">
      <h2 id="plan-title">Pending changes</h2>
      {plan.noChanges && props.data.status.deployed ? (
        <p>The deployed configuration matches your workspace.</p>
      ) : (
        <>
          {changed.length > 0 && (
            <ul>
              {changed.map((c) => (
                <li key={c.component}>
                  <strong>{c.component}</strong> {ACTION_LABEL[c.action] ?? c.action}
                  {c.reasons.length > 0 && <span className="muted"> — {c.reasons.join(', ')}</span>}
                </li>
              ))}
            </ul>
          )}
          <Disclosure summary={`Show ${plan.files.length} changed file(s)`}>
            <ul>
              {plan.files.map((f) => (
                <li key={f.path}>
                  <code>
                    {f.change === 'add' ? '+' : f.change === 'remove' ? '-' : '~'} {f.path}
                  </code>{' '}
                  <span className="muted">{f.description}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        </>
      )}
      {plan.hostAccess.length > 0 && (
        <p className="muted">
          Host access (read-only, for host metrics): {plan.hostAccess.join('; ')}
        </p>
      )}
      {plan.notes.map((n, i) => (
        <p key={i} className={n.severity === 'warning' ? 'warning-text' : 'muted'}>
          {n.message}
        </p>
      ))}
      {plan.securityRelevant.length > 0 && (
        <div className="notice notice-warning">
          <h3>Needs elevated privileges</h3>
          <ul>
            {plan.securityRelevant.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {isAdmin && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={allowPrivileged}
                onChange={(e) => setAllowPrivileged(e.target.checked)}
              />{' '}
              I approve these privileges
            </label>
          )}
        </div>
      )}
      {plan.dataAffecting.length > 0 && (
        <div className="notice notice-warning">
          <h3>Affects stored data</h3>
          <ul>
            {plan.dataAffecting.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {isAdmin && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={allowDataChanges}
                onChange={(e) => setAllowDataChanges(e.target.checked)}
              />{' '}
              I understand data may be lost
            </label>
          )}
        </div>
      )}
      {gated && !isAdmin && <p className="muted">An admin must apply this change.</p>}
      <ErrorMessage error={error} />
      {canApply && (
        <button type="button" disabled={props.disabled} onClick={() => void apply()}>
          {props.data.status.deployed
            ? plan.noChanges
              ? 'Re-apply'
              : 'Apply changes'
            : 'Deploy the stack'}
        </button>
      )}
    </section>
  );
}

const DRIFT_LABELS: Record<string, string> = {
  'file-modified': 'File changed',
  'file-missing': 'File missing',
  'file-extra': 'File added',
  'component-missing': 'Container missing',
  'component-stopped': 'Container stopped',
  'component-extra': 'Container added',
  'image-changed': 'Image changed',
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
    <section className="notice notice-error" aria-labelledby="drift-title">
      <h2 id="drift-title">The running stack differs from release {drift.release}</h2>
      <p>
        Something changed outside Raion: a generated file was edited, or a container was stopped,
        removed or replaced. Changes to your workspace are not listed here; they appear under
        pending changes.
      </p>
      <ul>
        {drift.items.map((item) => (
          <li key={`${item.kind}:${item.subject}`}>
            <strong>{DRIFT_LABELS[item.kind] ?? item.kind}:</strong> <code>{item.subject}</code> —{' '}
            {item.detail}
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
        onClick={() => {
          setError(null);
          runtimeApi.verify().then(({ job }) => onStarted(job), setError);
        }}
      >
        Test the pipeline
      </button>
      <ErrorMessage error={error} />
    </>
  );
}

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

  const finished = job && job.state !== 'running';
  return (
    <section
      className={`notice ${job?.state === 'failed' ? 'notice-error' : job?.state === 'succeeded' ? 'notice-ok' : ''}`}
      aria-live="polite"
    >
      <h2>
        {job?.kind === 'verify'
          ? 'Pipeline test'
          : job?.kind === 'repair'
            ? 'Repair'
            : 'Deployment'}{' '}
        {job
          ? job.state === 'running'
            ? 'in progress…'
            : job.state === 'succeeded'
              ? 'succeeded'
              : 'failed'
          : 'starting…'}
      </h2>
      <pre className="job-log">{job?.log.join('\n')}</pre>
      {job?.error && <p className="form-error">{job.error}</p>}
      {finished && (
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
      className="disclosure"
      onToggle={(e) => {
        if (e.currentTarget.open && content === null) {
          runtimeApi.file(path).then((f) => setContent(f.content), setError);
        }
      }}
    >
      <summary>
        <code>{path}</code> <span className="muted">— {description}</span>
      </summary>
      <div className="disclosure-body">
        <ErrorMessage error={error} />
        {content !== null ? (
          <pre>
            <code>{content || '(empty file)'}</code>
          </pre>
        ) : (
          !error && <p aria-busy="true">Loading…</p>
        )}
      </div>
    </details>
  );
}
