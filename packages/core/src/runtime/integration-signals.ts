import type { CollectorReceiver } from '@raion/schema';
import type { ResolvedService } from '../model.js';
import { q, type PanelSpec, type RowSpec } from './dashboard-builder.js';

/**
 * Dashboards and alerts for services whose metrics the collector pulls (databases, caches,
 * proxies). Metric names are those the collector's receivers produce after Prometheus's
 * OTLP translation; they were checked against real PostgreSQL, Redis and Nginx instances.
 */

export function pulledReceiver(svc: ResolvedService): CollectorReceiver | undefined {
  return svc.integrations.find((i) => i.collector)?.collector?.receiver;
}

/** Collector component that reads the service; its scrape errors mean monitoring is broken. */
export function receiverId(svc: ResolvedService): string | undefined {
  const receiver = pulledReceiver(svc);
  return receiver ? `${receiver}/${svc.name}` : undefined;
}

/** A metric that is always present while the collector can read the service. */
export function presenceMetric(receiver: CollectorReceiver): string {
  switch (receiver) {
    case 'postgresql':
      return 'postgresql_backends';
    case 'redis':
      return 'redis_uptime_seconds_total';
    case 'nginx':
      return 'nginx_requests_total';
  }
}

const stat = (
  title: string,
  description: string,
  expr: string,
  unit: string,
  extra: Partial<PanelSpec> = {},
): PanelSpec => ({
  type: 'stat',
  title,
  description,
  datasource: 'prometheus',
  unit,
  width: 6,
  height: 5,
  targets: [{ refId: 'A', expr }],
  ...extra,
});

const series = (
  title: string,
  description: string,
  targets: { expr: string; legend: string }[],
  unit: string,
  extra: Partial<PanelSpec> = {},
): PanelSpec => ({
  type: 'timeseries',
  title,
  description,
  datasource: 'prometheus',
  unit,
  width: 12,
  targets: targets.map((t, i) => ({
    refId: String.fromCharCode(65 + i),
    expr: t.expr,
    legendFormat: t.legend,
  })),
  ...extra,
});

function postgresqlRows(sel: string): RowSpec[] {
  const db = 'postgresql_database_name';
  const hitRatio = (range: string) =>
    `sum(rate(postgresql_blks_hit_total{${sel}}[${range}])) / (sum(rate(postgresql_blks_hit_total{${sel}}[${range}])) + sum(rate(postgresql_blks_read_total{${sel}}[${range}])))`;
  return [
    {
      title: 'PostgreSQL',
      panels: [
        stat(
          'Connections used',
          'Open connections as a share of max_connections. New connections fail at 100%.',
          `sum(postgresql_backends{${sel}}) / max(postgresql_connection_max{${sel}})`,
          'percentunit',
          {
            thresholds: [
              { color: 'green', value: null },
              { color: 'orange', value: 0.7 },
              { color: 'red', value: 0.9 },
            ],
          },
        ),
        stat(
          'Transactions',
          'Committed and rolled-back transactions per second (last 5 minutes).',
          `sum(rate(postgresql_commits_total{${sel}}[5m])) + sum(rate(postgresql_rollbacks_total{${sel}}[5m]))`,
          'ops',
        ),
        stat(
          'Cache hit ratio',
          'Share of reads served from memory instead of disk. Below about 99% the working set may not fit in shared_buffers. Empty while nothing is read.',
          hitRatio('5m'),
          'percentunit',
          { expect: 'optional' },
        ),
        stat(
          'Database size',
          'Disk space used by all databases.',
          `sum(postgresql_db_size_bytes{${sel}})`,
          'bytes',
        ),
        series(
          'Connections by database',
          'Open connections, and the server limit (max_connections).',
          [
            { expr: `sum by (${db}) (postgresql_backends{${sel}})`, legend: `{{${db}}}` },
            { expr: `max(postgresql_connection_max{${sel}})`, legend: 'limit' },
          ],
          'short',
        ),
        series(
          'Transactions by database',
          'Commits and rollbacks per second. Many rollbacks usually mean application errors.',
          [
            {
              expr: `sum by (${db}) (rate(postgresql_commits_total{${sel}}[$__rate_interval]))`,
              legend: '{{postgresql_database_name}} commits',
            },
            {
              expr: `sum by (${db}) (rate(postgresql_rollbacks_total{${sel}}[$__rate_interval]))`,
              legend: '{{postgresql_database_name}} rollbacks',
            },
          ],
          'ops',
        ),
        series(
          'Rows read',
          'Rows returned to queries per second, by database.',
          [
            {
              expr: `sum by (${db}) (rate(postgresql_tup_fetched_total{${sel}}[$__rate_interval]))`,
              legend: `{{${db}}}`,
            },
          ],
          'short',
          { width: 8 },
        ),
        series(
          'Deadlocks',
          'Transactions aborted because they waited on each other. Should stay at zero.',
          [
            {
              expr: `sum by (${db}) (increase(postgresql_deadlocks_total{${sel}}[$__rate_interval]))`,
              legend: `{{${db}}}`,
            },
          ],
          'short',
          { width: 8 },
        ),
        series(
          'Size by database',
          'Disk space per database.',
          [{ expr: `sum by (${db}) (postgresql_db_size_bytes{${sel}})`, legend: `{{${db}}}` }],
          'bytes',
          { width: 8 },
        ),
      ],
    },
  ];
}

