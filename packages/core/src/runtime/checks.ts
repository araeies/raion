/**
 * Outside checks: Prometheus' blackbox_exporter visits each check's address like a user would.
 * Every check becomes a Prometheus scrape job of the exporter's /probe endpoint, labelled with
 * its service, so alerts, reliability goals and dashboards use ordinary metrics:
 * probe_success, probe_duration_seconds, probe_http_status_code and
 * probe_ssl_earliest_cert_expiry.
 */
import type { ResolvedService, ResolvedWorkspace } from '../model.js';
import { q } from './dashboard-builder.js';
import type { Artifact } from './types.js';
import { GENERATED_HEADER, toYaml } from './yaml.js';

/** Where Prometheus reaches the exporter inside the Compose project. */
export const BLACKBOX_ADDRESS = 'blackbox-exporter:9115';

export function servicesWithChecks(ws: ResolvedWorkspace): ResolvedService[] {
  return ws.services.filter((s) => s.checks.length > 0);
}

const moduleName = (svc: string, index: number) => `check_${svc.replaceAll('-', '_')}_${index}`;

/** The selector of a service's check metrics. */
export const checkSelector = (svc: ResolvedService) =>
  `service_name=${q(svc.name)},raion_check="true"`;

export function blackboxConfig(ws: ResolvedWorkspace): Artifact {
  const modules: Record<string, unknown> = {};
  for (const svc of servicesWithChecks(ws)) {
    svc.checks.forEach((check, i) => {
      modules[moduleName(svc.name, i)] = {
        prober: 'http',
        timeout: check.timeout,
        http: {
          method: 'GET',
          // Empty means any 2xx.
          valid_status_codes: check.expectStatus ?? [],
          follow_redirects: true,
          preferred_ip_protocol: 'ip4',
          ip_protocol_fallback: true,
          // A check must fail when the certificate is invalid, as a browser would.
          tls_config: { insecure_skip_verify: false },
        },
      };
    });
  }
  return {
    path: 'blackbox-exporter/blackbox.yml',
    component: 'blackbox-exporter',
    description: 'Outside checks: how each address is visited and what counts as healthy',
    content: toYaml({ modules }, GENERATED_HEADER('blackbox_exporter modules (outside checks).')),
  };
}

/** One Prometheus scrape job per check: Prometheus asks the exporter to visit the address. */
export function probeScrapeConfigs(ws: ResolvedWorkspace): Record<string, unknown>[] {
  return servicesWithChecks(ws).flatMap((svc) =>
    svc.checks.map((check, i) => ({
      job_name: `raion-check-${svc.name}-${i}`,
      scrape_interval: check.interval,
      scrape_timeout: check.timeout,
      metrics_path: '/probe',
      params: { module: [moduleName(svc.name, i)] },
      static_configs: [
        {
          targets: [check.url],
          labels: { service_name: svc.name, raion_check: 'true' },
        },
      ],
      relabel_configs: [
        { source_labels: ['__address__'], target_label: '__param_target' },
        { source_labels: ['__param_target'], target_label: 'instance' },
        { target_label: '__address__', replacement: BLACKBOX_ADDRESS },
      ],
    })),
  );
}
