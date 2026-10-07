import type { ComponentId } from './images.js';

/** One generated file. Paths are relative to the runtime directory and use forward slashes. */
export interface Artifact {
  path: string;
  content: string;
  /** The component that reads this file; changing it restarts that component. */
  component: ComponentId | 'compose';
  /** Short human description, shown by `raion render` and in the UI. */
  description: string;
  /** The component picks up changes by itself (e.g. Grafana dashboards): no restart needed. */
  live?: boolean;
}

export interface ComponentSpec {
  id: ComponentId;
  /** Plain-language explanation shown to users ("what is this and why is it here?"). */
  purpose: string;
  /** Path (via the gateway) that answers 2xx when the component is ready, if it has one. */
  readinessPath?: string;
  /** Prometheus scrape job that monitors this component. */
  scrapeJob?: string;
  /** Access beyond an ordinary container. Always disclosed in the plan. */
  privileges: string[];
  /** True when the privileges are high enough that applying needs explicit approval (--allow-privileged). */
  requiresApproval: boolean;
}

export interface RuntimeNote {
  severity: 'info' | 'warning';
  message: string;
}

/** Everything needed to run the observability stack for a workspace. Target-agnostic. */
export interface RuntimeBundle {
  components: ComponentSpec[];
  artifacts: Artifact[];
  notes: RuntimeNote[];
  /** Effective retention after automatic adjustments. */
  retention: { metrics: string; logs: string; traces: string };
  /** Secrets the runtime reads from the secret store (receiver credentials). */
  secrets: { key: string; source: 'secret' | 'env'; file: string; composeName: string }[];
  /** Generated alert rules, by group (also present as artifacts). */
  alerts: {
    group: string;
    alert: string;
    severity: string;
    service?: string;
    for?: string;
    summary: string;
  }[];
  /** Generated Grafana dashboards (also present as artifacts). */
  dashboards: { uid: string; title: string; service?: string }[];
}

/** Secret files the runtime expects. Their values never appear in artifacts. */
export const RUNTIME_SECRETS = {
  /** Shared secret between the Raion server/CLI and the gateway. */
  gatewayToken: 'gateway-token',
  /** nginx include that checks the gateway token. */
  gatewayAuthConf: 'gateway_auth.conf',
  /** Break-glass Grafana admin password (normal access is via Raion single sign-on). */
  grafanaAdminPassword: 'grafana-admin-password',
} as const;
