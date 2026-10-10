import { integrationsApi, type IntegrationParameterView, type IntegrationView } from '../api';
import { ErrorMessage } from '../components';
import { Markdown } from '../markdown';
import { linkHandler } from '../router';
import { Icon, Loading, PageHeader, Technical, type IconName } from '../ui';
import { useLoad } from '../useLoad';

const CAPABILITY_TEXT: Record<string, string> = {
  'http.server': 'Request rate, errors and latency per route',
  'http.client': 'Outgoing HTTP calls',
  'logs.otlp': 'Logs, linked to traces',
  'traces.otlp': 'Distributed traces',
  'runtime.nodejs': 'Node.js runtime health',
  'database.postgresql': 'PostgreSQL health',
  'cache.redis': 'Redis health',
  'proxy.nginx': 'Nginx traffic and connections',
};

const KIND_TEXT: Record<string, string> = {
  application: 'Application',
  database: 'Database',
  edge: 'Proxy',
  infrastructure: 'Infrastructure',
  cloud: 'Cloud',
  platform: 'Platform',
};

function useIntegrations() {
  return useLoad(() => integrationsApi.list(), 'integrations');
}

const KIND_ICON: Record<string, IconName> = {
  application: 'code',
  database: 'server',
  edge: 'globe',
  infrastructure: 'layers',
  cloud: 'cloud',
  platform: 'box',
};

