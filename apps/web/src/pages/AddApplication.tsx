import { useState, type ReactNode } from 'react';
import {
  alertsApi,
  api,
  discoveryApi,
  editApi,
  integrationsApi,
  runtimeApi,
  type DiscoveredContainer,
  type IntegrationView,
  type User,
} from '../api';
import { EditError } from '../edits';
import { linkHandler, navigate } from '../router';
import { Explain, Icon, InfoTip, PageHeader, Pill, type IconName } from '../ui';
import { useLoad } from '../useLoad';

/** "Payment API" → "payment-api": the name Raion uses in files and URLs. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    // "é" decomposes into "e" and an accent mark: drop the marks, keep the letters.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return slug;
}

type Kind = 'web' | 'api' | 'worker' | 'server' | 'microservice';
type Where = 'compose' | 'docker' | 'host' | 'kubernetes' | 'cloud' | 'unsure';

const KINDS: { value: Kind; title: string; text: string; icon: IconName }[] = [
  {
    value: 'web',
    title: 'Website or web app',
    text: 'Pages people open in a browser.',
    icon: 'globe',
  },
  {
    value: 'api',
    title: 'API',
    text: 'Answers requests from other programs or apps.',
    icon: 'code',
  },
  {
    value: 'worker',
    title: 'Background worker',
    text: 'Processes jobs or queues without a web page.',
    icon: 'settings',
  },
  {
    value: 'microservice',
    title: 'Microservice',
    text: 'One part of a larger system of services.',
    icon: 'box',
  },
  {
    value: 'server',
    title: 'Database, cache or web server',
    text: 'Ready-made software such as PostgreSQL, Redis or Nginx.',
    icon: 'server',
  },
];

const WHERE: { value: Where; title: string; text: string; icon: IconName }[] = [
  {
    value: 'compose',
    title: 'Docker Compose',
    text: 'Started with docker compose on this machine.',
    icon: 'docker',
  },
  {
    value: 'docker',
    title: 'Docker',
    text: 'A container started with docker run on this machine.',
    icon: 'box',
  },
  {
    value: 'host',
    title: 'Directly on this machine',
    text: 'A program running on this Linux server or VM.',
    icon: 'server',
  },
  {
    value: 'kubernetes',
    title: 'Kubernetes',
    text: 'Runs in a Kubernetes cluster.',
    icon: 'wheel',
  },
  {
    value: 'cloud',
    title: 'Cloud or another server',
    text: 'Runs somewhere else, reachable by its address.',
    icon: 'cloud',
  },
  {
    value: 'unsure',
    title: "I'm not sure",
    text: 'Raion can still watch it by its web address.',
    icon: 'question',
  },
];

const LANGUAGES = [
  { value: 'nodejs', title: 'Node.js' },
  { value: 'python', title: 'Python' },
  { value: 'java', title: 'Java' },
  { value: 'go', title: 'Go' },
  { value: 'dotnet', title: '.NET' },
  { value: 'php', title: 'PHP' },
  { value: 'other', title: "Other or I'm not sure" },
];

const isRemote = (w: Where | null) => w === 'kubernetes' || w === 'cloud' || w === 'unsure';

/** Languages whose OpenTelemetry agent Raion can add when the container starts. */
const INJECTABLE = ['nodejs', 'python', 'java'];

/** In Docker, Raion adds the agent at start-up, so the application's image needs no change. */
const injects = (plan: { where: Where | null; kind: Kind | null; language: string }) =>
  (plan.where === 'compose' || plan.where === 'docker') &&
  plan.kind !== 'server' &&
  INJECTABLE.includes(plan.language);

interface Plan {
  name: string;
  slug: string;
  kind: Kind | null;
  where: Where | null;
  composeService: string;
  language: string;
  integration: string;
  params: Record<string, string>;
  url: string;
  tier: 'critical' | 'standard' | 'best-effort';
  traces: boolean;
  /** Python on Alpine Linux needs the other build of the agent. */
  alpine: boolean;
  goal: boolean;
  containerLogs: boolean;
}