function redisRows(sel: string): RowSpec[] {
  const hits = `sum(rate(redis_keyspace_hits_total{${sel}}[$__rate_interval]))`;
  const misses = `sum(rate(redis_keyspace_misses_total{${sel}}[$__rate_interval]))`;
  return [
    {
      title: 'Redis',
      panels: [
        stat('Clients', 'Connected clients.', `sum(redis_clients_connected{${sel}})`, 'short'),
        stat(
          'Commands',
          'Commands processed per second (last 5 minutes).',
          `sum(rate(redis_commands_processed_total{${sel}}[5m]))`,
          'ops',
        ),
        stat(
          'Hit ratio',
          'Share of key lookups that found the key. A low ratio means the cache is not helping much. Empty while no keys are read.',
          `sum(rate(redis_keyspace_hits_total{${sel}}[5m])) / (sum(rate(redis_keyspace_hits_total{${sel}}[5m])) + sum(rate(redis_keyspace_misses_total{${sel}}[5m])))`,
          'percentunit',
          { expect: 'optional' },
        ),
        stat(
          'Memory used',
          'Memory used by data.',
          `sum(redis_memory_used_bytes{${sel}})`,
          'bytes',
        ),
        series(
          'Commands per second',
          'Load on Redis.',
          [
            {
              expr: `sum(rate(redis_commands_processed_total{${sel}}[$__rate_interval]))`,
              legend: 'commands',
            },
          ],
          'ops',
        ),
        series(
          'Memory',
          'Memory used, and the configured limit (maxmemory; absent when unlimited).',
          [
            { expr: `sum(redis_memory_used_bytes{${sel}})`, legend: 'used' },
            { expr: `sum(redis_maxmemory_bytes{${sel}}) > 0`, legend: 'limit' },
          ],
          'bytes',
        ),
        series(
          'Hit ratio',
          'Share of key lookups that found the key.',
          [{ expr: `${hits} / (${hits} + ${misses})`, legend: 'hit ratio' }],
          'percentunit',
          { width: 8, min: 0, max: 1, expect: 'optional' },
        ),
        series(
          'Evicted and expired keys',
          'Keys removed because memory was full (evicted) or their TTL ran out (expired).',
          [
            {
              expr: `sum(rate(redis_keys_evicted_total{${sel}}[$__rate_interval]))`,
              legend: 'evicted',
            },
            {
              expr: `sum(rate(redis_keys_expired_total{${sel}}[$__rate_interval]))`,
              legend: 'expired',
            },
          ],
          'ops',
          { width: 8 },
        ),
        series(
          'Rejected connections',
          'Connections refused because maxclients was reached. Should stay at zero.',
          [
            {
              expr: `sum(increase(redis_connections_rejected_total{${sel}}[$__rate_interval]))`,
              legend: 'rejected',
            },
          ],
          'short',
          { width: 8 },
        ),
      ],
    },
  ];
}

function nginxRows(sel: string): RowSpec[] {
  return [
    {
      title: 'Nginx',
      panels: [
        stat(
          'Requests',
          'Requests per second handled by Nginx (last 5 minutes).',
          `sum(rate(nginx_requests_total{${sel}}[5m]))`,
          'reqps',
          { width: 8 },
        ),
        stat(
          'Active connections',
          'Client connections open now.',
          `sum(nginx_connections_current{${sel},state="active"})`,
          'short',
          { width: 8 },
        ),
        stat(
          'Dropped connections',
          'Connections accepted but not handled in the last 5 minutes (worker_connections limit reached). Should stay at zero.',
          `sum(increase(nginx_connections_accepted_total{${sel}}[5m])) - sum(increase(nginx_connections_handled_total{${sel}}[5m]))`,
          'short',
          { width: 8 },
        ),
        series(
          'Requests per second',
          'All requests through Nginx. Status codes are not in stub_status; see the upstream services for errors.',
          [
            {
              expr: `sum(rate(nginx_requests_total{${sel}}[$__rate_interval]))`,
              legend: 'requests',
            },
          ],
          'reqps',
        ),
        series(
          'Connections by state',
          'Reading a request, writing a response, or waiting (keep-alive).',
          [
            {
              expr: `sum by (state) (nginx_connections_current{${sel},state!="active"})`,
              legend: '{{state}}',
            },
          ],
          'short',
          { stack: true },
        ),
      ],
    },
  ];
}

