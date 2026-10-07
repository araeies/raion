import { api, type ServiceDetail, type User } from '../api';
import { ServiceAlerts } from './Alerts';
import { ServiceSlos } from './Slos';
import { Diagnostics, Disclosure } from '../components';
import { linkHandler } from '../router';
import { useLoad } from '../useLoad';
import { ConnectService, ServiceHealth } from './ServiceTelemetry';

const LEVEL_NAMES: Record<number, string> = { 1: 'Basic', 2: 'Production', 3: 'SRE' };

export function ServicesPage() {
  const result = useLoad(() => api.services(), 'services');
  if (result.state === 'loading') return <p aria-busy="true">Loading services…</p>;
  if (result.state === 'error')
    return <p role="alert">Could not load services: {result.error.message}</p>;
  const { services, diagnostics } = result.data;
  return (
    <>
      <h1>Services</h1>
      <p className="lead">
        A service is anything you run and want to observe: an API, a website, a worker. Everything
        Raion sets up — metrics, logs, traces, dashboards, alerts and SLOs — is organized around
        services.
      </p>
      <Diagnostics diagnostics={diagnostics} />
      {services.length === 0 ? (
        <div className="empty">
          <p>No services yet.</p>
          <p>
            Add one with <code>raion init --service my-api</code> or create a file in{' '}
            <code>services/</code>.
          </p>
        </div>
      ) : (
        <table>
          <caption className="visually-hidden">Services in this workspace</caption>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Type</th>
              <th scope="col">Team</th>
              <th scope="col">Tier</th>
              <th scope="col">Level</th>
              <th scope="col">SLOs</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr key={s.name}>
                <th scope="row">
                  <a href={`/services/${s.name}`} onClick={linkHandler(`/services/${s.name}`)}>
                    {s.name}
                  </a>
                </th>
                <td>
                  {s.type}
                  {s.language ? ` · ${s.language}` : ''}
                </td>
                <td>{s.team ?? <span className="muted">none</span>}</td>
                <td>{s.tier}</td>
                <td>
                  {s.level} · {LEVEL_NAMES[s.level]}
                </td>
                <td>{s.sloCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

export function ServiceDetailPage({ name, user }: { name: string; user: User }) {
  const result = useLoad<ServiceDetail>(() => api.service(name), `service:${name}`);
  if (result.state === 'loading') return <p aria-busy="true">Loading {name}…</p>;
  if (result.state === 'error')
    return (
      <p role="alert">
        Could not load {name}: {result.error.message}
      </p>
    );
  const { service, dependents, sources } = result.data;
  const enabled = Object.entries(service.features)
    .filter(([, on]) => on)
    .map(([flag]) => flag);
  return (
    <>
      <p>
        <a href="/services" onClick={linkHandler('/services')}>
          ← All services
        </a>
      </p>
      <h1>{service.name}</h1>
      {service.description && <p className="lead">{service.description}</p>}

      <dl className="properties">
        <dt>Type</dt>
        <dd>
          {service.type}
          {service.language ? ` · ${service.language}` : ''}
        </dd>
        <dt>Team</dt>
        <dd>{service.team ?? <span className="muted">not set</span>}</dd>
        <dt>Owner</dt>
        <dd>{service.owner ?? <span className="muted">not set</span>}</dd>
        <dt>Tier</dt>
        <dd>{service.tier}</dd>
        <dt>Environment</dt>
        <dd>{service.environment}</dd>
        <dt>Runs on</dt>
        <dd>{service.runtime.type === 'compose' ? 'Docker Compose' : 'Host'}</dd>
        <dt>Level</dt>
        <dd>
          {service.level} · {LEVEL_NAMES[service.level]}
        </dd>
        {service.repository && (
          <>
            <dt>Repository</dt>
            <dd>
              <a href={service.repository} rel="noreferrer noopener" target="_blank">
                {service.repository}
              </a>
            </dd>
          </>
        )}
      </dl>

      <section aria-labelledby="health-title">
        <h2 id="health-title">Health</h2>
        <p>
          <a href={`/grafana/d/raion-svc-${service.name}`} target="_blank" rel="noopener">
            Open the {service.name} dashboard in Grafana ↗
          </a>{' '}
          <span className="muted">
            — golden signals, routes, dependencies, runtime, logs and traces.
          </span>
        </p>
        <ServiceHealth name={service.name} />
      </section>

      <section aria-labelledby="alerts-title">
        <h2 id="alerts-title">Alerts</h2>
        <ServiceAlerts name={service.name} user={user} />
      </section>

      <section aria-labelledby="connect-title">
        <h2 id="connect-title">Connect this service</h2>
        <ConnectService name={service.name} />
      </section>

      <section aria-labelledby="slo-title">
        <h2 id="slo-title">Service level objectives</h2>
        <ServiceSlos name={service.name} user={user} />
      </section>

      <section aria-labelledby="deps-title">
        <h2 id="deps-title">Dependencies</h2>
        <div className="columns">
          <div>
            <h3>Depends on</h3>
            {service.dependencies.length === 0 ? (
              <p className="muted">None declared.</p>
            ) : (
              <ul>
                {service.dependencies.map((d) =>
                  'service' in d ? (
                    <li key={d.service}>
                      <a
                        href={`/services/${d.service}`}
                        onClick={linkHandler(`/services/${d.service}`)}
                      >
                        {d.service}
                      </a>
                    </li>
                  ) : (
                    <li key={d.external.name}>
                      {d.external.name} <span className="muted">({d.external.kind}, external)</span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>
          <div>
            <h3>Used by</h3>
            {dependents.length === 0 ? (
              <p className="muted">No other service declares a dependency on this one.</p>
            ) : (
              <ul>
                {dependents.map((d) => (
                  <li key={d}>
                    <a href={`/services/${d}`} onClick={linkHandler(`/services/${d}`)}>
                      {d}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="config-title">
        <h2 id="config-title">Configuration</h2>
        <p className="muted">Enabled features: {enabled.join(', ') || 'none'}</p>
        {sources.map((file) => (
          <Disclosure key={file.path} summary={`Show ${file.path}`}>
            <pre>
              <code>{file.content}</code>
            </pre>
          </Disclosure>
        ))}
      </section>
    </>
  );
}
