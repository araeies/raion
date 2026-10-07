import type { AdvisorRule } from '@raion/schema';

export type FindingSeverity = 'critical' | 'warning' | 'info';

export type FindingCategory =
  'slos' | 'alerting' | 'coverage' | 'dependencies' | 'correlation' | 'pipeline' | 'cost';

/** One file the fix creates (`before: null`) or changes. */
export interface FileChange {
  /** Workspace-relative path with forward slashes. */
  path: string;
  /** Content the fix was computed from; applying refuses if the file changed since. */
  before: string | null;
  after: string;
  /** Unified diff of before → after, for review. */
  diff: string;
}

/** A change Raion can make for you: always to workspace files, never to the running stack. */
export interface Autofix {
  summary: string;
  changes: FileChange[];
}

export interface Finding {
  /** Stable identifier: `<rule>/<subject>`. */
  id: string;
  rule: AdvisorRule;
  severity: FindingSeverity;
  category: FindingCategory;
  /** What the finding is about: a service, a dependency (`a->b`), a metric or a component. */
  subject: string;
  /** What is wrong, in one sentence. */
  title: string;
  why: string;
  fix: string;
  /** What was observed, for findings based on live data. */
  evidence?: string;
  /** A query to look further in Grafana → Explore. */
  query?: string;
  /** Guide that explains the topic, relative to the docs folder. */
  docs?: string;
  autofix?: Autofix;
  /** Set when the workspace's `advisor.ignore` covers this finding. */
  ignored?: { reason: string };
}

/**
 * What the running stack reports. Collected through the gateway. Every part is optional:
 * a part can fail (or the stack may not be deployed) without hiding the others.
 */
export interface LiveFacts {
  collectedAt: string;
  /** Range the rates and counts cover, e.g. "1h". */
  window: string;
  /** Requests per second by service, for services with HTTP metrics. */
  requestRates?: Record<string, number>;
  /** Log lines by service, and how many of them carry a trace ID. */
  logs?: Record<string, { lines: number; withTraceId: number }>;
  /** Calls between services observed in traces (service graph). */
  edges?: { client: string; server: string; requestsPerSecond: number }[];
  /** Telemetry items handled by the collector over the window, all signals together. */
  collector?: { received: number; refused: number; exportFailed: number };
  /** Prometheus's top series counts. */
  cardinality?: {
    metrics: { name: string; series: number }[];
    labels: { name: string; values: number }[];
  };
  /** Facts that could not be collected, with the reason. */
  problems: string[];
}

export interface AdvisorThresholds {
  /** Below this share of log lines with a trace ID, correlation is reported. */
  minLogTraceRatio: number;
  /** Fewer log lines than this are too few to judge correlation. */
  minLogLines: number;
  /** Share of telemetry refused or not delivered that is reported. */
  maxDropRatio: number;
  seriesPerMetric: number;
  valuesPerLabel: number;
}

export const DEFAULT_THRESHOLDS: AdvisorThresholds = {
  minLogTraceRatio: 0.8,
  minLogLines: 20,
  maxDropRatio: 0.01,
  seriesPerMetric: 10_000,
  valuesPerLabel: 5_000,
};
