import type { ResolvedWorkspace } from '../model.js';
import type { ComponentId } from './images.js';

/**
 * Storage backends behind stable interfaces. Generators (collector pipelines, Grafana
 * datasources, rules) talk to these, never to a product directly — so replacing Prometheus
 * with Mimir means adding a MetricsBackend, not rewriting generators.
 */
interface Backend {
  component: ComponentId;
  /** Base URL inside the runtime network. */
  internalUrl: string;
  /** Path prefix on the Raion gateway. */
  gatewayPath: string;
  /** Grafana datasource UID (stable, so dashboards and links keep working). */
  datasourceUid: string;
}

export interface MetricsBackend extends Backend {
  kind: 'prometheus';
  otlpMetricsEndpoint: string;
  /** How alerting and recording rules are delivered: mounted files (Prometheus) or a ruler API (Mimir). */
  ruleLoading: 'files' | 'ruler-api';
}

export interface LogsBackend extends Backend {
  kind: 'loki';
  otlpLogsEndpoint: string;
}

export interface TracesBackend extends Backend {
  kind: 'tempo';
  otlpGrpcEndpoint: string;
}

export interface Backends {
  metrics: MetricsBackend;
  logs: LogsBackend;
  /** Absent when no service has tracing enabled. */
  traces?: TracesBackend;
}

export const PROMETHEUS: MetricsBackend = {
  kind: 'prometheus',
  component: 'prometheus',
  internalUrl: 'http://prometheus:9090',
  gatewayPath: '/prometheus',
  datasourceUid: 'raion-prometheus',
  otlpMetricsEndpoint: 'http://prometheus:9090/api/v1/otlp/v1/metrics',
  ruleLoading: 'files',
};

export const LOKI: LogsBackend = {
  kind: 'loki',
  component: 'loki',
  internalUrl: 'http://loki:3100',
  gatewayPath: '/loki',
  datasourceUid: 'raion-loki',
  otlpLogsEndpoint: 'http://loki:3100/otlp/v1/logs',
};

export const TEMPO: TracesBackend = {
  kind: 'tempo',
  component: 'tempo',
  internalUrl: 'http://tempo:3200',
  gatewayPath: '/tempo',
  datasourceUid: 'raion-tempo',
  otlpGrpcEndpoint: 'tempo:4317',
};

/** Tracing storage is only deployed when some service (or the workspace) enables traces. */
export function tracingEnabled(ws: ResolvedWorkspace): boolean {
  return ws.features.traces || ws.services.some((s) => s.features.traces && s.signals.traces);
}

export function selectBackends(ws: ResolvedWorkspace): Backends {
  return { metrics: PROMETHEUS, logs: LOKI, ...(tracingEnabled(ws) ? { traces: TEMPO } : {}) };
}
