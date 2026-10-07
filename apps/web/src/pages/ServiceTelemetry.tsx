import { useEffect, useState } from 'react';
import { servicesApi, type ServiceConnection, type ServiceTelemetry } from '../api';
import { Disclosure } from '../components';
import { useLoad } from '../useLoad';

function percent(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(2)}%`;
}

function millis(v: number | null): string {
  return v === null || Number.isNaN(v) ? '—' : `${Math.round(v * 1000)} ms`;
}

/** Live golden signals and "is this service connected?" checks. */
export function ServiceHealth({ name }: { name: string }) {
  const [tick, setTick] = useState(0);
  const result = useLoad(() => servicesApi.telemetry(name), `telemetry:${name}:${tick}`, {
    keepPrevious: true,
  });
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (result.state === 'loading') return <p aria-busy="true">Checking telemetry…</p>;
  if (result.state === 'error')
    return <p role="alert">Could not check telemetry: {result.error.message}</p>;
  if (!result.data.deployed || !result.data.telemetry) {
    return (
      <p className="muted">
        The observability stack is not deployed yet, so nothing is measured. Deploy it from the
        Observability stack page or with <code>raion apply</code>.
      </p>
    );
  }
  return <TelemetryView t={result.data.telemetry} />;
}

function TelemetryView({ t }: { t: ServiceTelemetry }) {
  const connected = t.signals.every((s) => s.ok);
  return (
    <>
      {t.red && (
        <div className="tiles" role="group" aria-label="Last 5 minutes">
          <div className="tile">
            <span className="tile-label">Requests</span>
            <span className="tile-value">
              {t.red.requestsPerSecond === null ? '—' : `${t.red.requestsPerSecond.toFixed(2)}/s`}
            </span>
          </div>
          <div className="tile">
            <span className="tile-label">Error rate</span>
            <span className="tile-value">{percent(t.red.errorRatio)}</span>
          </div>
          <div className="tile">
            <span className="tile-label">p95 latency</span>
            <span className="tile-value">{millis(t.red.p95Seconds)}</span>
          </div>
        </div>
      )}
      {t.red && (
        <p className="muted">Last 5 minutes. Error rate counts server errors (HTTP 5xx).</p>
      )}

      <h3>{connected ? 'Connected' : 'Not fully connected'}</h3>
      <ul className="target-list">
        {t.signals.map((s) => (
          <li key={s.signal}>
            <span className={`badge ${s.ok ? 'badge-ok' : 'badge-error'}`}>
              {s.ok ? 'ok' : 'missing'}
            </span>{' '}
            {s.signal}: {s.message}
          </li>
        ))}
        {t.correlation && (
          <li>
            <span
              className={`badge ${t.correlation.linkedTraceFound ? 'badge-ok' : 'badge-error'}`}
            >
              {t.correlation.linkedTraceFound ? 'ok' : 'missing'}
            </span>{' '}
            logs ↔ traces: {t.correlation.message}
          </li>
        )}
      </ul>
      <Disclosure summary="Show the queries">
        <p className="muted">Run these in Grafana → Explore to look further.</p>
        <ul>
          {t.signals.map((s) => (
            <li key={s.signal}>
              {s.signal}: <code>{s.query}</code>
            </li>
          ))}
          {t.red && (
            <>
              <li>
                requests/s: <code>{t.red.queries.requestsPerSecond}</code>
              </li>
              <li>
                error rate: <code>{t.red.queries.errorRatio}</code>
              </li>
              <li>
                p95 latency: <code>{t.red.queries.p95Seconds}</code>
              </li>
            </>
          )}
        </ul>
      </Disclosure>
    </>
  );
}

/** Step-by-step instructions for connecting a service, with the generated configuration. */
export function ConnectService({ name }: { name: string }) {
  const result = useLoad(() => servicesApi.connect(name), `connect:${name}`);
  if (result.state === 'loading') return <p aria-busy="true">Loading…</p>;
  if (result.state === 'error') return <p role="alert">{result.error.message}</p>;
  const { connection, override } = result.data;
  return <ConnectSteps c={connection} override={override} />;
}

function ConnectSteps({ c, override }: { c: ServiceConnection; override: string | null }) {
  if (!c.supported) {
    return (
      <>
        {c.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </>
    );
  }
  return (
    <>
      <p>
        Integration: <strong>{c.integration?.displayName}</strong>
        {c.integration?.implicit && (
          <span className="muted"> (chosen from the service language)</span>
        )}
        .{' '}
        {c.mode === 'pull'
          ? 'The collector reads its metrics; nothing changes in the service itself.'
          : c.requirements.some((r) => r.kind === 'code')
            ? 'This integration needs a small code change, described below.'
            : 'No code changes are needed.'}
      </p>
      <ol>
        {c.requirements.map((r) => (
          <li key={r.description}>
            {r.description}
            {r.command && (
              <pre>
                <code>{r.command}</code>
              </pre>
            )}
          </li>
        ))}
        {c.mode === 'pull' && c.runtime !== 'compose' ? (
          <li>Make sure the collector can reach it at the configured endpoint.</li>
        ) : c.runtime === 'compose' ? (
          <li>
            Generate the Compose override and start your services with it:
            <pre>
              <code>
                raion connect --out observability.override.yaml{'\n'}docker compose -f compose.yaml
                -f observability.override.yaml up -d
              </code>
            </pre>
          </li>
        ) : (
          <li>
            Set these environment variables for the process (
            <code>raion connect --service {c.service} --format shell</code> prints them as shell
            commands).
          </li>
        )}
        <li>
          Check it: <code>raion verify --service {c.service}</code>, or watch the Health section
          above.
        </li>
      </ol>
      {c.notes.map((n) => (
        <p key={n} className="muted">
          {n}
        </p>
      ))}
      {override && (
        <Disclosure summary="Show the generated Compose override">
          <pre>
            <code>{override}</code>
          </pre>
        </Disclosure>
      )}
      <Disclosure summary="Show the environment variables">
        <pre>
          <code>{c.env.map(([k, v]) => `${k}=${v}`).join('\n')}</code>
        </pre>
      </Disclosure>
    </>
  );
}