const STEPS = ['Name', 'Where it runs', 'Details', 'Recommended setup'];

/** The guided way to add an application: no files, no jargon, sensible defaults. */
export function AddApplicationPage({ user }: { user: User }) {
  const integrations = useLoad(() => integrationsApi.list(), 'integrations');
  // Applications already running here, to start from instead of typing.
  const running = useLoad(
    () =>
      discoveryApi
        .list()
        .then((r) => ({ containers: Array.isArray(r.containers) ? r.containers : [] }))
        .catch(() => ({ containers: [] as DiscoveredContainer[] })),
    'discovery',
  );
  const existing = useLoad(() => api.services(), 'services-for-new');
  const [step, setStep] = useState(0);
  const [plan, setPlan] = useState<Plan>({
    name: '',
    slug: '',
    kind: null,
    where: null,
    composeService: '',
    language: 'nodejs',
    integration: '',
    params: {},
    url: '',
    tier: 'standard',
    traces: true,
    alpine: false,
    goal: true,
    containerLogs: true,
  });
  const [created, setCreated] = useState<string | null>(null);
  const update = (changes: Partial<Plan>) => setPlan((p) => ({ ...p, ...changes }));

  if (user.role === 'viewer') {
    return (
      <>
        <PageHeader
          title="Add an application"
          back={{ href: '/services', label: 'Applications' }}
        />
        <p className="notice notice-info">Ask an editor or admin to add applications.</p>
      </>
    );
  }
  if (created) return <SetUpDone name={created} plan={plan} user={user} />;

  const pull =
    integrations.state === 'ready'
      ? integrations.data.integrations.filter((i) => i.collects === 'pull')
      : [];
  const taken = existing.state === 'ready' ? existing.data.services.map((s) => s.name) : [];
  const nameProblem = !plan.slug
    ? 'Give it a name with at least one letter.'
    : taken.includes(plan.slug)
      ? `There is already an application called ${plan.slug}.`
      : null;
  const canNext = [
    !nameProblem && plan.kind !== null,
    plan.where !== null,
    plan.kind === 'server'
      ? Boolean(plan.integration)
      : isRemote(plan.where)
        ? /^https?:\/\/\S+$/.test(plan.url)
        : true,
    true,
  ][step];

  return (
    <>
      <PageHeader
        back={{ href: '/services', label: 'Applications' }}
        eyebrow="New application"
        title={step === 0 ? "Let's add your application" : plan.name || 'Your application'}
        description="Answer a few questions. Raion sets up its monitoring for you: you do not need to know how."
      />
      <ol className="steps" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? 'step' : undefined}
            className={i < step ? 'done' : ''}
          >
            <span className="step-n">{i < step ? <Icon name="check" size={13} /> : i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      <form
        className="card stack wide"
        style={{ maxWidth: 880 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (canNext && step < STEPS.length - 1) setStep(step + 1);
        }}
      >
        {step === 0 && (
          <>
            {running.state === 'ready' &&
              running.data.containers.some((c) => c.compose && !c.monitoredAs) && (
                <div className="stack" style={{ gap: 8 }}>
                  <span className="label">Running on this machine</span>
                  <span className="small muted" style={{ marginTop: -6 }}>
                    Pick one to fill in the answers for you, or describe your application below.
                  </span>
                  <div className="row">
                    {running.data.containers
                      .filter((c) => c.compose && !c.monitoredAs)
                      .slice(0, 12)
                      .map((c) => (
                        <button
                          key={c.container}
                          type="button"
                          className={`secondary small${plan.composeService === c.compose!.service ? '' : ''}`}
                          aria-pressed={plan.composeService === c.compose!.service}
                          title={`${c.image} · project ${c.compose!.project}`}
                          onClick={() =>
                            update({
                              name: c.compose!.service,
                              slug: slugify(c.compose!.service),
                              composeService: c.compose!.service,
                              where: 'compose',
                              kind: c.guess.integration ? 'server' : 'api',
                              ...(c.guess.language ? { language: c.guess.language } : {}),
                              ...(c.guess.integration ? { integration: c.guess.integration } : {}),
                            })
                          }
                        >
                          <Icon name={c.guess.integration ? 'server' : 'docker'} size={15} />
                          {c.compose!.service}
                          <span className="muted">· {c.compose!.project}</span>
                        </button>
                      ))}
                  </div>
                </div>
              )}
            <div className="field" style={{ maxWidth: 480 }}>
              <label htmlFor="app-name">What is your application called?</label>
              <input
                id="app-name"
                autoFocus
                value={plan.name}
                placeholder="e.g. Payment API"
                onChange={(e) =>
                  update({
                    name: e.target.value,
                    slug: slugify(e.target.value),
                    composeService:
                      plan.composeService === plan.slug
                        ? slugify(e.target.value)
                        : plan.composeService,
                  })
                }
              />
              {plan.name && (
                <small
                  className={`hint${nameProblem ? '' : ''}`}
                  style={nameProblem ? { color: 'var(--crit)' } : undefined}
                >
                  {nameProblem ?? (
                    <>
                      Raion will call it <code>{plan.slug}</code>.
                    </>
                  )}
                </small>
              )}
            </div>
            <Choices
              legend="What is it?"
              options={KINDS}
              value={plan.kind}
              onChange={(kind) => update({ kind, goal: kind !== 'worker' && kind !== 'server' })}
            />
          </>
        )}

        {step === 1 && (
          <>
            <Choices
              legend="Where does it run?"
              options={WHERE}
              value={plan.where}
              onChange={(where) => update({ where })}
            />
            {(plan.where === 'compose' || plan.where === 'docker') && (
              <div className="field" style={{ maxWidth: 480 }}>
                <label htmlFor="compose-name">
                  {plan.where === 'compose'
                    ? 'Its name in your docker-compose file'
                    : 'Its container name'}
                </label>
                <input
                  id="compose-name"
                  value={plan.composeService || plan.slug}
                  onChange={(e) => update({ composeService: e.target.value })}
                />
                <small className="hint">
                  {plan.where === 'compose' ? (
                    <>
                      The name under <code>services:</code> in compose.yaml.{' '}
                      <code>docker compose ps</code> lists it in the SERVICE column.
                    </>
                  ) : (
                    <>
                      As shown by <code>docker ps</code>.
                    </>
                  )}
                </small>
              </div>
            )}
            {isRemote(plan.where) && (
              <div className="notice notice-info callout">
                <Icon name="globe" />
                <div>
                  <strong>Raion will watch it from the outside.</strong> It visits your
                  application's address regularly, like a user would, and tells you when it is down,
                  slow, or its security certificate is about to expire. Next, you give its address.
                </div>
              </div>
            )}
          </>
        )}

        {step === 2 && isRemote(plan.where) && plan.kind !== 'server' && (
          <div className="field" style={{ maxWidth: 560 }}>
            <label htmlFor="app-url">Which address should Raion check?</label>
            <input
              id="app-url"
              type="url"
              placeholder="https://shop.example.com/health"
              value={plan.url}
              onChange={(e) => update({ url: e.target.value.trim() })}
            />
            <small className="hint">
              A page that answers quickly when the application is healthy, such as{' '}
              <code>/health</code>, or simply its home page.
            </small>
          </div>
        )}

        {step === 2 && !isRemote(plan.where) && plan.kind !== 'server' && (
          <>
            <Choices
              legend="What language is it written in?"
              options={LANGUAGES}
              value={plan.language}
              onChange={(language) => update({ language })}
              help="Raion uses this to pick how to collect its data. If you are not sure, Raion still collects what it can."
            />
            {plan.language === 'python' && injects(plan) && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={plan.alpine}
                  onChange={(e) => update({ alpine: e.target.checked })}
                />
                <span>
                  Its image is based on Alpine Linux
                  <span className="small muted" style={{ display: 'block' }}>
                    Leave this off if you are not sure: most images are not.
                  </span>
                </span>
              </label>
            )}
          </>
        )}

        {step === 2 && plan.kind === 'server' && (
          <>
            <Choices
              legend="Which one is it?"
              options={pull.map((i) => ({
                value: i.name,
                title: i.displayName,
                text: i.description,
              }))}
              value={plan.integration || null}
              onChange={(integration) => update({ integration, params: {} })}
            />
            {plan.integration && (
              <ServerSettings
                integration={pull.find((i) => i.name === plan.integration)!}
                plan={plan}
                onChange={(params) => update({ params })}
                isAdmin={user.role === 'admin'}
              />
            )}
          </>
        )}

        {step === 3 && <Recommended plan={plan} update={update} />}

        <div className="spread" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="ghost"
            onClick={() => (step === 0 ? navigate('/services') : setStep(step - 1))}
          >
            <Icon name="back" /> {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < STEPS.length - 1 ? (
            <button type="submit" disabled={!canNext}>
              Continue <Icon name="arrow" />
            </button>
          ) : (
            <SetUp plan={plan} isAdmin={user.role === 'admin'} pull={pull} onDone={setCreated} />
          )}
        </div>
      </form>
    </>
  );
}

