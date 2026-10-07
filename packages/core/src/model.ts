import type {
  AdvisorSettings,
  CollectorReceiver,
  FeatureFlags,
  IntegrationRef,
  Level,
  Receiver,
  ServiceSpec,
  Sli,
  Team,
  WorkspaceSpec,
} from '@raion/schema';
import type { LoadedIntegration, ResolvedCapability } from './integrations.js';

export interface SourceLocation {
  file: string;
  line?: number;
}

export interface ResolvedSlo {
  name: string;
  service: string;
  description?: string;
  /** What the team does when the error budget is spent. */
  policy?: string;
  sli: Sli;
  /** Objective as a percentage, e.g. 99.9. */
  target: number;
  window: string;
  windowMs: number;
  /** Allowed error ratio, e.g. 0.001 for a 99.9% objective. */
  errorBudgetRatio: number;
  source: SourceLocation;
}

export interface ResolvedIntegration {
  name: string;
  version: string;
  /** Parameters with defaults applied. Secret parameters hold the reference, never the value. */
  params: Record<string, boolean | string>;
  /** Set when the collector pulls this integration's telemetry (databases, proxies). */
  collector?: { receiver: CollectorReceiver };
  /** True when chosen automatically from the service's language. */
  implicit: boolean;
}

export interface ResolvedService {
  name: string;
  team?: string;
  owner?: string;
  description?: string;
  environment: string;
  tier: ServiceSpec['tier'];
  type: ServiceSpec['type'];
  language?: ServiceSpec['language'];
  repository?: string;
  runtime: NonNullable<ServiceSpec['runtime']>;
  level: Level;
  features: FeatureFlags;
  integrations: ResolvedIntegration[];
  /** What the service's integrations provide (e.g. http.server metrics). Drives generators. */
  capabilities: ResolvedCapability[];
  signals: ServiceSpec['signals'];
  /** Collect the container's stdout/stderr through Docker's logging driver. */
  containerLogs: boolean;
  dependencies: ServiceSpec['dependencies'];
  slos: ResolvedSlo[];
  runbooks: ServiceSpec['runbooks'];
  alerts: ServiceSpec['alerts'];
  source: SourceLocation;
}

/**
 * The resolved workspace: defaults applied, level presets expanded, SLOs attached to their
 * services, and cross-references checked. This is the input to every generator.
 */
export interface ResolvedWorkspace {
  name: string;
  description?: string;
  level: Level;
  environment: string;
  target: WorkspaceSpec['target'];
  infrastructure: WorkspaceSpec['infrastructure'];
  retention: WorkspaceSpec['retention'];
  server: WorkspaceSpec['server'];
  features: FeatureFlags;
  receivers: Receiver[];
  /** Receiver for alerts no team route claims (undefined: the Raion inbox only). */
  defaultReceiver?: string;
  teams: Team[];
  services: ResolvedService[];
  advisor: AdvisorSettings;
  /** The workspace's own integration packages (integrations/), checked against the lock file. */
  integrationPackages: LoadedIntegration[];
}

export function integrationName(ref: IntegrationRef): string {
  return typeof ref === 'string' ? ref : ref.name;
}
