import { alertsApi, api, runtimeApi, sloApi, type AlertRecord, type User } from '../api';
import { AppCard } from '../AppCard';
import { linkHandler } from '../router';
import { EmptyState, Icon, Loading, PageHeader, Pill, Stat, timeAgo } from '../ui';
import { severityTone } from './Alerts';
import { useLoad } from '../useLoad';

interface HomeData {
  workspace: Awaited<ReturnType<typeof api.workspace>>;
  services: Awaited<ReturnType<typeof api.services>>['services'];
  deployed: boolean;
  healthy: boolean;
  firing: AlertRecord[];
  pending: number;
  slos: Awaited<ReturnType<typeof sloApi.list>>['slos'];
}

async function loadHome(): Promise<HomeData> {
  const [workspace, services, runtime, alerts, slos] = await Promise.all([
    api.workspace(),
    api.services().catch(() => ({ services: [] })),
    runtimeApi.overview().catch(() => null),
    alertsApi.overview().catch(() => null),
    sloApi.list().catch(() => ({ slos: [] })),
  ]);
  return {
    workspace,
    services: services.services,
    deployed: Boolean(runtime?.status.deployed),
    healthy: runtime?.status.healthy ?? false,
    firing: alerts?.firing ?? [],
    pending: alerts?.pending.length ?? 0,
    slos: slos.slos,
  };
}

