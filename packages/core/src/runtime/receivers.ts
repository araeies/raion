import type { CollectorReceiver } from '@raion/schema';
import type { ResolvedService, ResolvedWorkspace } from '../model.js';
import { secretMount, type SecretMount } from './alerts.js';

/**
 * Resource attributes the receivers set that Prometheus must keep as labels. Without them,
 * the metrics of two databases on one server would collide on a single series.
 */
export const RECEIVER_RESOURCE_LABELS = ['postgresql.database.name'];

/** A service whose metrics the collector pulls (a database, cache or proxy). */
export interface PulledService {
  svc: ResolvedService;
  receiver: CollectorReceiver;
  params: Record<string, boolean | string>;
}

export function pulledServices(ws: ResolvedWorkspace): PulledService[] {
  return ws.services.flatMap((svc) => {
    if (!svc.signals.metrics) return [];
    const integration = svc.integrations.find((i) => i.collector);
    return integration?.collector
      ? [{ svc, receiver: integration.collector.receiver, params: integration.params }]
      : [];
  });
}

const str = (params: PulledService['params'], key: string): string | undefined => {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
};

/**
 * Receiver configuration, built here from validated parameters only (never copied from an
 * integration manifest). Credentials are referenced as ${file:...}: the collector reads them
 * from mounted secret files, so they never appear in generated configuration.
 */
function receiverConfig(
  p: PulledService,
  secret: (ref: string) => string,
): Record<string, unknown> {
  const password = str(p.params, 'password');
  const common = { endpoint: str(p.params, 'endpoint'), collection_interval: '15s' };
  switch (p.receiver) {
    case 'postgresql': {
      const tables = p.params.tableMetrics === true;
      return {
        ...common,
        transport: 'tcp',
        username: str(p.params, 'username'),
        ...(password ? { password: secret(password) } : {}),
        tls: { insecure: p.params.tls !== true },
        metrics: {
          // Database-level health: cache hit ratio, deadlocks, rows read.
          'postgresql.blks_hit': { enabled: true },
          'postgresql.blks_read': { enabled: true },
          'postgresql.deadlocks': { enabled: true },
          'postgresql.tup_fetched': { enabled: true },
          // Per-table and per-index metrics grow with the schema; opt-in.
          'postgresql.rows': { enabled: tables },
          'postgresql.operations': { enabled: tables },
          'postgresql.blocks_read': { enabled: tables },
          'postgresql.table.size': { enabled: tables },
          'postgresql.table.vacuum.count': { enabled: tables },
          'postgresql.index.scans': { enabled: tables },
          'postgresql.index.size': { enabled: tables },
        },
      };
    }
    case 'redis':
      return {
        ...common,
        ...(str(p.params, 'username') ? { username: str(p.params, 'username') } : {}),
        ...(password ? { password: secret(password) } : {}),
        tls: { insecure: p.params.tls !== true },
        metrics: { 'redis.maxmemory': { enabled: true } },
      };
    case 'nginx':
      return common;
  }
}

export interface ReceiverPipelines {
  receivers: Record<string, unknown>;
  processors: Record<string, unknown>;
  pipelines: Record<string, unknown>;
  /** Secret files the collector reads. */
  secrets: SecretMount[];
  /** True when a monitored service runs on the host, so the collector needs host.docker.internal. */
  hostAccess: boolean;
  /** True when some service's container logs arrive through Docker's fluentd logging driver. */
  containerLogs: boolean;
}

/** Port of the collector's Fluent Forward receiver inside the stack. */
export const FLUENT_FORWARD_PORT = 8006;

/** Services whose container stdout/stderr the collector receives. */
export function containerLogServices(ws: ResolvedWorkspace): ResolvedService[] {
  return ws.services.filter(
    (svc) =>
      svc.containerLogs && svc.runtime.type === 'compose' && svc.signals.logs && svc.features.logs,
  );
}

/** One receiver and one metrics pipeline per pulled service, labelled with the service's name. */
export function receiverPipelines(
  ws: ResolvedWorkspace,
  exporter: string,
  logsExporter = 'otlp_http/logs',
): ReceiverPipelines {
  const result: ReceiverPipelines = {
    receivers: {},
    processors: {},
    pipelines: {},
    secrets: [],
    hostAccess: false,
    containerLogs: false,
  };
  for (const p of pulledServices(ws)) {
    const name = p.svc.name;
    result.receivers[`${p.receiver}/${name}`] = receiverConfig(p, (ref) => {
      const mount = secretMount(ref);
      if (!result.secrets.some((m) => m.composeName === mount.composeName)) {
        result.secrets.push(mount);
      }
      return `\${file:${mount.containerPath}}`;
    });
    result.processors[`resource/${name}`] = {
      attributes: [
        { key: 'service.name', value: name, action: 'upsert' },
        { key: 'service.namespace', value: ws.name, action: 'upsert' },
        { key: 'deployment.environment.name', value: ws.environment, action: 'upsert' },
      ],
    };
    result.pipelines[`metrics/${name}`] = {
      receivers: [`${p.receiver}/${name}`],
      processors: ['memory_limiter', `resource/${name}`, 'batch'],
      exporters: [exporter],
    };
    if (p.svc.runtime.type === 'host') result.hostAccess = true;
  }

  // Container stdout/stderr, sent by Docker's fluentd logging driver with the service name
  // as the tag (set by "raion connect"). Lines with any other tag are dropped.
  const logged = containerLogServices(ws);
  if (logged.length > 0) {
    result.containerLogs = true;
    result.receivers.fluent_forward = { endpoint: `0.0.0.0:${FLUENT_FORWARD_PORT}` };
    const tags = logged.map((s) => s.name).join('|');
    result.processors['filter/containers'] = {
      error_mode: 'ignore',
      logs: { log_record: [`not IsMatch(attributes["fluent.tag"], "^(${tags})$")`] },
    };
    // One resource per service, named after the tag.
    result.processors['groupbyattrs/containers'] = { keys: ['fluent.tag'] };
    result.processors['resource/containers'] = {
      attributes: [
        { key: 'service.name', from_attribute: 'fluent.tag', action: 'upsert' },
        { key: 'service.namespace', value: ws.name, action: 'upsert' },
        { key: 'deployment.environment.name', value: ws.environment, action: 'upsert' },
        { key: 'fluent.tag', action: 'delete' },
      ],
    };
    result.pipelines['logs/containers'] = {
      receivers: ['fluent_forward'],
      processors: [
        'memory_limiter',
        'filter/containers',
        'groupbyattrs/containers',
        'resource/containers',
        'batch',
      ],
      exporters: [logsExporter],
    };
  }
  return result;
}
