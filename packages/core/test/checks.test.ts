import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { connectService, generateRuntime, validateSources } from '../src/index.js';

function workspace(services: string) {
  return validateSources([
    {
      path: 'raion.yaml',
      content: `apiVersion: raion/v1alpha1\nkind: Workspace\nmetadata:\n  name: t\nspec:\n  level: 3\n  services:\n${services}`,
    },
  ]);
}

const REMOTE = `    - name: shop
      type: web
      tier: critical
      language: nodejs
      runtime: { type: remote }
      checks:
        - url: https://shop.example.com/health
          expectStatus: [200, 204]
          interval: 1m
      slos:
        - name: availability
          sli: { type: availability }
          target: 99.9
          window: 30d
`;

describe('outside checks', () => {
  it('watch an application that runs elsewhere, with nothing to install', () => {
    const result = workspace(REMOTE);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const ws = result.workspace!;
    const svc = ws.services[0]!;
    // Its language does not bring an in-app integration: nothing could send data from there.
    expect(svc.integrations).toEqual([]);
    expect(connectService(ws, svc)).toMatchObject({ supported: false, runtime: 'remote' });

    const bundle = generateRuntime(ws);
    expect(bundle.components.map((c) => c.id)).toContain('blackbox-exporter');
    const blackbox = parse(
      bundle.artifacts.find((a) => a.path === 'blackbox-exporter/blackbox.yml')!.content,
    ) as {
      modules: Record<string, { http: { valid_status_codes: number[]; tls_config: unknown } }>;
    };
    expect(blackbox.modules.check_shop_0!.http.valid_status_codes).toEqual([200, 204]);
    expect(blackbox.modules.check_shop_0!.http.tls_config).toEqual({ insecure_skip_verify: false });

    const prometheus = parse(
      bundle.artifacts.find((a) => a.path === 'prometheus/prometheus.yml')!.content,
    ) as {
      scrape_configs: {
        job_name: string;
        scrape_interval?: string;
        static_configs: { targets: string[]; labels?: Record<string, string> }[];
      }[];
    };
    const job = prometheus.scrape_configs.find((j) => j.job_name === 'raion-check-shop-0')!;
    expect(job.scrape_interval).toBe('1m');
    expect(job.static_configs[0]).toEqual({
      targets: ['https://shop.example.com/health'],
      labels: { service_name: 'shop', raion_check: 'true' },
    });
    expect(prometheus.scrape_configs.some((j) => j.job_name === 'blackbox-exporter')).toBe(true);

    const compose = parse(bundle.artifacts.find((a) => a.path === 'compose.yaml')!.content) as {
      services: Record<string, { cap_drop?: string[]; networks?: string[]; read_only?: boolean }>;
    };
    expect(compose.services['blackbox-exporter']).toMatchObject({
      cap_drop: ['ALL'],
      read_only: true,
    });
  });

  it('alert when the address is down, slow, or its certificate expires, explained', () => {
    const alerts = generateRuntime(workspace(REMOTE).workspace!).alerts.filter(
      (a) => a.service === 'shop',
    );
    const byName = Object.fromEntries(alerts.map((a) => [a.alert, a]));
    expect(byName.EndpointDown).toMatchObject({
      severity: 'critical',
      title: 'shop is down',
      for: '2m',
    });
    expect(byName.EndpointSlow!.title).toBe('shop is slow');
    expect(byName.CertificateExpiresSoon!.title).toBe('A security certificate expires soon');
    // No request-metric alerts for something that cannot send request metrics.
    expect(byName.ServiceHighErrorRate).toBeUndefined();
    // The reliability goal is measured with the checks.
    expect(byName.SLOErrorBudgetBurnFast).toBeDefined();
  });

  it('measure reliability goals from the checks', () => {
    const bundle = generateRuntime(workspace(REMOTE).workspace!);
    const slos = bundle.artifacts.find(
      (a) => a.path === 'prometheus/rules/raion-slos.yml',
    )!.content;
    expect(slos).toContain(
      '1 - avg(avg_over_time(probe_success{service_name="shop",raion_check="true"}[5m]))',
    );
  });

  it('need at least one address, and cannot collect container logs', () => {
    const missing = workspace(`    - name: shop
      type: web
      runtime: { type: remote }
`);
    expect(missing.diagnostics.map((d) => d.code)).toContain('RAI-E027');
    const logs = workspace(`    - name: shop
      type: web
      containerLogs: true
      runtime: { type: remote }
      checks: [{ url: https://shop.example.com }]
`);
    expect(logs.diagnostics.map((d) => d.code)).toContain('RAI-E024');
    const bad = workspace(`    - name: shop
      type: web
      runtime: { type: remote }
      checks: [{ url: ftp://shop.example.com }]
`);
    expect(bad.workspace).toBeUndefined();
  });

  it('also work for an application on this machine, next to its own metrics', () => {
    const bundle = generateRuntime(
      workspace(`    - name: shop
      type: api
      language: nodejs
      checks: [{ url: https://shop.example.com/health }]
`).workspace!,
    );
    const names = bundle.alerts.filter((a) => a.service === 'shop').map((a) => a.alert);
    expect(names).toEqual(expect.arrayContaining(['EndpointDown', 'ServiceHighErrorRate']));
  });

  it('are not deployed when no application has one', () => {
    const bundle = generateRuntime(
      workspace(`    - name: shop\n      type: api\n      language: nodejs\n`).workspace!,
    );
    expect(bundle.components.map((c) => c.id)).not.toContain('blackbox-exporter');
  });
});