/** The first page after signing in: how everything is doing, and what to set up next. */
export function HomePage({ user }: { user: User }) {
  const result = useLoad(loadHome, 'home');
  if (result.state === 'loading') return <Loading label="Gathering the latest status…" />;
  if (result.state === 'error')
    return (
      <p className="notice notice-error" role="alert">
        Could not load the overview: {result.error.message}
      </p>
    );
  const d = result.data;
  const canEdit = user.role !== 'viewer';
  const sloAtRisk = d.slos.filter(
    (s) => s.status?.health === 'at-risk' || s.status?.health === 'exhausted',
  ).length;
  const steps = [
    {
      done: d.services.length > 0,
      title: 'Add your first application',
      text: 'Tell Raion what you run. It sets up the right monitoring for it.',
      href: '/services/new',
      cta: 'Add an application',
    },
    {
      done: d.deployed,
      title: 'Start monitoring',
      text: 'Raion starts the open-source tools that collect and store your monitoring data.',
      href: '/runtime',
      cta: 'Open the observability stack',
    },
    {
      done: d.slos.length > 0,
      title: 'Set a reliability goal',
      text: 'Decide how reliable an application should be, and get warned before it falls short.',
      href: '/slos',
      cta: 'Set a goal',
    },
  ];
  const remaining = steps.filter((s) => !s.done);

  return (
    <>
      <PageHeader
        eyebrow={d.workspace.workspace?.name}
        title={`Welcome, ${user.username}`}
        description="Here is how your applications are doing."
        actions={
          canEdit ? (
            <a className="button" href="/services/new" onClick={linkHandler('/services/new')}>
              <Icon name="plus" /> Add an application
            </a>
          ) : undefined
        }
      />

      {d.workspace.diagnostics.some((x) => x.severity === 'error') && (
        <div className="notice notice-error callout" role="alert">
          <Icon name="alert" />
          <div>
            <strong>Raion's configuration has a problem.</strong> Nothing new can be deployed until
            it is fixed.{' '}
            <a href="/settings" onClick={linkHandler('/settings')}>
              See what is wrong
            </a>
          </div>
        </div>
      )}

      <div className="stats" style={{ marginBottom: 24 }}>
        <Stat
          label="Alerts firing"
          value={d.firing.length}
          sub={
            d.firing.length ? (
              <a href="/alerts" onClick={linkHandler('/alerts')}>
                See what needs attention
              </a>
            ) : (
              'nothing needs attention'
            )
          }
        />
        <Stat
          label="Applications"
          value={d.services.length}
          sub={d.services.length ? 'monitored by Raion' : 'none yet'}
        />
        <Stat
          label="Reliability goals"
          value={d.slos.length ? `${d.slos.length - sloAtRisk}/${d.slos.length}` : '—'}
          sub={d.slos.length ? 'on track' : 'none set yet'}
          help="A reliability goal (an SLO) says how reliable an application should be, for example: 99.9% of requests succeed over 30 days."
        />
        <Stat
          label="Raion"
          value={
            !d.deployed ? (
              <Pill tone="neutral">Not started</Pill>
            ) : d.healthy ? (
              <Pill tone="ok" live>
                Healthy
              </Pill>
            ) : (
              <Pill tone="crit">Needs attention</Pill>
            )
          }
          sub="the monitoring tools Raion runs"
        />
      </div>

      {(d.firing.length > 0 || sloAtRisk > 0) && (
        <section className="card" aria-labelledby="attention-title" style={{ marginBottom: 24 }}>
          <div className="card-header">
            <h2 id="attention-title">Needs attention</h2>
          </div>
          <ul className="attention-list">
            {d.firing.map((a) => {
              const sev = severityTone(a.severity);
              return (
                <li key={`${a.fingerprint}-${a.startsAt}`}>
                  <a href="/alerts" onClick={linkHandler('/alerts')}>
                    <Pill tone={sev.tone} live>
                      {sev.label}
                    </Pill>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <strong>{a.rule?.title ?? a.alertname}</strong>
                      {a.service && <span className="muted"> · {a.service}</span>}
                    </span>
                    <span className="small muted nowrap">{timeAgo(a.startsAt)}</span>
                  </a>
                </li>
              );
            })}
            {d.slos
              .filter((s) => s.status?.health === 'at-risk' || s.status?.health === 'exhausted')
              .map((s) => (
                <li key={`${s.service}/${s.name}`}>
                  <a href="/slos" onClick={linkHandler('/slos')}>
                    <Pill tone={s.status?.health === 'exhausted' ? 'crit' : 'warn'}>
                      {s.status?.health === 'exhausted' ? 'Goal missed' : 'Goal at risk'}
                    </Pill>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <strong>
                        {s.service}: {s.target}% {s.sli.type === 'latency' ? 'fast' : 'successful'}{' '}
                        requests
                      </strong>
                    </span>
                  </a>
                </li>
              ))}
          </ul>
        </section>
      )}

      {remaining.length > 0 && canEdit && (
        <section
          className="card notice-accent"
          aria-labelledby="setup-title"
          style={{ marginBottom: 24 }}
        >
          <div className="card-header">
            <div>
              <h2 id="setup-title">Get set up</h2>
              <span className="muted small">
                {steps.length - remaining.length} of {steps.length} done. Each step takes a minute
                or two.
              </span>
            </div>
          </div>
          <ol className="checklist">
            {steps.map((s, i) => (
              <li key={s.title} className={s.done ? 'done' : ''}>
                <span className="check" aria-hidden="true">
                  {s.done ? (
                    <Icon name="check" size={14} />
                  ) : (
                    <span className="small">{i + 1}</span>
                  )}
                </span>
                <div style={{ flex: 1 }}>
                  <strong>{s.title}</strong>
                  {s.done && <span className="visually-hidden"> (done)</span>}
                  <div className="muted small">{s.text}</div>
                </div>
                {!s.done && (
                  <a className="button small" href={s.href} onClick={linkHandler(s.href)}>
                    {s.cta}
                  </a>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="apps-title">
        <div className="spread" style={{ marginBottom: 12 }}>
          <h2 id="apps-title" style={{ margin: 0 }}>
            Applications
          </h2>
          {d.services.length > 0 && (
            <a href="/services" onClick={linkHandler('/services')}>
              See all
            </a>
          )}
        </div>
        {d.services.length === 0 ? (
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
            Add an application and Raion sets up its metrics, logs, traces, dashboards and alerts
            for you. No monitoring experience needed.
          </EmptyState>
        ) : (
          <div className="grid">
            {d.services.slice(0, 9).map((s) => (
              <AppCard
                key={s.name}
                service={s}
                firing={d.firing.filter((a) => a.service === s.name)}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export function NotFound({ path }: { path: string }) {
  return (
    <EmptyState
      icon="question"
      title="This page does not exist"
      action={
        <a className="button" href="/" onClick={linkHandler('/')}>
          Go to Home
        </a>
      }
    >
      There is nothing at <code>{path}</code>, or you do not have access to it.
    </EmptyState>
  );
}
