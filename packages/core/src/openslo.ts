import { stringify } from 'yaml';
import type { ResolvedWorkspace } from './model.js';
import { capabilityOf } from './integrations.js';
import { sliQueries, sloSupported } from './runtime/slo.js';

/** 99.9 → 0.999 (without floating-point noise such as 0.9990000000000001). */
function ratio(percent: number): number {
  return Number((percent / 100).toPrecision(10));
}

/**
 * Exports SLOs as OpenSLO v1 (https://openslo.com), the vendor-neutral SLO standard, so SLO
 * definitions can be reviewed, shared, or moved to another tool.
 *
 * - availability, latency, custom → ratioMetric (bad/total, already per-second rates), Occurrences
 * - throughput → thresholdMetric (requests/s) with a Timeslices objective of 5-minute slices
 */
export function toOpenSlo(ws: ResolvedWorkspace): string {
  const docs: Record<string, unknown>[] = [];
  for (const svc of ws.services) {
    const slos = svc.slos.filter((slo) => sloSupported(svc, slo));
    if (slos.length === 0) continue;
    docs.push({
      apiVersion: 'openslo/v1',
      kind: 'Service',
      metadata: { name: svc.name, displayName: svc.name },
      spec: { description: svc.description ?? `${svc.name} (${svc.type})` },
    });
    for (const slo of slos) {
      const id = `${svc.name}-${slo.name}`;
      const prometheus = (query: string) => ({
        metricSource: { type: 'Prometheus', spec: { query } },
      });
      const timeWindow = [{ duration: slo.window, isRolling: true }];
      let indicator: Record<string, unknown>;
      let objective: Record<string, unknown>;
      let budgetingMethod: string;

      if (slo.sli.type === 'throughput') {
        const m = capabilityOf(svc.capabilities, 'http.server')!.metrics.requestDuration;
        indicator = {
          thresholdMetric: prometheus(`sum(rate(${m.name}_count{service_name="${svc.name}"}[5m]))`),
        };
        objective = {
          displayName: slo.name,
          op: 'gte',
          value: slo.sli.minRequestsPerSecond,
          target: ratio(slo.target),
          timeSliceWindow: '5m',
        };
        budgetingMethod = 'Timeslices';
      } else {
        const { bad, total } = sliQueries(svc, slo);
        indicator = {
          ratioMetric: { counter: false, bad: prometheus(bad), total: prometheus(total) },
        };
        objective = { displayName: slo.name, target: ratio(slo.target) };
        budgetingMethod = 'Occurrences';
      }

      docs.push({
        apiVersion: 'openslo/v1',
        kind: 'SLO',
        metadata: {
          name: id,
          displayName: `${svc.name} ${slo.name}`,
          ...(svc.team ? { labels: { team: svc.team } } : {}),
        },
        spec: {
          description:
            slo.description ?? `${slo.target}% ${slo.sli.type} objective for ${svc.name}`,
          service: svc.name,
          indicator: { metadata: { name: `${id}-sli` }, spec: indicator },
          timeWindow,
          budgetingMethod,
          objectives: [objective],
        },
      });
    }
  }
  return docs.map((d) => stringify(d, { lineWidth: 0 })).join('---\n');
}
