import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/** Prometheus metrics about the Raion server itself. Labels use route templates, not raw URLs. */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'raion_' });

  const requests = new Counter({
    name: 'raion_http_requests_total',
    help: 'HTTP requests handled by the Raion server',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'raion_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  return {
    contentType: registry.contentType,
    observe(method: string, route: string, status: number, seconds: number) {
      requests.inc({ method, route, status_code: String(status) });
      duration.observe({ method, route }, seconds);
    },
    render: () => registry.metrics(),
  };
}
