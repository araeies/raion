/** Alerts Raion generates for each service (used to validate runbook links). */
export const SERVICE_ALERT_NAMES = [
  'ServiceHighErrorRate',
  'ServiceHighLatency',
  'ServiceTelemetryMissing',
  // Databases, caches and proxies read by the collector.
  'ServiceUnreachable',
  'PostgresConnectionsNearLimit',
  'PostgresDeadlocks',
  'RedisMemoryNearLimit',
  'RedisRejectingConnections',
  'NginxDroppingConnections',
];
