import { useState } from 'react';
import { api, sloApi, type SloView, type User } from '../api';
import { ErrorMessage } from '../components';
import { EditError, EditResult, useEdit } from '../edits';
import { linkHandler } from '../router';
import {
  EmptyState,
  Explain,
  Icon,
  InfoTip,
  Loading,
  PageHeader,
  Pill,
  Technical,
  type Tone,
} from '../ui';
import { useLoad } from '../useLoad';

const HEALTH: Record<string, { label: string; tone: Tone }> = {
  healthy: { label: 'On track', tone: 'ok' },
  'at-risk': { label: 'At risk', tone: 'warn' },
  exhausted: { label: 'Missed', tone: 'crit' },
  'no-data': { label: 'No data yet', tone: 'neutral' },
};

function pct(v: number | null, digits = 2): string {
  return v === null ? '—' : `${(v * 100).toFixed(digits)}%`;
}

/** "99.9% of requests succeed" */
export function goalInWords(slo: Pick<SloView, 'sli' | 'target'>): string {
  switch (slo.sli.type) {
    case 'availability':
      return `${slo.target}% of requests succeed`;
    case 'latency':
      return `${slo.target}% of requests answer within ${slo.sli.thresholdMs} ms`;
    case 'throughput':
      return `it handles at least ${slo.sli.minRequestsPerSecond} requests/s, ${slo.target}% of the time`;
    default:
      return `${slo.target}% of events are good`;
  }
}

/** "about 43 minutes of failure per 30 days" */
function allowance(ratio: number, window: string): string {
  const days = Number.parseInt(window, 10);
  const minutes = Math.round(ratio * days * 24 * 60);
  return minutes >= 120 ? `about ${Math.round(minutes / 60)} hours` : `about ${minutes} minutes`;
}

const WHAT_IS = (
  <Explain summary="What is a reliability goal?">
    <p>
      A reliability goal (in SRE terms, an <em>SLO</em>) says how reliable an application should be
      for its users, for example “99.9% of requests succeed over 30 days”.
    </p>
    <p>
      The 0.1% that may fail is the <strong>error budget</strong>: about 43 minutes a month. While
      budget is left, you can ship changes freely. When it runs low, reliability work comes first.
      Raion warns you when the budget is being used up too fast, instead of alerting on every blip.
    </p>
  </Explain>
);

