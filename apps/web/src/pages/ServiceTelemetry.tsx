import { useEffect, useState } from 'react';
import {
  discoveryApi,
  runtimeApi,
  servicesApi,
  type ConnectRunningPreview,
  type Job,
  type ServiceConnection,
  type ServiceHistory,
  type ServiceTelemetry,
} from '../api';
import { Sparkline } from '../charts';
import { ErrorMessage } from '../components';
import { linkHandler } from '../router';
import { Explain, Icon, InfoTip, Loading, Pill, Stat, Technical } from '../ui';
import { useLoad } from '../useLoad';

function percent(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;
}

function millis(v: number | null): string {
  return v === null || Number.isNaN(v) ? '—' : `${Math.round(v * 1000)} ms`;
}

const SIGNAL_NAMES: Record<string, { title: string; text: string }> = {
  metrics: { title: 'Measurements', text: 'requests, errors and response times' },
  logs: { title: 'Logs', text: 'the lines it writes' },
  traces: { title: 'Traces', text: 'the path of each request' },
};

/** Live health: the last five minutes, and whether everything Raion expects is arriving. */
export function ServiceHealth({ name }: { name: string }) {
  const [tick, setTick] = useState(0);
  const result = useLoad(() => servicesApi.telemetry(name), `telemetry:${name}:${tick}`, {
    keepPrevious: true,
  });
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (result.state === 'loading') return <Loading label="Checking what arrives from it…" />;
  if (result.state === 'error')
    return (
      <p className="notice notice-error" role="alert">
        Could not check it: {result.error.message}
      </p>
    );
  if (!result.data.deployed || !result.data.telemetry) {
    return (
      <div className="notice notice-info callout">
        <Icon name="rocket" />
        <div>
          <strong>Monitoring has not started yet.</strong> Raion measures this application once its
          monitoring tools are running.{' '}
          <a href="/runtime" onClick={linkHandler('/runtime')}>
            Start monitoring
          </a>
        </div>
      </div>
    );
  }
  return (
    <>
      <TelemetryView t={result.data.telemetry} />
      <HistoryCharts name={name} tick={tick} />
    </>
  );
}

const PERIODS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 360, label: '6 hours' },
  { minutes: 1440, label: '24 hours' },
] as const;

const TONES = {
  requests: 'accent',
  errors: 'crit',
  p95: 'violet',
  up: 'ok',
  answer: 'violet',
} as const;

/** How the application behaved recently: one small chart per measurement. */
function HistoryCharts({ name, tick }: { name: string; tick: number }) {
  const [minutes, setMinutes] = useState<60 | 360 | 1440>(60);
  const result = useLoad(
    () => servicesApi.history(name, minutes),
    `history:${name}:${minutes}:${tick}`,
    {
      keepPrevious: true,
    },
  );
  return (
    <section className="card" aria-labelledby="history-title">
      <div className="card-header">
        <div>
          <h2 id="history-title">Over time</h2>
          <span className="muted small">
            Point at a chart, or focus it and use the arrow keys, to read a moment.
          </span>
        </div>
        <div className="tabs tabs-compact" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.minutes}
              type="button"
              aria-pressed={minutes === p.minutes}
              onClick={() => setMinutes(p.minutes)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {result.state === 'loading' ? (
        <Loading label="Loading its history…" />
      ) : result.state === 'error' ? (
        <p className="notice notice-error" role="alert">
          Could not load its history: {result.error.message}
        </p>
      ) : !result.data.history || result.data.history.series.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          Charts appear once Raion receives requests or check results from it.
        </p>
      ) : (
        <Charts h={result.data.history} />
      )}
    </section>
  );
}

function Charts({ h }: { h: ServiceHistory }) {
  return (
    <div className="charts">
      {h.series.map((s) => (
        <Sparkline
          key={s.key}
          series={s}
          from={h.from}
          to={h.to}
          step={h.step}
          tone={TONES[s.key]}
          floor={s.key === 'up' ? 1 : undefined}
        />
      ))}
    </div>
  );
}

