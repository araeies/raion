import { useState } from 'react';
import { sloApi, type NewSloRequest, type SloView, type User } from '../api';
import { Disclosure, ErrorMessage, Field, useSubmit } from '../components';
import { linkHandler } from '../router';
import { useLoad } from '../useLoad';

const HEALTH: Record<string, { label: string; cls: string }> = {
  healthy: { label: 'healthy', cls: 'badge-ok' },
  'at-risk': { label: 'at risk', cls: 'badge-warning' },
  exhausted: { label: 'budget spent', cls: 'badge-error' },
  'no-data': { label: 'no data yet', cls: '' },
};

function pct(v: number | null, digits = 2): string {
  return v === null ? '—' : `${(v * 100).toFixed(digits)}%`;
}

function describe(slo: SloView): string {
  switch (slo.sli.type) {
    case 'availability':
      return 'requests that do not fail with a server error';
    case 'latency':
      return `requests faster than ${slo.sli.thresholdMs} ms`;
    case 'throughput':
      return `5-minute periods with at least ${slo.sli.minRequestsPerSecond} requests/s`;
    default:
      return 'good events (custom query)';
  }
}

/** Allowed failure, in words: "0.1% of requests, about 43 minutes of full outage per 30 days". */
function budgetInWords(slo: SloView): string {
  const days = Number.parseInt(slo.window, 10);
  const minutes = Math.round(slo.errorBudgetRatio * days * 24 * 60);
  const share = `${Number((slo.errorBudgetRatio * 100).toPrecision(4))}%`;
  return `${share} may fail — about ${minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`} of full outage per ${slo.window}`;
}

export function SloCard({ slo, showService }: { slo: SloView; showService: boolean }) {
  const s = slo.status;
  const health = slo.evaluated
    ? HEALTH[s?.health ?? 'no-data']!
    : { label: 'not evaluated', cls: '' };
  const remaining = s?.budgetRemaining ?? null;
  return (
    <li className="card slo-card">
      <h3>
        <span>
          {showService && (
            <>
              <a
                href={`/services/${slo.service}`}
                onClick={linkHandler(`/services/${slo.service}`)}
              >
                {slo.service}
              </a>{' '}
              ·{' '}
            </>
          )}
          {slo.name}
        </span>
        <span className={`badge ${health.cls}`}>{health.label}</span>
      </h3>
      <p>
        <strong>{slo.target}%</strong> of {describe(slo)}, over a rolling {slo.window}.
      </p>
      {slo.description && <p className="muted">{slo.description}</p>}
      {slo.evaluated && s ? (
        <>
          <dl className="slo-numbers">
            <dt>Now</dt>
            <dd>{pct(s.sli, 3)}</dd>
            <dt>Budget left</dt>
            <dd>{pct(remaining, 0)}</dd>
            <dt>Burn rate (1 h)</dt>
            <dd>{s.burnRate1h === null ? '—' : `${s.burnRate1h.toFixed(1)}×`}</dd>
          </dl>
          {remaining !== null && (
            <div
              className="budget-bar"
              role="meter"
              aria-label="Error budget left"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.max(0, Math.round(remaining * 100))}
            >
              <span
                style={{ width: `${Math.max(0, Math.min(100, remaining * 100))}%` }}
                className={HEALTH[s.health]?.cls}
              />
            </div>
          )}
          <p className="muted">{s.message}</p>
        </>
      ) : (
        <p className="muted">
          {slo.reason ?? 'Not deployed yet: apply the configuration to start measuring.'}
        </p>
      )}
      <p className="muted">Error budget: {budgetInWords(slo)}.</p>
      {slo.policy && (
        <p>
          <strong>When the budget is spent:</strong> {slo.policy}
        </p>
      )}
      <p className="muted">
        Defined in <code>{slo.source.file}</code>
      </p>
    </li>
  );
}

export function SlosPage({ user }: { user: User }) {
  const [tick, setTick] = useState(0);
  const result = useLoad(() => sloApi.list(), `slos:${tick}`, { keepPrevious: true });
  const [creating, setCreating] = useState(false);
  const canEdit = user.role !== 'viewer';

  if (result.state === 'loading') return <p aria-busy="true">Loading SLOs…</p>;
  if (result.state === 'error')
    return <p role="alert">Could not load SLOs: {result.error.message}</p>;
  const { slos } = result.data;
  return (
    <>
      <h1>Service level objectives</h1>
      <p className="lead">
        An SLO says how reliable a service must be for its users, e.g. “99.9% of requests succeed
        over 30 days”. The 0.1% that may fail is the <strong>error budget</strong>: spend it on
        change, protect it when it runs low. Raion measures each SLO and alerts when the budget
        burns too fast.
      </p>
      <div className="actions">
        {canEdit && (
          <button type="button" onClick={() => setCreating(true)} disabled={creating}>
            Create an SLO
          </button>
        )}
        <a
          className="button secondary-link"
          href="/grafana/d/raion-slos"
          target="_blank"
          rel="noopener"
        >
          SLO dashboard ↗
        </a>
      </div>
      {creating && (
        <CreateSlo
          onDone={() => {
            setCreating(false);
            setTick((t) => t + 1);
          }}
        />
      )}
      {slos.length === 0 ? (
        <div className="empty">
          <p>No SLOs yet.</p>
          <p>
            Start with availability for your most important service: 99.9% over 30 days is a common
            first objective.
          </p>
        </div>
      ) : (
        <ul className="cards">
          {slos.map((slo) => (
            <SloCard key={`${slo.service}/${slo.name}`} slo={slo} showService />
          ))}
        </ul>
      )}
      <OpenSloView />
    </>
  );
}

function OpenSloView() {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <details
      className="disclosure"
      onToggle={(e) => {
        if (e.currentTarget.open && text === null) sloApi.openslo().then(setText, setError);
      }}
    >
      <summary>Show as OpenSLO</summary>
      <div className="disclosure-body">
        <p className="muted">
          The same SLOs in <a href="https://openslo.com">OpenSLO</a> v1, the vendor-neutral SLO
          format. Export them with <code>raion slo export</code>.
        </p>
        <ErrorMessage error={error} />
        {text !== null && (
          <pre>
            <code>{text || '# no SLOs'}</code>
          </pre>
        )}
      </div>
    </details>
  );
}

const LATENCY_THRESHOLDS = [100, 250, 500, 750, 1000, 2500];

export function CreateSlo({ service, onDone }: { service?: string; onDone: () => void }) {
  const services = useLoad(() => sloApi.list(), 'slo-services');
  const [form, setForm] = useState({
    service: service ?? '',
    type: 'availability' as 'availability' | 'latency' | 'throughput',
    target: '99.9',
    window: '30d',
    thresholdMs: '500',
    minRps: '1',
    name: '',
    description: '',
    policy: '',
  });
  const [created, setCreated] = useState<{ file: string; content: string } | null>(null);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const { pending, error, onSubmit } = useSubmit(async () => {
    const sli: NewSloRequest['sli'] =
      form.type === 'availability'
        ? { type: 'availability' }
        : form.type === 'latency'
          ? { type: 'latency', thresholdMs: Number(form.thresholdMs) }
          : { type: 'throughput', minRequestsPerSecond: Number(form.minRps) };
    const result = await sloApi.create({
      service: form.service,
      name: form.name || form.type,
      sli,
      target: Number(form.target),
      window: form.window,
      ...(form.description ? { description: form.description } : {}),
      ...(form.policy ? { policy: form.policy } : {}),
    });
    setCreated(result);
  });

  if (created) {
    return (
      <section className="notice notice-ok" aria-live="polite">
        <h2>SLO created</h2>
        <p>
          Saved as <code>{created.file}</code> in the workspace. It is measured once the
          configuration is applied.
        </p>
        <pre>
          <code>{created.content}</code>
        </pre>
        <div className="actions">
          <a className="button" href="/runtime" onClick={linkHandler('/runtime')}>
            Review and apply
          </a>
          <button type="button" className="secondary" onClick={onDone}>
            Done
          </button>
        </div>
      </section>
    );
  }

  const serviceNames =
    services.state === 'ready' ? [...new Set(services.data.slos.map((s) => s.service))] : [];
  return (
    <section className="card" aria-labelledby="create-slo-title">
      <h2 id="create-slo-title">Create an SLO</h2>
      <form onSubmit={onSubmit}>
        {!service && (
          <Field
            id="slo-service"
            label="Service"
            value={form.service}
            onChange={set('service')}
            hint={
              serviceNames.length
                ? `e.g. ${serviceNames.join(', ')}`
                : 'The service name from your workspace.'
            }
          />
        )}
        <fieldset className="field">
          <legend>What should it measure?</legend>
          {(
            [
              ['availability', 'Availability: requests succeed (no server errors)'],
              ['latency', 'Latency: requests are fast enough'],
              ['throughput', 'Throughput: at least a minimum rate of requests is handled'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="checkbox">
              <input
                type="radio"
                name="slo-type"
                value={value}
                checked={form.type === value}
                onChange={() => set('type')(value)}
              />{' '}
              {label}
            </label>
          ))}
        </fieldset>
        {form.type === 'latency' && (
          <div className="field">
            <label htmlFor="slo-threshold">Fast enough means under</label>
            <select
              id="slo-threshold"
              value={form.thresholdMs}
              onChange={(e) => set('thresholdMs')(e.target.value)}
            >
              {LATENCY_THRESHOLDS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms} ms
                </option>
              ))}
            </select>
            <small className="hint">
              These are the thresholds the service's metrics can measure exactly.
            </small>
          </div>
        )}
        {form.type === 'throughput' && (
          <Field
            id="slo-rps"
            label="Minimum requests per second"
            value={form.minRps}
            onChange={set('minRps')}
          />
        )}
        <div className="inline-form">
          <Field
            id="slo-target"
            label="Objective (%)"
            value={form.target}
            onChange={set('target')}
            hint="99.9 allows about 43 minutes of failure per 30 days."
          />
          <div className="field">
            <label htmlFor="slo-window">Over</label>
            <select
              id="slo-window"
              value={form.window}
              onChange={(e) => set('window')(e.target.value)}
            >
              {['7d', '14d', '28d', '30d', '90d'].map((w) => (
                <option key={w} value={w}>
                  {w.replace('d', ' days')}
                </option>
              ))}
            </select>
          </div>
          <Field
            id="slo-name"
            label="Name (optional)"
            value={form.name}
            onChange={set('name')}
            required={false}
            hint={`Default: ${form.type}`}
          />
        </div>
        <Disclosure summary="Description and error budget policy (optional)">
          <Field
            id="slo-description"
            label="What does it protect?"
            value={form.description}
            onChange={set('description')}
            required={false}
            hint="e.g. “Customers can pay”."
          />
          <Field
            id="slo-policy"
            label="When the budget is spent, we…"
            value={form.policy}
            onChange={set('policy')}
            required={false}
            hint="e.g. “freeze feature releases until it recovers”."
          />
        </Disclosure>
        <ErrorMessage error={error} />
        <div className="actions">
          <button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create SLO'}
          </button>
          <button type="button" className="secondary" onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

/** The SLOs of one service, for the service page. */
export function ServiceSlos({ name, user }: { name: string; user: User }) {
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const result = useLoad(() => sloApi.list(name), `slos:${name}:${tick}`, { keepPrevious: true });
  if (result.state !== 'ready') return null;
  return (
    <>
      {result.data.slos.length === 0 ? (
        <p className="muted">
          No SLOs yet. SLOs describe how reliable this service should be, from your users' point of
          view.
        </p>
      ) : (
        <ul className="cards">
          {result.data.slos.map((slo) => (
            <SloCard key={slo.name} slo={slo} showService={false} />
          ))}
        </ul>
      )}
      {user.role !== 'viewer' && !creating && (
        <button type="button" className="secondary" onClick={() => setCreating(true)}>
          Add an SLO
        </button>
      )}
      {creating && (
        <CreateSlo
          service={name}
          onDone={() => {
            setCreating(false);
            setTick((t) => t + 1);
          }}
        />
      )}
    </>
  );
}
