import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  advise,
  composeOverride,
  connectService,
  generateRuntime,
  validateSources,
  type SourceFile,
} from '../src/index.js';

function files(services: string): SourceFile[] {
  return [
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: shop\nspec:\n  level: 2\n  services:\n${services}`,
    },
  ];
}

const DB = `    - name: orders-db
      type: database
      tier: critical
      team: orders
      integrations:
        - name: postgresql
          params:
            endpoint: orders-db:5432
            password: \${secret:ORDERS_DB_PASSWORD}
`;
const CACHE = `    - name: cache
      type: database
      runtime: { type: host }
      integrations:
        - name: redis
          params: { endpoint: "host.docker.internal:6379" }
`;
const EDGE = `    - name: edge
      type: web
      integrations:
        - name: nginx
          params: { endpoint: "http://edge:8080/nginx_status" }
`;

function workspace(services: string) {
  const result = validateSources(files(services));
  if (!result.workspace) throw new Error(JSON.stringify(result.diagnostics, null, 2));
  return result.workspace;
}

function errors(services: string): string[] {
  return validateSources(files(services))
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => `${d.code} ${d.message}`);
}

describe('integration parameters', () => {
  it('require the endpoint and the password of PostgreSQL', () => {
    expect(
      errors('    - name: db\n      type: database\n      integrations: [postgresql]\n'),
    ).toEqual([
      'RAI-E023 integration "postgresql" needs parameter "endpoint": Where the collector reaches PostgreSQL, e.g. "orders-db:5432".',
      'RAI-E023 integration "postgresql" needs parameter "password": The monitoring user\'s password, as ${secret:NAME}.',
    ]);
  });

  it('refuse a password written into the configuration', () => {
    expect(errors(DB.replace('${secret:ORDERS_DB_PASSWORD}', 'hunter2'))).toEqual([
      'RAI-E004 parameter "password" is a credential: use a reference such as ${secret:NAME}, never the value itself',
    ]);
  });

  it('refuse values the collector would expand, such as ${file:...}', () => {
    const sneaky = DB.replace(
      'endpoint: orders-db:5432',
      'endpoint: orders-db:5432\n            username: ${file:/etc/shadow}',
    );
    expect(errors(sneaky)[0]).toContain('parameter "username" must be a name');
    expect(
      errors(EDGE.replace('http://edge:8080/nginx_status', 'http://edge/${env:X}'))[0],
    ).toContain('must be an http(s) URL');
    expect(errors(CACHE.replace('host.docker.internal:6379', 'cache'))[0]).toContain(
      'must be host:port',
    );
  });
});

describe('collector receivers', () => {
  const bundle = generateRuntime(workspace(DB + CACHE + EDGE));
  const config = bundle.artifacts.find((a) => a.path === 'otel-collector/config.yaml')!.content;
  const collector = parse(config) as {
    receivers: Record<string, Record<string, unknown>>;
    processors: Record<string, { attributes: { key: string; value: string }[] }>;
    service: { pipelines: Record<string, { receivers: string[]; processors: string[] }> };
  };
  const compose = parse(bundle.artifacts.find((a) => a.path === 'compose.yaml')!.content) as {
    services: Record<string, { secrets?: string[]; extra_hosts?: string[] }>;
    secrets: Record<string, { file: string }>;
  };

  it('read each service in its own pipeline, labelled with the service name', () => {
    expect(Object.keys(collector.receivers).sort()).toEqual([
      'nginx/edge',
      'otlp',
      'postgresql/orders-db',
      'redis/cache',
    ]);
    expect(collector.service.pipelines['metrics/orders-db']).toEqual({
      receivers: ['postgresql/orders-db'],
      processors: ['memory_limiter', 'resource/orders-db', 'batch'],
      exporters: ['otlp_http/metrics'],
    });
    expect(collector.processors['resource/orders-db']!.attributes[0]).toEqual({
      key: 'service.name',
      value: 'orders-db',
      action: 'upsert',
    });
  });

  it('read credentials from secret files; the value never appears', () => {
    expect(collector.receivers['postgresql/orders-db']!.password).toBe(
      '${file:/run/secrets/raion_secret_orders_db_password}',
    );
    expect(compose.services['otel-collector']!.secrets).toEqual([
      'raion_secret_orders_db_password',
    ]);
    expect(compose.secrets.raion_secret_orders_db_password).toEqual({
      file: '../secrets/ORDERS_DB_PASSWORD',
    });
    expect(bundle.secrets.map((s) => s.key)).toContain('ORDERS_DB_PASSWORD');
  });

  it('keep per-table metrics off unless asked, and let databases on the host be reached', () => {
    const pg = collector.receivers['postgresql/orders-db']!.metrics as Record<string, unknown>;
    expect(pg['postgresql.table.size']).toEqual({ enabled: false });
    expect(compose.services['otel-collector']!.extra_hosts).toEqual([
      'host.docker.internal:host-gateway',
    ]);
    const noHost = generateRuntime(workspace(DB)).artifacts.find((a) => a.path === 'compose.yaml')!;
    expect(noHost.content).not.toContain('extra_hosts');
  });

  it('generate dashboards and alerts that match each kind', () => {
    const dashboard = bundle.artifacts.find((a) => a.path.endsWith('raion-svc-orders-db.json'));
    expect(dashboard?.content).toContain('postgresql_backends');
    expect(dashboard?.content).not.toContain('"title": "Logs"');
    const services = bundle.alerts.filter((a) => a.service === 'orders-db').map((a) => a.alert);
    expect(services).toEqual([
      'ServiceUnreachable',
      'PostgresConnectionsNearLimit',
      'PostgresDeadlocks',
    ]);
    expect(bundle.alerts.find((a) => a.service === 'orders-db')!.severity).toBe('critical');
    expect(bundle.alerts.filter((a) => a.service === 'edge').map((a) => a.alert)).toEqual([
      'ServiceUnreachable',
      'NginxDroppingConnections',
    ]);
  });
});

describe('connecting pulled services', () => {
  const ws = workspace(DB + EDGE);
  it('only joins the observability network; no environment for the database', () => {
    const connection = connectService(
      ws,
      ws.services.find((s) => s.name === 'orders-db')!,
    );
    expect(connection).toMatchObject({ mode: 'pull', supported: true, env: [] });
    expect(connection.requirements[0]!.kind).toBe('setup');
    const override = parse(composeOverride(ws, [connection])) as {
      services: Record<string, Record<string, unknown>>;
    };
    expect(override.services['orders-db']).toEqual({
      networks: { default: {}, 'raion-ingest': {} },
    });
  });
});

describe('advisor with pulled services', () => {
  it('does not ask a proxy for HTTP metrics, and flags an unmonitored database', () => {
    const sources = files(
      `${EDGE}    - name: legacy-db\n      type: database\n    - name: api\n      type: api\n      language: nodejs\n      dependencies:\n        - external: { name: sessions, kind: redis }\n`,
    );
    const ws = validateSources(sources).workspace!;
    const report = advise(ws, sources);
    const ids = report.findings.map((f) => f.id);
    expect(ids).not.toContain('service-without-golden-signals/edge');
    expect(ids).toContain('database-not-monitored/legacy-db');
    const sessions = report.findings.find((f) => f.id === 'database-not-monitored/sessions')!;
    expect(sessions.fix).toContain('"redis" integration');
  });
});

describe('container logs', () => {
  const EDGE_LOGS = EDGE.replace(
    '      type: web\n',
    '      type: web\n      containerLogs: true\n',
  );

  it('are only for Compose services, and warn when the service already sends logs', () => {
    expect(
      errors(
        CACHE.replace(
          '      type: database\n',
          '      type: database\n      containerLogs: true\n',
        ),
      ),
    ).toEqual([
      'RAI-E024 service "cache" runs on the host, but containerLogs collects the logs of a Compose container',
    ]);
    const duplicate = validateSources(
      files(
        '    - name: api\n      type: api\n      language: python\n      containerLogs: true\n',
      ),
    ).diagnostics.map((d) => d.code);
    expect(duplicate).toContain('RAI-W108');
  });

  it('arrive through a loopback-only Fluent Forward receiver that accepts only known services', () => {
    const bundle = generateRuntime(workspace(EDGE_LOGS + DB));
    const collector = parse(
      bundle.artifacts.find((a) => a.path === 'otel-collector/config.yaml')!.content,
    ) as {
      receivers: Record<string, unknown>;
      processors: Record<string, { logs?: { log_record: string[] } }>;
      service: { pipelines: Record<string, { receivers: string[] }> };
    };
    expect(collector.receivers.fluent_forward).toEqual({ endpoint: '0.0.0.0:8006' });
    expect(collector.processors['filter/containers']!.logs!.log_record).toEqual([
      'not IsMatch(attributes["fluent.tag"], "^(edge)$")',
    ]);
    expect(collector.service.pipelines['logs/containers']!.receivers).toEqual(['fluent_forward']);
    const compose = bundle.artifacts.find((a) => a.path === 'compose.yaml')!.content;
    expect(compose).toContain('127.0.0.1:24224:8006');
    // Without containerLogs, nothing listens.
    const without = generateRuntime(workspace(EDGE + DB));
    expect(without.artifacts.find((a) => a.path === 'compose.yaml')!.content).not.toContain(
      '24224',
    );
  });

  it('are sent by the logging driver set in the override, which never blocks the container', () => {
    const ws = workspace(EDGE_LOGS);
    const connection = connectService(ws, ws.services[0]!);
    const override = parse(composeOverride(ws, [connection])) as {
      services: Record<string, { logging: unknown }>;
    };
    expect(override.services.edge!.logging).toEqual({
      driver: 'fluentd',
      options: { 'fluentd-address': '127.0.0.1:24224', 'fluentd-async': 'true', tag: 'edge' },
    });
  });

  it('are not expected to carry trace IDs', () => {
    const sources = files(EDGE_LOGS);
    const ws = validateSources(sources).workspace!;
    const report = advise(ws, sources, {
      facts: {
        collectedAt: 'now',
        window: '1h',
        problems: [],
        logs: { edge: { lines: 500, withTraceId: 0 } },
      },
    });
    expect(report.findings.some((f) => f.rule === 'low-log-trace-correlation')).toBe(false);
  });
});