function Choices<T extends string>({
  legend,
  options,
  value,
  onChange,
  help,
}: {
  legend: string;
  options: { value: T; title: string; text?: string; icon?: IconName }[];
  value: T | null;
  onChange: (value: T) => void;
  help?: ReactNode;
}) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="label" style={{ marginBottom: 10, fontSize: '1.05rem' }}>
        {legend}
      </legend>
      {help && (
        <p className="small muted" style={{ marginTop: -4 }}>
          {help}
        </p>
      )}
      <div className="choices">
        {options.map((o) => (
          <label className="choice" key={o.value}>
            <input
              type="radio"
              name={legend}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span className="choice-title">
              {o.icon && <Icon name={o.icon} />}
              {o.title}
            </span>
            {o.text && <small>{o.text}</small>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const secretKey = (slug: string, param: string) =>
  `${slug}_${param}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** The settings a database, cache or web server needs, from its integration. */
function ServerSettings({
  integration,
  plan,
  onChange,
  isAdmin,
}: {
  integration: IntegrationView;
  plan: Plan;
  onChange: (params: Record<string, string>) => void;
  isAdmin: boolean;
}) {
  const required = integration.parameters.filter((p) => p.required);
  if (required.length === 0) return null;
  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <h3 style={{ margin: 0 }}>How Raion reaches it</h3>
      {integration.requirements.map((r) => (
        <div className="notice notice-info small" key={r.description} style={{ margin: 0 }}>
          {r.description}
        </div>
      ))}
      {required.map((p) => (
        <div className="field" key={p.name}>
          <label htmlFor={`param-${p.name}`}>{p.description}</label>
          <input
            id={`param-${p.name}`}
            type={p.type === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            placeholder={
              p.format === 'hostPort'
                ? `${plan.composeService || plan.slug}:5432`
                : p.format === 'url'
                  ? 'http://…'
                  : ''
            }
            value={plan.params[p.name] ?? ''}
            onChange={(e) => onChange({ ...plan.params, [p.name]: e.target.value })}
          />
          {p.type === 'secret' && (
            <small className="hint">
              {isAdmin
                ? 'Stored securely by Raion, never in your files.'
                : 'Only admins can store passwords. Leave it empty and ask an admin to set it on Observability stack → Secrets.'}
            </small>
          )}
        </div>
      ))}
    </div>
  );
}

function Recommended({ plan, update }: { plan: Plan; update: (c: Partial<Plan>) => void }) {
  const remote = isRemote(plan.where);
  const server = plan.kind === 'server';
  const items: {
    title: string;
    text: string;
    why: string;
    locked?: boolean;
    checked?: boolean;
    onChange?: (v: boolean) => void;
  }[] = remote
    ? [
        {
          title: 'Availability check every 30 seconds',
          text: `Raion visits ${plan.url || 'its address'} and records whether it answers and how fast.`,
          why: 'It is the simplest sign that your application works for users, and needs nothing installed.',
          locked: true,
        },
        {
          title: 'Alert when it is down or its certificate expires soon',
          text: 'You are told after 2 minutes of failed checks, and 14 days before the HTTPS certificate expires.',
          why: 'Two minutes avoids alerts for a single slow answer. An expired certificate makes browsers refuse the site.',
          locked: true,
        },
      ]
    : server
      ? [
          {
            title: 'Health statistics',
            text: 'Raion reads its statistics (connections, memory, activity) every 15 seconds.',
            why: 'These show trouble building up before it causes errors.',
            locked: true,
          },
          {
            title: 'Alert when Raion cannot reach it',
            text: 'And alerts tailored to it, such as running out of connections or memory.',
            why: 'If Raion cannot read it, it may be down: everything that depends on it fails too.',
            locked: true,
          },
          ...(plan.where === 'compose' || plan.where === 'docker'
            ? [
                {
                  title: 'Its log output',
                  text: 'Collect what the container prints, such as errors and slow queries.',
                  why: 'Logs explain what the statistics show.',
                  checked: plan.containerLogs,
                  onChange: (v: boolean) => update({ containerLogs: v }),
                },
              ]
            : []),
        ]
      : [
          ...(injects(plan)
            ? [
                {
                  title: 'No change to your application',
                  text: 'Raion adds the OpenTelemetry agent when its container starts. Your code and image stay as they are.',
                  why: 'The agent is the open-source tool that measures your application from the inside. Raion copies it in from its own pinned, verified copy each time the container starts.',
                  locked: true,
                },
              ]
            : []),
          {
            title: 'Request measurements',
            text: 'How many requests, how many fail, how fast. The basis for dashboards and alerts.',
            why: 'These three numbers (traffic, errors, speed) tell you at a glance whether users are well served.',
            locked: true,
          },
          {
            title: 'Error tracking with logs',
            text: 'The lines your application writes, searchable, linked to the request they belong to.',
            why: 'When something fails, the log line usually says why.',
            locked: true,
          },
          {
            title: 'Distributed tracing',
            text: 'The path of each request through your applications, step by step.',
            why: 'Shows where a slow request spends its time, even across several applications.',
            checked: plan.traces,
            onChange: (v) => update({ traces: v }),
          },
          {
            title: 'Alerts for errors, slowness and silence',
            text: 'When more than 5% of requests fail, 1 in 20 takes over a second, or it stops reporting.',
            why: 'These defaults suit most applications; you can change them later.',
            locked: true,
          },
        ];
  return (
    <div className="stack">
      <div>
        <h2 style={{ marginBottom: 4 }}>Raion recommends</h2>
        <p className="muted" style={{ margin: 0 }}>
          A good setup for {plan.name || 'your application'}. Everything can be changed later in its
          settings.
        </p>
      </div>
      <ul className="checklist">
        {items.map((item) => (
          <li key={item.title} className={item.locked || item.checked ? 'done' : ''}>
            {item.locked ? (
              <span className="check" aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : (
              <input
                type="checkbox"
                aria-label={item.title}
                checked={item.checked}
                onChange={(e) => item.onChange?.(e.target.checked)}
                style={{ marginTop: 3 }}
              />
            )}
            <div>
              <strong>{item.title}</strong>
              <div className="small muted">{item.text}</div>
              <Explain summary="Why?">
                <p>{item.why}</p>
              </Explain>
            </div>
          </li>
        ))}
        {plan.kind !== 'worker' && (
          <li className={plan.goal ? 'done' : ''}>
            <input
              type="checkbox"
              aria-label="Availability goal"
              checked={plan.goal}
              onChange={(e) => update({ goal: e.target.checked })}
              style={{ marginTop: 3 }}
            />
            <div>
              <strong>A reliability goal: 99.9% of requests succeed, over 30 days</strong>{' '}
              <Pill tone="accent">Recommended</Pill>
              <div className="small muted">
                Raion warns you early when {plan.name || 'it'} is on course to miss it.
              </div>
              <Explain summary="What does this mean?">
                <p>
                  A reliability goal (an SLO) says how reliable an application should be. 99.9% over
                  30 days allows about 43 minutes of failures a month: that allowance is the “error
                  budget”.
                </p>
                <p>
                  Instead of alerting on every blip, Raion alerts when failures use up the budget
                  too fast. You hear about real problems, and not about noise.
                </p>
              </Explain>
            </div>
          </li>
        )}
      </ul>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ marginBottom: 8 }}>
          How important is it?{' '}
          <InfoTip label="importance">
            Problems with critical applications raise urgent alerts; others raise warnings.
          </InfoTip>
        </legend>
        <div className="row">
          {(['critical', 'standard', 'best-effort'] as const).map((t) => (
            <label className="choice" key={t} style={{ padding: '8px 14px' }}>
              <input
                type="radio"
                name="tier"
                checked={plan.tier === t}
                onChange={() => update({ tier: t })}
              />
              <span className="choice-title">
                {t === 'best-effort' ? 'Best effort' : t[0]!.toUpperCase() + t.slice(1)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

const TYPE_FOR: Record<Kind, string> = {
  web: 'web',
  api: 'api',
  worker: 'worker',
  microservice: 'microservice',
  server: 'database',
};

/** Writes the application (and its reliability goal) through the same engine as the CLI. */
function SetUp({
  plan,
  isAdmin,
  pull,
  onDone,
}: {
  plan: Plan;
  isAdmin: boolean;
  pull: IntegrationView[];
  onDone: (name: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async () => {
    setPending(true);
    setError(null);
    try {
      const remote = isRemote(plan.where);
      const integration = pull.find((i) => i.name === plan.integration);
      const params: Record<string, string> = {};
      for (const p of integration?.parameters.filter((x) => x.required) ?? []) {
        const value = plan.params[p.name] ?? '';
        if (p.type === 'secret') {
          const key = secretKey(plan.slug, p.name);
          if (value && isAdmin) await alertsApi.setSecret(key, value);
          params[p.name] = `\${secret:${key}}`;
        } else params[p.name] = value;
      }
      const type =
        plan.kind === 'server'
          ? integration?.name === 'nginx'
            ? 'web'
            : 'database'
          : TYPE_FOR[plan.kind ?? 'api'];
      const service: Record<string, unknown> & { name: string; type: string } = {
        name: plan.slug,
        type,
        tier: plan.tier,
        ...(plan.name !== plan.slug ? { description: plan.name } : {}),
        ...(remote
          ? { runtime: { type: 'remote' }, checks: [{ url: plan.url }] }
          : plan.where === 'host'
            ? { runtime: { type: 'host' } }
            : {
                runtime: {
                  type: 'compose',
                  ...(plan.composeService && plan.composeService !== plan.slug
                    ? { composeService: plan.composeService }
                    : {}),
                },
              }),
        ...(plan.kind !== 'server' && !remote ? { language: plan.language } : {}),
        ...(integration ? { integrations: [{ name: integration.name, params }] } : {}),
        // Node.js and Python agents are added at start-up only when asked (Java does by default).
        ...(injects(plan) && plan.language !== 'java'
          ? {
              integrations: [
                {
                  name: plan.language,
                  params: {
                    injectAgent: true,
                    ...(plan.language === 'python' && plan.alpine ? { alpine: true } : {}),
                  },
                },
              ],
            }
          : {}),
        ...(plan.kind === 'server' &&
        plan.containerLogs &&
        (plan.where === 'compose' || plan.where === 'docker')
          ? { containerLogs: true }
          : {}),
        ...(!plan.traces && plan.kind !== 'server' && !remote
          ? { signals: { traces: false } }
          : {}),
        ...(plan.goal && plan.kind !== 'worker' ? { features: { slos: true } } : {}),
      };
      await editApi.save({ kind: 'service.add', service });
      if (plan.goal && plan.kind !== 'worker') {
        await editApi.save({
          kind: 'slo.add',
          slo: {
            service: plan.slug,
            name: 'availability',
            sli: { type: 'availability' },
            target: 99.9,
            window: '30d',
          },
        });
      }
      onDone(plan.slug);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="stack" style={{ alignItems: 'flex-end', gap: 6 }}>
      <button type="button" disabled={pending} onClick={() => void run()}>
        <Icon name="spark" /> {pending ? 'Setting it up…' : 'Set this up for me'}
      </button>
      <EditError error={error} />
    </div>
  );
}

/** After setup: start monitoring, then connect, with live confirmation. */
function SetUpDone({ name, plan, user }: { name: string; plan: Plan; user: User }) {
  const runtime = useLoad(() => runtimeApi.overview(), `setup-runtime:${name}`);
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const deployed = runtime.state === 'ready' && Boolean(runtime.data.status.deployed);
  const pending = runtime.state === 'ready' && !runtime.data.plan.noChanges;
  const gated =
    runtime.state === 'ready' &&
    (runtime.data.plan.securityRelevant.length > 0 || runtime.data.plan.dataAffecting.length > 0);
  return (
    <>
      <PageHeader
        eyebrow="All set"
        title={`${plan.name || name} is set up`}
        back={{ href: '/services', label: 'Applications' }}
      />
      <div className="notice notice-ok callout">
        <Icon name="ok" />
        <div>
          Raion added <strong>{name}</strong> with its recommended monitoring
          {plan.goal && plan.kind !== 'worker' ? ' and a 99.9% reliability goal' : ''}. Two short
          steps remain.
        </div>
      </div>
      <ol className="checklist card" style={{ padding: '6px 22px' }}>
        <li className={deployed && !pending ? 'done' : ''}>
          <span className="check" aria-hidden="true">
            {deployed && !pending ? (
              <Icon name="check" size={14} />
            ) : (
              <span className="small">1</span>
            )}
          </span>
          <div style={{ flex: 1 }}>
            <strong>{deployed ? 'Put the change into effect' : 'Start monitoring'}</strong>
            <div className="small muted">
              {deployed
                ? 'Raion updates its monitoring tools to include the new application. It takes about a minute.'
                : 'Raion downloads and starts its monitoring tools on this machine. The first time takes a few minutes.'}
            </div>
            {job ? (
              <p className="small" style={{ marginBottom: 0 }}>
                Started.{' '}
                <a href="/runtime" onClick={linkHandler('/runtime')}>
                  Follow the progress
                </a>
              </p>
            ) : pending && !gated ? (
              <button
                type="button"
                className="small"
                style={{ marginTop: 8 }}
                onClick={() => {
                  setError(null);
                  runtimeApi
                    .apply({ allowPrivileged: false, allowDataChanges: false })
                    .then((r) => setJob(r.job), setError);
                }}
              >
                <Icon name="rocket" /> {deployed ? 'Deploy now' : 'Start monitoring'}
              </button>
            ) : pending ? (
              <p className="small" style={{ marginBottom: 0 }}>
                This change needs an admin's approval:{' '}
                <a href="/runtime" onClick={linkHandler('/runtime')}>
                  open the Observability stack
                </a>
                .
              </p>
            ) : null}
            <EditError error={error} />
          </div>
        </li>
        {!isRemote(plan.where) && plan.kind !== 'server' && (
          <li>
            <span className="check" aria-hidden="true">
              <span className="small">2</span>
            </span>
            <div style={{ flex: 1 }}>
              <strong>Connect {name}</strong>
              <div className="small muted">
                Restart it once with the settings Raion prepared, so it sends its data. Raion shows
                exactly what to run.
              </div>
              <a
                className="button secondary small"
                style={{ marginTop: 8 }}
                href={`/services/${name}`}
                onClick={linkHandler(`/services/${name}`)}
              >
                Show me how
              </a>
            </div>
          </li>
        )}
      </ol>
      <div className="row" style={{ marginTop: 20 }}>
        <a className="button" href={`/services/${name}`} onClick={linkHandler(`/services/${name}`)}>
          Open {name}
        </a>
        {user.role !== 'viewer' && (
          <a
            className="button secondary"
            href="/services/new"
            onClick={(e) => {
              linkHandler('/services/new')(e);
              window.location.reload();
            }}
          >
            Add another application
          </a>
        )}
      </div>
    </>
  );
}