export function SloCard({
  slo,
  showService,
  canEdit,
  onChanged,
}: {
  slo: SloView;
  showService: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const s = slo.status;
  const health = slo.evaluated
    ? HEALTH[s?.health ?? 'no-data']!
    : { label: 'Not measured yet', tone: 'neutral' as Tone };
  const remaining = s?.budgetRemaining ?? null;
  const [editing, setEditing] = useState(false);
  const remove = useEdit(onChanged);
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="card slo-card">
      <div className="spread">
        <div>
          {showService && (
            <a
              className="small"
              href={`/services/${slo.service}`}
              onClick={linkHandler(`/services/${slo.service}`)}
            >
              {slo.service}
            </a>
          )}
          <h3 style={{ margin: '2px 0 0' }}>{goalInWords(slo)}</h3>
          <span className="small muted">
            over any {slo.window.replace('d', ' days')}
            {slo.description ? ` · ${slo.description}` : ''}
          </span>
        </div>
        <Pill tone={health.tone} live={health.tone === 'ok'}>
          {health.label}
        </Pill>
      </div>

      {slo.evaluated && s ? (
        <>
          <div style={{ margin: '16px 0 6px' }} className="spread">
            <span className="small">
              <strong>Error budget left</strong>{' '}
              <InfoTip label="the error budget">
                The failures you can still afford in this period. 100% means none used, 0% means the
                goal is missed.
              </InfoTip>
            </span>
            <strong className="num">
              {pct(remaining === null ? null : Math.max(0, remaining), 0)}
            </strong>
          </div>
          {remaining !== null && (
            <div
              className={`progress ${s.health === 'exhausted' ? 'crit' : s.health === 'at-risk' ? 'warn' : ''}`}
              role="meter"
              aria-label="Error budget left"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.max(0, Math.round(remaining * 100))}
            >
              <span style={{ width: `${Math.max(0, Math.min(100, remaining * 100))}%` }} />
            </div>
          )}
          <div className="row small muted" style={{ marginTop: 10, gap: '6px 18px' }}>
            <span>
              Right now: <strong className="num">{pct(s.sli, 3)}</strong>
            </span>
            <span>
              Using the budget at{' '}
              <strong className="num">
                {s.burnRate1h === null ? '—' : `${s.burnRate1h.toFixed(1)}×`}
              </strong>{' '}
              the affordable pace{' '}
              <InfoTip label="the burn rate">
                1× uses exactly the whole budget over the period. Above 1×, the goal will be missed
                if it continues. For a 30-day goal, Raion raises an urgent alert at 14× for an hour
                or 6× for six hours, and a warning for slower burns that last a day or more.
              </InfoTip>
            </span>
          </div>
          {s.message && (
            <p className="small" style={{ margin: '8px 0 0' }}>
              {s.message}
            </p>
          )}
        </>
      ) : (
        <p className="small muted" style={{ margin: '12px 0 0' }}>
          {slo.reason ?? 'Raion starts measuring it once the change is deployed.'}
        </p>
      )}

      <p className="small muted" style={{ margin: '10px 0 0' }}>
        Allows {allowance(slo.errorBudgetRatio, slo.window)} of failure per{' '}
        {slo.window.replace('d', ' days')}.
        {slo.policy && (
          <>
            {' '}
            <strong>When it runs out:</strong> {slo.policy}
          </>
        )}
      </p>

      {canEdit && !editing && (
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="secondary small" onClick={() => setEditing(true)}>
            Change
          </button>
          {!confirm ? (
            <button type="button" className="ghost small" onClick={() => setConfirm(true)}>
              Remove
            </button>
          ) : (
            <>
              <button
                type="button"
                className="danger small"
                disabled={remove.pending}
                onClick={() =>
                  void remove.save({ kind: 'slo.remove', service: slo.service, name: slo.name })
                }
              >
                Yes, remove it
              </button>
              <button type="button" className="ghost small" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}
      <EditError error={remove.error} />
      {editing && (
        <EditGoal
          slo={slo}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      )}
      <Technical>
        <p className="small" style={{ margin: 0 }}>
          SLO <code>{slo.name}</code> of <code>{slo.service}</code>, defined in{' '}
          <code>{slo.source.file}</code>. Objective {slo.target}% over {slo.window}; error budget
          ratio {slo.errorBudgetRatio}.
        </p>
      </Technical>
    </li>
  );
}

const TARGETS = [
  { value: 99, text: 'about 7 hours of failure a month' },
  { value: 99.5, text: 'about 3½ hours a month' },
  { value: 99.9, text: 'about 43 minutes a month', recommended: true },
  { value: 99.95, text: 'about 22 minutes a month' },
];

function EditGoal({
  slo,
  onDone,
  onCancel,
}: {
  slo: SloView;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [target, setTarget] = useState(String(slo.target));
  const [window, setWindow] = useState(slo.window);
  const [description, setDescription] = useState(slo.description ?? '');
  const [policy, setPolicy] = useState(slo.policy ?? '');
  const edit = useEdit(onDone);
  const set: Record<string, unknown> = {};
  if (Number(target) !== slo.target) set.target = Number(target);
  if (window !== slo.window) set.window = window;
  if (description.trim() !== (slo.description ?? '')) set.description = description.trim() || null;
  if (policy.trim() !== (slo.policy ?? '')) set.policy = policy.trim() || null;
  return (
    <form
      className="stack wide"
      style={{ marginTop: 14 }}
      onSubmit={(e) => {
        e.preventDefault();
        void edit.save({ kind: 'slo.update', service: slo.service, name: slo.name, set });
      }}
    >
      <div className="grid-2">
        <div className="field">
          <label htmlFor={`t-${slo.name}`}>Goal (%)</label>
          <input
            id={`t-${slo.name}`}
            type="number"
            step="0.01"
            min="50"
            max="99.999"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`w-${slo.name}`}>Over</label>
          <select id={`w-${slo.name}`} value={window} onChange={(e) => setWindow(e.target.value)}>
            {['7d', '14d', '28d', '30d', '90d'].map((w) => (
              <option key={w} value={w}>
                {w.replace('d', ' days')}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`d-${slo.name}`}>What it protects</label>
          <input
            id={`d-${slo.name}`}
            value={description}
            placeholder="e.g. Customers can pay"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`p-${slo.name}`}>When the budget runs out, we…</label>
          <input
            id={`p-${slo.name}`}
            value={policy}
            placeholder="e.g. pause new features until it recovers"
            onChange={(e) => setPolicy(e.target.value)}
          />
        </div>
      </div>
      <EditError error={edit.error} />
      <div className="row">
        <button type="submit" disabled={edit.pending || Object.keys(set).length === 0}>
          Save
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SlosPage({ user }: { user: User }) {
  const [tick, setTick] = useState(0);
  const result = useLoad(() => sloApi.list(), `slos:${tick}`, { keepPrevious: true });
  const [creating, setCreating] = useState(false);
  const canEdit = user.role !== 'viewer';
  const reload = () => setTick((t) => t + 1);
  const header = (
    <PageHeader
      title="Reliability goals"
      description="How reliable each application should be for its users, and how close it is to that goal."
      actions={
        <>
          {canEdit && (
            <button type="button" onClick={() => setCreating(true)} disabled={creating}>
              <Icon name="plus" /> Set a goal
            </button>
          )}
          <a
            className="button secondary"
            href="/grafana/d/raion-slos"
            target="_blank"
            rel="noopener"
          >
            <Icon name="chart" /> Goals dashboard
          </a>
        </>
      }
    />
  );
  if (result.state === 'loading')
    return (
      <>
        {header}
        <Loading />
      </>
    );
  if (result.state === 'error')
    return (
      <>
        {header}
        <p className="notice notice-error" role="alert">
          {result.error.message}
        </p>
      </>
    );
  const { slos } = result.data;
  return (
    <>
      {header}
      {WHAT_IS}
      {creating && (
        <CreateGoal
          onDone={() => {
            setCreating(false);
            reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {slos.length === 0 && !creating ? (
        <EmptyState
          icon="target"
          title="No reliability goals yet"
          action={
            canEdit ? (
              <button type="button" onClick={() => setCreating(true)}>
                <Icon name="plus" /> Set your first goal
              </button>
            ) : undefined
          }
        >
          Start with your most important application: 99.9% of requests succeed over 30 days is a
          common first goal.
        </EmptyState>
      ) : (
        <ul className="cards" style={{ listStyle: 'none', padding: 0, marginTop: 16 }}>
          {slos.map((slo) => (
            <SloCard
              key={`${slo.service}/${slo.name}`}
              slo={slo}
              showService
              canEdit={canEdit}
              onChanged={reload}
            />
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
      className="technical"
      style={{ marginTop: 20 }}
      onToggle={(e) => {
        if (e.currentTarget.open && text === null) sloApi.openslo().then(setText, setError);
      }}
    >
      <summary>The same goals in OpenSLO format</summary>
      <div className="technical-body">
        <p className="small muted" style={{ marginTop: 0 }}>
          <a href="https://openslo.com">OpenSLO</a> v1 is the vendor-neutral format for reliability
          goals. From a terminal: <code>raion slo export</code> and <code>raion slo import</code>.
        </p>
        <ErrorMessage error={error} />
        {text !== null && (
          <pre style={{ margin: 0 }}>
            <code>{text || '# no goals yet'}</code>
          </pre>
        )}
      </div>
    </details>
  );
}

const KINDS = [
  {
    value: 'availability',
    title: 'Requests succeed',
    text: 'Requests do not fail with a server error.',
  },
  {
    value: 'latency',
    title: 'Requests are fast',
    text: 'Requests are answered within a time you choose.',
  },
  {
    value: 'throughput',
    title: 'It keeps up',
    text: 'It handles at least a minimum number of requests.',
  },
] as const;

const LATENCY_THRESHOLDS = [100, 250, 500, 750, 1000, 2500];

export function CreateGoal({
  service,
  onDone,
  onCancel,
}: {
  service?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const services = useLoad(() => api.services(), 'goal-services');
  const [form, setForm] = useState({
    service: service ?? '',
    kind: 'availability' as (typeof KINDS)[number]['value'],
    target: 99.9,
    window: '30d',
    thresholdMs: 500,
    minRps: 1,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const edit = useEdit();
  const names = services.state === 'ready' ? services.data.services.map((s) => s.name) : [];
  const chosen = form.service || names[0] || '';

  if (edit.saved) {
    return (
      <div className="stack">
        <EditResult view={edit.saved} />
        <div className="row">
          <button type="button" className="secondary" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="card stack wide"
      onSubmit={(e) => {
        e.preventDefault();
        void edit.save({
          kind: 'slo.add',
          slo: {
            service: chosen,
            name: form.kind,
            sli:
              form.kind === 'availability'
                ? { type: 'availability' }
                : form.kind === 'latency'
                  ? { type: 'latency', thresholdMs: form.thresholdMs }
                  : { type: 'throughput', minRequestsPerSecond: form.minRps },
            target: form.target,
            window: form.window,
          },
        });
      }}
    >
      <h2 style={{ margin: 0 }}>Set a reliability goal</h2>
      {!service && (
        <div className="field" style={{ maxWidth: 360 }}>
          <label htmlFor="goal-service">For which application?</label>
          <select id="goal-service" value={chosen} onChange={(e) => set('service', e.target.value)}>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ marginBottom: 8 }}>
          What matters to its users?
        </legend>
        <div className="choices">
          {KINDS.map((k) => (
            <label className="choice" key={k.value}>
              <input
                type="radio"
                name="goal-kind"
                checked={form.kind === k.value}
                onChange={() => set('kind', k.value)}
              />
              <span className="choice-title">{k.title}</span>
              <small>{k.text}</small>
            </label>
          ))}
        </div>
      </fieldset>
      {form.kind === 'latency' && (
        <div className="field" style={{ maxWidth: 280 }}>
          <label htmlFor="goal-ms">Fast enough means within</label>
          <select
            id="goal-ms"
            value={form.thresholdMs}
            onChange={(e) => set('thresholdMs', Number(e.target.value))}
          >
            {LATENCY_THRESHOLDS.map((ms) => (
              <option key={ms} value={ms}>
                {ms} ms
              </option>
            ))}
          </select>
        </div>
      )}
      {form.kind === 'throughput' && (
        <div className="field" style={{ maxWidth: 280 }}>
          <label htmlFor="goal-rps">At least this many requests per second</label>
          <input
            id="goal-rps"
            type="number"
            min="0.01"
            step="0.01"
            value={form.minRps}
            onChange={(e) => set('minRps', Number(e.target.value))}
          />
        </div>
      )}
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ marginBottom: 8 }}>
          How reliable?
        </legend>
        <div className="choices">
          {TARGETS.map((t) => (
            <label className="choice" key={t.value}>
              <input
                type="radio"
                name="goal-target"
                checked={form.target === t.value}
                onChange={() => set('target', t.value)}
              />
              <span className="choice-title">
                {t.value}% {t.recommended && <Pill tone="accent">Recommended</Pill>}
              </span>
              <small>Allows {t.text}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field" style={{ maxWidth: 200 }}>
        <label htmlFor="goal-window">Measured over</label>
        <select
          id="goal-window"
          value={form.window}
          onChange={(e) => set('window', e.target.value)}
        >
          {['7d', '14d', '28d', '30d', '90d'].map((w) => (
            <option key={w} value={w}>
              {w.replace('d', ' days')}
            </option>
          ))}
        </select>
      </div>
      <EditError error={edit.error} />
      <div className="row">
        <button type="submit" disabled={edit.pending || !chosen}>
          {edit.pending ? 'Saving…' : 'Set this goal'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The goals of one application, for its page. */
export function ServiceSlos({ name, user }: { name: string; user: User }) {
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const result = useLoad(() => sloApi.list(name), `slos:${name}:${tick}`, { keepPrevious: true });
  const canEdit = user.role !== 'viewer';
  if (result.state !== 'ready') return <Loading />;
  const reload = () => setTick((t) => t + 1);
  return (
    <div className="stack">
      {WHAT_IS}
      {result.data.slos.length === 0 && !creating ? (
        <EmptyState
          icon="target"
          title="No reliability goal yet"
          action={
            canEdit ? (
              <button type="button" onClick={() => setCreating(true)}>
                <Icon name="plus" /> Set a goal
              </button>
            ) : undefined
          }
        >
          A goal tells Raion how reliable {name} should be, so it can warn you before users notice.
        </EmptyState>
      ) : (
        <ul className="cards" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {result.data.slos.map((slo) => (
            <SloCard
              key={slo.name}
              slo={slo}
              showService={false}
              canEdit={canEdit}
              onChanged={reload}
            />
          ))}
        </ul>
      )}
      {canEdit && !creating && result.data.slos.length > 0 && (
        <div>
          <button type="button" className="secondary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Add another goal
          </button>
        </div>
      )}
      {creating && (
        <CreateGoal
          service={name}
          onDone={() => {
            setCreating(false);
            reload();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  );
}