/** Every integration available to this workspace. */
export function IntegrationsPage() {
  const result = useIntegrations();
  const header = (
    <PageHeader
      title="Integrations"
      description="The technologies Raion knows how to monitor. Raion picks the right one for each application automatically; this is what each provides."
      actions={
        <a className="button" href="/services/new" onClick={linkHandler('/services/new')}>
          <Icon name="plus" /> Add an application
        </a>
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
        <ErrorMessage error={result.error} />
      </>
    );
  return (
    <>
      {header}
      <div className="grid">
        {result.data.integrations.map((i) => (
          <a
            key={i.name}
            className="card card-link app-card"
            href={`/integrations/${i.name}`}
            onClick={linkHandler(`/integrations/${i.name}`)}
          >
            <div className="app-card-head">
              <span className="app-icon" aria-hidden="true">
                <Icon name={KIND_ICON[i.kind] ?? 'plug'} size={20} />
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <strong>{i.displayName}</strong>
                <span className="small muted">
                  {i.collects === 'pull' ? 'Read by the collector' : 'Sent by the application'}
                  {i.languages.length > 0 ? ` · for ${i.languages.join(', ')} services` : ''}
                </span>
              </div>
            </div>
            <div className="app-card-foot">
              <span className="pill">{KIND_TEXT[i.kind] ?? i.kind}</span>
              {i.source === 'workspace' && <span className="pill">Your workspace</span>}
              <span className="small muted">
                {i.services.length === 0
                  ? 'Not used yet'
                  : `Used by ${i.services.length} service${i.services.length === 1 ? '' : 's'}`}
              </span>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}

/** One integration: what it provides, how to configure it, and its documentation. */
export function IntegrationDetailPage({ name }: { name: string }) {
  const result = useIntegrations();
  const back = { href: '/integrations', label: 'Integrations' };
  if (result.state === 'loading') return <Loading label={`Loading ${name}…`} />;
  if (result.state === 'error') return <ErrorMessage error={result.error} />;
  const i = result.data.integrations.find((x) => x.name === name);
  if (!i)
    return (
      <>
        <PageHeader title={name} back={back} />
        <p className="notice notice-error" role="alert">
          There is no integration called {name}.
        </p>
      </>
    );
  return (
    <>
      <PageHeader
        back={back}
        title={i.displayName}
        description={i.description}
        actions={
          <a className="button" href="/services/new" onClick={linkHandler('/services/new')}>
            <Icon name="plus" /> Add an application
          </a>
        }
      />
      <div className="row" style={{ marginTop: -12, marginBottom: 20 }}>
        <span className="pill">{KIND_TEXT[i.kind] ?? i.kind}</span>
        <span className="pill">
          {i.source === 'built-in' ? 'Included with Raion' : 'From your workspace'}
        </span>
        <span className="pill">
          {i.collects === 'pull' ? 'Raion reads it' : 'The application sends its data'}
        </span>
      </div>

      <div className="grid-2">
        <section className="card" aria-labelledby="provides-title">
          <div className="card-header">
            <h2 id="provides-title">What you get</h2>
          </div>
          <ul className="checklist">
            {i.capabilities.map((c) => (
              <li key={c} className="done">
                <span className="check" aria-hidden="true">
                  <Icon name="check" size={14} />
                </span>
                {CAPABILITY_TEXT[c] ?? c}
              </li>
            ))}
          </ul>
        </section>

        <section className="card" aria-labelledby="used-title">
          <div className="card-header">
            <h2 id="used-title">Services using it</h2>
          </div>
          {i.services.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="attention-list">
              {i.services.map((s) => (
                <li key={s}>
                  <a href={`/services/${s}`} onClick={linkHandler(`/services/${s}`)}>
                    {s}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="use-title" style={{ marginTop: 20 }}>
        <div className="card-header">
          <div>
            <h2 id="use-title">Using it</h2>
            <span className="muted small">
              The easiest way: <strong>Add an application</strong> and answer the questions. Raion
              sets this integration up for you.
            </span>
          </div>
        </div>
        {i.requirements.length > 0 && (
          <>
            <h3>What it needs</h3>
            <ol>
              {i.requirements.map((r) => (
                <li key={r.description}>
                  {r.description}
                  {r.packages && (
                    <pre>
                      <code>
                        {installCommand(r.manager)} {r.packages.join(' ')}
                      </code>
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
        <Technical summary="In a workspace file">
          <p className="small muted" style={{ marginTop: 0 }}>
            {i.languages.length > 0 && i.parameters.length === 0
              ? `Services with language ${i.languages.join(' or ')} use it automatically. In the service's file:`
              : "In the service's file in services/ (then raion apply):"}
          </p>
          <pre style={{ margin: 0 }}>
            <code>{example(i)}</code>
          </pre>
        </Technical>
        {i.parameters.length > 0 && (
          <Technical summary={`Settings (${i.parameters.length})`}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Setting</th>
                    <th scope="col">Value</th>
                    <th scope="col">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {i.parameters.map((p) => (
                    <tr key={p.name}>
                      <th scope="row">
                        <code>{p.name}</code>
                      </th>
                      <td>{valueText(p)}</td>
                      <td>{p.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Technical>
        )}
      </section>

      {i.docs && (
        <section className="card markdown" aria-labelledby="docs-title" style={{ marginTop: 20 }}>
          <div className="card-header">
            <h2 id="docs-title">Guide</h2>
          </div>
          <Markdown source={i.docs.replace(/^#\s+.*\n/, '')} />
        </section>
      )}
    </>
  );
}

function installCommand(manager?: string): string {
  return manager === 'pip' ? 'pip install' : manager === 'go' ? 'go get' : 'npm install';
}

function valueText(p: IntegrationParameterView): string {
  const kind =
    p.type === 'secret'
      ? 'a secret reference, ${secret:NAME}'
      : p.type === 'boolean'
        ? 'true or false'
        : p.format === 'hostPort'
          ? 'host:port'
          : p.format === 'url'
            ? 'an http(s) URL'
            : 'a name';
  const extra = p.required
    ? 'required'
    : p.default !== undefined
      ? `default ${String(p.default)}`
      : 'optional';
  return `${kind}; ${extra}`;
}

function placeholder(p: IntegrationParameterView): string {
  if (p.type === 'secret') return '${secret:NAME}';
  if (p.type === 'boolean') return String(p.default ?? false);
  if (p.format === 'hostPort') return '<host:port>';
  if (p.format === 'url') return '<http://host:port/path>';
  return typeof p.default === 'string' ? p.default : '<name>';
}

/** A service file snippet that uses the integration, with its required parameters. */
export function example(i: IntegrationView): string {
  const required = i.parameters.filter((p) => p.required);
  if (i.languages.length > 0 && required.length === 0) {
    return `spec:\n  language: ${i.languages[0]}   # chooses the ${i.name} integration`;
  }
  const lines = ['spec:', '  integrations:', `    - name: ${i.name}`];
  if (required.length > 0) {
    lines.push('      params:');
    for (const p of required) lines.push(`        ${p.name}: ${placeholder(p)}`);
  }
  return lines.join('\n');
}