function ChecksView({ checks }: { checks: NonNullable<ServiceTelemetry['checks']> }) {
  return (
    <ul className="checklist">
      {checks.map((c) => (
        <li key={c.url} className={c.up ? 'done' : ''}>
          <span
            className="check"
            aria-hidden="true"
            style={c.up === false ? { borderColor: 'var(--crit)' } : undefined}
          >
            {c.up && <Icon name="check" size={14} />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="spread">
              <strong style={{ overflowWrap: 'anywhere' }}>{c.url}</strong>
              <Pill tone={c.up === null ? 'neutral' : c.up ? 'ok' : 'crit'} live={c.up === true}>
                {c.up === null ? 'Not checked yet' : c.up ? 'Up' : 'Down'}
              </Pill>
            </div>
            <span className="small muted">
              {c.up === null
                ? 'Raion checks it once monitoring is running with this change deployed.'
                : [
                    c.seconds !== null && `answered in ${Math.round(c.seconds * 1000)} ms`,
                    c.status !== null && `status ${c.status}`,
                    c.certificateDays !== null &&
                      `certificate valid for ${c.certificateDays} more days`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function TelemetryView({ t }: { t: ServiceTelemetry }) {
  if (t.signals.length === 0 && t.checks) {
    const up = t.checks.every((c) => c.up);
    return (
      <section className="card" aria-labelledby="health-title">
        <div className="card-header">
          <div>
            <h2 id="health-title">Health</h2>
            <span className="muted small">
              Raion visits its address from outside, like a user would.{' '}
              <InfoTip label="outside checks">
                It runs elsewhere, so Raion cannot see inside it. Instead it checks regularly that
                its address answers, how fast, and that its HTTPS certificate is valid.
              </InfoTip>
            </span>
          </div>
          <Pill tone={up ? 'ok' : 'warn'} live={up}>
            {up ? 'Up' : 'Needs attention'}
          </Pill>
        </div>
        <ChecksView checks={t.checks} />
      </section>
    );
  }
  const allOk = t.signals.every((s) => s.ok) && (t.correlation?.linkedTraceFound ?? true);
  const nothing = t.signals.every((s) => !s.ok);
  return (
    <section className="card" aria-labelledby="health-title">
      <div className="card-header">
        <div>
          <h2 id="health-title">Health</h2>
          <span className="muted small">The last 5 minutes. Refreshes every 30 seconds.</span>
        </div>
        <Pill tone={allOk ? 'ok' : nothing ? 'crit' : 'warn'} live={allOk}>
          {allOk ? 'Connected' : nothing ? 'Not connected' : 'Partly connected'}
        </Pill>
      </div>
      {t.red && (
        <div
          className="stats"
          role="group"
          aria-label="Last 5 minutes"
          style={{ marginBottom: 18 }}
        >
          <Stat
            label="Requests"
            value={
              t.red.requestsPerSecond === null ? '—' : `${t.red.requestsPerSecond.toFixed(2)}/s`
            }
            sub="per second"
          />
          <Stat
            label="Failing"
            value={percent(t.red.errorRatio)}
            sub="of requests"
            help="Requests that ended with a server error (HTTP 5xx). Errors the user caused, like a wrong password, are not counted."
          />
          <Stat
            label="Slowest 1 in 20"
            value={millis(t.red.p95Seconds)}
            sub="response time"
            help="95% of requests were faster than this. It shows what your slowest users experience, which an average hides."
          />
        </div>
      )}
      <h3 className="small muted" style={{ margin: '0 0 6px' }}>
        Is everything arriving?
      </h3>
      <ul className="checklist">
        {t.signals.map((s) => (
          <li key={s.signal} className={s.ok ? 'done' : ''}>
            <span className="check" aria-hidden="true">
              {s.ok && <Icon name="check" size={14} />}
            </span>
            <div>
              <strong>{SIGNAL_NAMES[s.signal]?.title ?? s.signal}</strong>{' '}
              <span className="muted small">({SIGNAL_NAMES[s.signal]?.text})</span>
              <div className="small muted">{s.message}</div>
            </div>
          </li>
        ))}
        {t.correlation && (
          <li className={t.correlation.linkedTraceFound ? 'done' : ''}>
            <span className="check" aria-hidden="true">
              {t.correlation.linkedTraceFound && <Icon name="check" size={14} />}
            </span>
            <div>
              <strong>Logs linked to traces</strong>{' '}
              <InfoTip label="linked logs">
                When a log line carries the ID of the request it belongs to, you can jump from an
                error message straight to that request's full path.
              </InfoTip>
              <div className="small muted">{t.correlation.message}</div>
            </div>
          </li>
        )}
      </ul>
      {t.checks && (
        <>
          <h3 className="small muted" style={{ margin: '14px 0 6px' }}>
            Outside checks
          </h3>
          <ChecksView checks={t.checks} />
        </>
      )}
      {nothing && (
        <p className="small" style={{ marginBottom: 0 }}>
          Nothing has arrived yet. The <strong>Connect</strong> tab shows how to connect it.
        </p>
      )}
      <Technical summary="The queries behind these numbers">
        <p className="small muted" style={{ marginTop: 0 }}>
          Run them in Grafana → Explore to look further.
        </p>
        <pre style={{ margin: 0 }}>
          <code>
            {[
              ...t.signals.map((s) => `# ${s.signal}\n${s.query}`),
              ...(t.red
                ? [
                    `# requests per second\n${t.red.queries.requestsPerSecond}`,
                    `# share failing\n${t.red.queries.errorRatio}`,
                    `# 95th percentile response time\n${t.red.queries.p95Seconds}`,
                  ]
                : []),
            ].join('\n\n')}
          </code>
        </pre>
      </Technical>
    </section>
  );
}

/** Restarts an application that already runs with Raion's settings, after showing exactly what. */
function ConnectForMe({ name }: { name: string }) {
  const [preview, setPreview] = useState<ConnectRunningPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [pending, setPending] = useState(false);

  const poll = (id: string) => {
    void runtimeApi.job(id).then(
      (j) => {
        setJob(j);
        if (j.state === 'running') setTimeout(() => poll(id), 1500);
      },
      () => setTimeout(() => poll(id), 3000),
    );
  };

  if (job) {
    const done = job.state === 'succeeded';
    return (
      <div
        className={`notice ${done ? 'notice-ok' : job.state === 'running' ? 'notice-info' : 'notice-error'}`}
        aria-live="polite"
      >
        <strong>
          {job.state === 'running'
            ? `Restarting ${name} with Raion's settings…`
            : done
              ? `${name} is connected.`
              : `${name} could not be connected.`}
        </strong>
        {done && (
          <p style={{ margin: '4px 0 0' }}>
            Within a minute, the <strong>Overview</strong> tab shows its data arriving.
          </p>
        )}
        <Technical summary="What happened">
          <pre style={{ margin: 0 }}>
            <code>{job.log.join('\n')}</code>
          </pre>
        </Technical>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="notice notice-accent callout">
        <Icon name="spark" />
        <div style={{ flex: 1 }}>
          <div className="spread">
            <span>
              <strong>Raion can do this for you.</strong> If {name} is already running in Docker
              Compose on this machine, Raion restarts it once with these settings.
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setPending(true);
                setError(null);
                discoveryApi
                  .connectPreview(name)
                  .then(setPreview, setError)
                  .finally(() => setPending(false));
              }}
            >
              {pending ? 'Checking…' : 'Connect it for me'}
            </button>
          </div>
          <ErrorMessage error={error} />
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <h3 style={{ marginTop: 0 }}>Restart {name} with Raion's settings?</h3>
      <ul>
        <li>
          Raion restarts <strong>{name}</strong> in the Compose project{' '}
          <code>{preview.project}</code>. It is briefly unavailable while it restarts. Other
          applications keep running.
        </li>
        <li>
          It adds {preview.settings.length} settings that tell it where to send its data
          {preview.agent ? ', and the OpenTelemetry agent (copied in when it starts)' : ''}
          {preview.logs ? ', and collects its output' : ''}.
        </li>
        <li>
          Your compose files are not changed. Raion keeps its settings in{' '}
          <code>{preview.overridePath}</code>.
        </li>
      </ul>
      <Explain summary="If you restart it yourself later">
        <p>Add Raion's settings file to your usual command, or {name} stops sending data:</p>
        <CopyBlock text={preview.command} />
      </Explain>
      <Technical summary="The settings Raion adds">
        <pre style={{ margin: 0 }}>
          <code>{preview.override}</code>
        </pre>
      </Technical>
      <ErrorMessage error={error} />
      <div className="row" style={{ marginTop: 12 }}>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setError(null);
            discoveryApi
              .connect(name)
              .then(({ job: id }) => poll(id), setError)
              .finally(() => setPending(false));
          }}
        >
          Restart and connect
        </button>
        <button type="button" className="ghost" onClick={() => setPreview(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Step-by-step instructions for connecting an application. */
export function ConnectService({ name, isAdmin = false }: { name: string; isAdmin?: boolean }) {
  const result = useLoad(() => servicesApi.connect(name), `connect:${name}`);
  if (result.state === 'loading') return <Loading />;
  if (result.state === 'error')
    return (
      <p className="notice notice-error" role="alert">
        {result.error.message}
      </p>
    );
  const { connection, override } = result.data;
  return (
    <div className="stack">
      {isAdmin && connection.runtime === 'compose' && connection.supported && (
        <ConnectForMe name={name} />
      )}
      <ConnectSteps c={connection} override={override} />
    </div>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <pre style={{ paddingRight: 80 }}>
        <code>{text}</code>
      </pre>
      <button
        type="button"
        className="secondary small"
        style={{ position: 'absolute', top: 8, right: 8 }}
        onClick={() => {
          // The clipboard is unavailable on pages served over plain HTTP from another machine.
          try {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function ConnectSteps({ c, override }: { c: ServiceConnection; override: string | null }) {
  if (!c.supported) {
    return (
      <div className="notice notice-info">
        {c.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>
    );
  }
  const code = c.requirements.some((r) => r.kind === 'code');
  return (
    <div className="stack">
      <div>
        <h2 style={{ marginBottom: 4 }}>Connect {c.service}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {c.mode === 'pull'
            ? `Raion reads ${c.service}'s statistics itself: nothing changes in ${c.service}.`
            : code
              ? 'This needs a small change in the application, shown below.'
              : 'No change to your code is needed: the application only needs a few settings when it starts.'}
          {c.integration && (
            <>
              {' '}
              Raion uses the <strong>{c.integration.displayName}</strong> integration
              {c.integration.implicit ? ', chosen from its language' : ''}.
            </>
          )}
        </p>
      </div>
      <ol className="checklist" style={{ counterReset: 'step' }}>
        {c.requirements.map((r, i) => (
          <li key={r.description}>
            <span className="check" aria-hidden="true">
              <span className="small">{i + 1}</span>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {r.description}
              {r.command && <CopyBlock text={r.command} />}
            </div>
          </li>
        ))}
        {c.mode !== 'pull' && c.runtime === 'compose' && (
          <li>
            <span className="check" aria-hidden="true">
              <span className="small">{c.requirements.length + 1}</span>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              Restart it with Raion's settings. In the folder of your <code>compose.yaml</code>:
              <CopyBlock
                text={`raion connect --out observability.override.yaml\ndocker compose -f compose.yaml -f observability.override.yaml up -d`}
              />
              <Explain summary="What does this do?">
                <p>
                  The first command writes a small extra file next to your compose file, with the
                  settings that tell the application where to send its data. Your own compose file
                  is not changed. The second command restarts the application with both files.
                </p>
              </Explain>
            </div>
          </li>
        )}
        {c.mode !== 'pull' && c.runtime === 'host' && (
          <li>
            <span className="check" aria-hidden="true">
              <span className="small">{c.requirements.length + 1}</span>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              Start it with these settings (environment variables):
              <CopyBlock text={c.env.map(([k, v]) => `${k}=${v}`).join('\n')} />
            </div>
          </li>
        )}
        <li>
          <span className="check" aria-hidden="true">
            <Icon name="check" size={14} />
          </span>
          <div>
            Open the <strong>Overview</strong> tab: within a minute, “Is everything arriving?”
            should be all green.
          </div>
        </li>
      </ol>
      {c.notes.map((n) => (
        <p key={n} className="small muted" style={{ margin: 0 }}>
          {n}
        </p>
      ))}
      {override && (
        <Technical summary="The extra Compose file Raion generates">
          <pre style={{ margin: 0 }}>
            <code>{override}</code>
          </pre>
        </Technical>
      )}
      <Technical summary="All settings (environment variables)">
        <pre style={{ margin: 0 }}>
          <code>{c.env.map(([k, v]) => `${k}=${v}`).join('\n')}</code>
        </pre>
      </Technical>
    </div>
  );
}