/** Dashboard rows for a pulled service, or none. */
export function integrationRows(svc: ResolvedService): RowSpec[] {
  const receiver = pulledReceiver(svc);
  const sel = `service_name=${q(svc.name)}`;
  switch (receiver) {
    case 'postgresql':
      return postgresqlRows(sel);
    case 'redis':
      return redisRows(sel);
    case 'nginx':
      return nginxRows(sel);
    case undefined:
      return [];
  }
}

export interface IntegrationAlert {
  alert: string;
  expr: string;
  for: string;
  severity: 'critical' | 'warning';
  summary: string;
  description: string;
}

/** Alerts for a pulled service. Severity of "the service cannot be read" follows its tier. */
export function integrationAlerts(svc: ResolvedService): IntegrationAlert[] {
  const receiver = pulledReceiver(svc);
  if (!receiver) return [];
  const sel = `service_name=${q(svc.name)}`;
  const id = q(`${receiver}/${svc.name}`);
  const alerts: IntegrationAlert[] = [
    {
      alert: 'ServiceUnreachable',
      // The collector's own count of data points read from the service stopped growing. This
      // also catches a service that was never readable (wrong endpoint or password). Its
      // "errored" counter is no help: a failed connection produces no points to count.
      expr: `sum(increase(otelcol_scraper_scraped_metric_points{receiver=${id}}[2m])) == 0`,
      for: '3m',
      severity: svc.tier === 'critical' ? 'critical' : 'warning',
      summary: `The collector cannot read ${svc.name}`,
      description:
        `Metrics of ${svc.name} could not be read for 5 minutes. Either ${svc.name} is down or unreachable, ` +
        'or its monitoring credentials are wrong. "raion verify --service" shows the reason; the collector\'s log has the details.',
    },
  ];
  switch (receiver) {
    case 'postgresql':
      alerts.push(
        {
          alert: 'PostgresConnectionsNearLimit',
          expr: `sum(postgresql_backends{${sel}}) / max(postgresql_connection_max{${sel}}) > 0.85`,
          for: '10m',
          severity: 'warning',
          summary: `${svc.name}: {{ $value | humanizePercentage }} of connections in use`,
          description: `Over 85% of max_connections of ${svc.name} have been in use for 10 minutes. When the limit is reached, new connections fail. Look for connection leaks, or use a connection pool.`,
        },
        {
          alert: 'PostgresDeadlocks',
          expr: `sum(increase(postgresql_deadlocks_total{${sel}}[10m])) > 0`,
          for: '0m',
          severity: 'warning',
          summary: `${svc.name}: {{ $value | humanize }} deadlocks in 10 minutes`,
          description: `Transactions on ${svc.name} were aborted because they waited on each other. The PostgreSQL log names the statements; take locks in a consistent order.`,
        },
      );
      break;
    case 'redis':
      alerts.push(
        {
          alert: 'RedisMemoryNearLimit',
          expr: `sum(redis_memory_used_bytes{${sel}}) / (sum(redis_maxmemory_bytes{${sel}}) > 0) > 0.9`,
          for: '10m',
          severity: 'warning',
          summary: `${svc.name}: {{ $value | humanizePercentage }} of maxmemory used`,
          description: `${svc.name} has used over 90% of maxmemory for 10 minutes. It will evict keys or reject writes, depending on its eviction policy.`,
        },
        {
          alert: 'RedisRejectingConnections',
          expr: `sum(increase(redis_connections_rejected_total{${sel}}[5m])) > 0`,
          for: '0m',
          severity: 'warning',
          summary: `${svc.name} rejected {{ $value | humanize }} connections`,
          description: `${svc.name} refused connections because maxclients was reached. Clients see errors.`,
        },
      );
      break;
    case 'nginx':
      alerts.push({
        alert: 'NginxDroppingConnections',
        expr: `(sum(increase(nginx_connections_accepted_total{${sel}}[5m])) - sum(increase(nginx_connections_handled_total{${sel}}[5m]))) > 0`,
        for: '0m',
        severity: 'warning',
        summary: `${svc.name} dropped {{ $value | humanize }} connections`,
        description: `${svc.name} accepted connections it could not handle (worker_connections limit). Clients see errors. Raise worker_connections or add capacity.`,
      });
      break;
  }
  return alerts;
}
