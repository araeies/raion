import { integrationsApi, type IntegrationParameterView, type IntegrationView } from '../api';
import { ErrorMessage } from '../components';
import { Markdown } from '../markdown';
import { linkHandler } from '../router';
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

/** Every integration available to this workspace. */
export function IntegrationsPage() {
  const result = useIntegrations();
  if (result.state === 'loading') return <p aria-busy="true">Loading integrations…</p>;
  if (result.state === 'error') return <ErrorMessage error={result.error} />;
  return (
    <>
      <h1>Integrations</h1>
      <p className="lead">
        An integration connects a technology to Raion: how a service is connected, and what Raion
        can show and alert on for it. Choose one to see what it provides and how to use it.
      </p>
      <ul className="cards">
        {result.data.integrations.map((i) => (
          <li key={i.name} className="card">
            <h2 className="card-title">
              <a href={`/integrations/${i.name}`} onClick={linkHandler(`/integrations/${i.name}`)}>
                {i.displayName}
              </a>
            </h2>
            <p>
              <span className="badge">{KIND_TEXT[i.kind] ?? i.kind}</span>{' '}
              {i.source === 'workspace' && <span className="badge">your workspace</span>}
            </p>
            <p className="muted">
              {i.collects === 'pull' ? 'Read by the collector' : 'Sent by the application'}
              {i.languages.length > 0 ? ` · for ${i.languages.join(', ')} services` : ''}
            </p>
            <p className="muted">
              {i.services.length === 0
                ? 'Not used yet'
                : `Used by ${i.services.length} service${i.services.length === 1 ? '' : 's'}`}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

/** One integration: what it provides, how to configure it, and its documentation. */
export function IntegrationDetailPage({ name }: { name: string }) {
  const result = useIntegrations();
  if (result.state === 'loading') return <p aria-busy="true">Loading {name}…</p>;
  if (result.state === 'error') return <ErrorMessage error={result.error} />;
  const i = result.data.integrations.find((x) => x.name === name);
  if (!i) return <p role="alert">There is no integration called {name}.</p>;
  return (
    <>
      <p>
        <a href="/integrations" onClick={linkHandler('/integrations')}>
          ← All integrations
        </a>
      </p>
      <h1>{i.displayName}</h1>
      <p className="lead">{i.description}</p>
      <p className="muted">
        <code>{i.name}</code> {i.version} ·{' '}
        {i.source === 'built-in' ? 'included with Raion' : 'from your workspace'} ·{' '}
        {i.collects === 'pull' ? 'the collector reads it' : 'the application sends its telemetry'}
      </p>

      <section aria-labelledby="provides-title">
        <h2 id="provides-title">What you get</h2>
        <ul>
          {i.capabilities.map((c) => (
            <li key={c}>{CAPABILITY_TEXT[c] ?? c}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="use-title">
        <h2 id="use-title">Using it</h2>
        <p>
          {i.languages.length > 0 && i.parameters.length === 0
            ? `Services with language ${i.languages.join(' or ')} use it automatically. Add this to the service's file:`
            : "Add this to the service's file in services/, then run raion apply:"}
        </p>
        <pre>
          <code>{example(i)}</code>
        </pre>
        {i.requirements.length > 0 && (
          <>
            <h3>Setup</h3>
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
        <p className="muted">
          Then connect the service: <code>raion connect --out observability.override.yaml</code>,
          and check it with <code>raion verify --service &lt;name&gt;</code>.
        </p>
      </section>

      {i.parameters.length > 0 && (
        <section aria-labelledby="params-title">
          <h2 id="params-title">Parameters</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Parameter</th>
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
        </section>
      )}

      <section aria-labelledby="used-title">
        <h2 id="used-title">Services using it</h2>
        {i.services.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul>
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

      {i.docs && (
        <section aria-labelledby="docs-title">
          <h2 id="docs-title">Documentation</h2>
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
