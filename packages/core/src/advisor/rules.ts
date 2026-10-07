import type { AdvisorRule } from '@raion/schema';
import { capabilityOf, registryFor } from '../integrations.js';
import { pulledReceiver } from '../runtime/integration-signals.js';
import type { SourceFile } from '../loader.js';
import type { ResolvedService, ResolvedWorkspace } from '../model.js';
import { renderSloDocument } from '../slo-authoring.js';
import { appendIn, change, editYaml, locateService, setIn } from './patch.js';
import type {
  AdvisorThresholds,
  Autofix,
  FileChange,
  Finding,
  FindingCategory,
  FindingSeverity,
  LiveFacts,
} from './types.js';

export interface RuleContext {
  ws: ResolvedWorkspace;
  files: readonly SourceFile[];
  facts?: LiveFacts;
  thresholds: AdvisorThresholds;
}

type Rule = (ctx: RuleContext) => Finding[];

interface FindingInput {
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  why: string;
  fix: string;
  evidence?: string;
  query?: string;
  docs?: string;
  autofix?: Autofix | undefined;
}

function finding(rule: AdvisorRule, subject: string, input: FindingInput): Finding {
  const { autofix, ...rest } = input;
  return { id: `${rule}/${subject}`, rule, subject, ...rest, ...(autofix ? { autofix } : {}) };
}

const percent = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`;
const rate = (perSecond: number): string =>
  perSecond >= 10 ? `${Math.round(perSecond)}/s` : `${perSecond.toFixed(2)}/s`;

function hasHttpMetrics(svc: ResolvedService): boolean {
  return capabilityOf(svc.capabilities, 'http.server') !== undefined;
}

interface ServiceEditor {
  set: (path: (string | number)[], value: unknown) => void;
  append: (path: (string | number)[], value: unknown) => void;
}

/** Edits a service's YAML. Returns undefined when the service cannot be located. */
function editService(
  ctx: RuleContext,
  service: string,
  edit: (editor: ServiceEditor) => void,
): FileChange | undefined {
  const location = locateService(ctx.files, service);
  if (!location) return undefined;
  return editYaml(location, (doc, base) => {
    edit({
      set: (path, value) => setIn(doc, [...base, ...path], value),
      append: (path, value) => appendIn(doc, [...base, ...path], value),
    });
  });
}

/**
 * A first availability SLO (99.9% over 30 days) as a new file. Also turns SLOs on for the
 * service when its level does not include them, so the SLO is measured after the next apply.
 */
function firstSloFix(ctx: RuleContext, svc: ResolvedService): Autofix | undefined {
  if (!hasHttpMetrics(svc) || !svc.signals.metrics) return undefined;
  const file = renderSloDocument({
    service: svc.name,
    name: 'availability',
    sli: { type: 'availability' },
    target: 99.9,
    window: '30d',
    description: `Requests to ${svc.name} that do not fail with a server error`,
  });
  if (ctx.files.some((f) => f.path === file.path)) return undefined;
  const changes: FileChange[] = [change(file.path, null, file.content)];
  if (!svc.features.slos) {
    const enable = editService(ctx, svc.name, ({ set }) => set(['features', 'slos'], true));
    if (!enable) return undefined;
    changes.push(enable);
  }
  return {
    summary: `Create a 99.9% availability SLO over 30 days for ${svc.name}${svc.features.slos ? '' : ' and turn on SLOs for it'}`,
    changes,
  };
}

const SLO_WHY =
  'Without an SLO nobody has agreed how reliable the service must be. Alerts then fire on symptoms that may not matter to users, and there is no error budget to weigh reliability work against new features.';

// ----- SLOs -------------------------------------------------------------------------------

const criticalServiceWithoutSlo: Rule = (ctx) =>
  ctx.ws.services
    .filter((svc) => svc.tier === 'critical' && svc.slos.length === 0)
    .map((svc) =>
      finding('critical-service-without-slo', svc.name, {
        severity: 'warning',
        category: 'slos',
        title: `${svc.name} is a critical service but has no SLO`,
        why: SLO_WHY,
        fix: hasHttpMetrics(svc)
          ? `Add an availability SLO. A 99.9% objective over 30 days is a common first choice; adjust it to what ${svc.name} achieves today.`
          : `Add a custom SLO with your own PromQL. Availability and latency SLOs need HTTP metrics, which no integration of ${svc.name} provides.`,
        docs: '10-slos.md',
        autofix: firstSloFix(ctx, svc),
      }),
    );

const busiestServiceWithoutSlo: Rule = (ctx) => {
  const rates = ctx.facts?.requestRates;
  if (!rates) return [];
  const [busiest] = ctx.ws.services
    .filter((svc) => (rates[svc.name] ?? 0) > 0)
    .sort((a, b) => (rates[b.name] ?? 0) - (rates[a.name] ?? 0));
  // A critical service without an SLO is already reported by its own rule.
  if (!busiest || busiest.slos.length > 0 || busiest.tier === 'critical') return [];
  return [
    finding('busiest-service-without-slo', busiest.name, {
      severity: 'warning',
      category: 'slos',
      title: `${busiest.name}, the service with the most traffic, has no SLO`,
      why: `${SLO_WHY} The busiest service is usually the one users notice first.`,
      fix: 'Add an availability SLO, and consider a latency SLO for the routes users wait on.',
      evidence: `${rate(rates[busiest.name]!)} requests over the last ${ctx.facts!.window}`,
      docs: '10-slos.md',
      autofix: firstSloFix(ctx, busiest),
    }),
  ];
};

const slosNotEvaluated: Rule = (ctx) =>
  ctx.ws.services
    .filter((svc) => svc.slos.length > 0 && !svc.features.slos)
    .map((svc) => {
      const enable = editService(ctx, svc.name, ({ set }) => set(['features', 'slos'], true));
      return finding('slos-not-evaluated', svc.name, {
        severity: 'warning',
        category: 'slos',
        title: `${svc.name} has ${svc.slos.length === 1 ? 'an SLO' : `${svc.slos.length} SLOs`} that ${svc.slos.length === 1 ? 'is' : 'are'} not measured`,
        why: `SLOs are evaluated from level 3, and ${svc.name} is at level ${svc.level}. The SLO is written down but has no error budget, dashboard or burn-rate alert.`,
        fix: `Set "features: { slos: true }" on ${svc.name} (or raise the level to 3), then apply.`,
        docs: '10-slos.md',
        autofix: enable
          ? { summary: `Turn on SLOs for ${svc.name}`, changes: [enable] }
          : undefined,
      });
    });

// ----- alerting ---------------------------------------------------------------------------

const serviceWithoutAlerts: Rule = (ctx) =>
  ctx.ws.services
    .filter(
      (svc) =>
        svc.signals.metrics &&
        hasHttpMetrics(svc) &&
        (!svc.alerts.enabled || !svc.features.basicAlerts),
    )
    .map((svc) => {
      const enable = editService(ctx, svc.name, ({ set }) => {
        if (!svc.alerts.enabled) set(['alerts', 'enabled'], true);
        if (!svc.features.basicAlerts) set(['features', 'basicAlerts'], true);
      });
      return finding('service-without-alerts', svc.name, {
        severity: svc.tier === 'critical' ? 'critical' : 'warning',
        category: 'alerting',
        title: `${svc.name} sends metrics but has no alerts`,
        why: 'Nobody is told when its error rate or latency rises, or when it stops sending telemetry. Problems are found by users first.',
        fix: `Turn its alerts back on (${!svc.alerts.enabled ? '"alerts: { enabled: true }"' : '"features: { basicAlerts: true }"'}). If they were too noisy, raise "alerts.errorRatePercent", "alerts.latencyP95Ms" or "alerts.for" instead.`,
        docs: '09-alerts.md',
        autofix: enable
          ? { summary: `Turn on the generated alerts for ${svc.name}`, changes: [enable] }
          : undefined,
      });
    });

const REQUEST_SERVING = new Set(['web', 'api', 'microservice']);

const serviceWithoutGoldenSignals: Rule = (ctx) =>
  ctx.ws.services
    .filter(
      (svc) =>
        svc.signals.metrics &&
        REQUEST_SERVING.has(svc.type) &&
        !hasHttpMetrics(svc) &&
        // Proxies such as Nginx are read by the collector instead.
        pulledReceiver(svc) === undefined,
    )
    .map((svc) => {
      const available = registryFor(ctx.ws).defaultFor(svc.language);
      const fix = !svc.language
        ? `Set "language" on ${svc.name}. Raion then picks the matching integration, if there is one.`
        : available
          ? `Add the "${available.manifest.metadata.name}" integration (or remove "integrations: []" so it is chosen from the language).`
          : `Raion has no ${svc.language} integration. Send telemetry with the OpenTelemetry SDK, or add your own integration package; logs and traces work, and a custom SLO can use your own metrics.`;
      return finding('service-without-golden-signals', svc.name, {
        severity: svc.tier === 'critical' ? 'warning' : 'info',
        category: 'coverage',
        title: `${svc.name} has no request rate, error or latency metrics`,
        why: 'Without HTTP metrics Raion cannot build its golden-signal dashboard, error-rate and latency alerts, or availability and latency SLOs.',
        fix,
        docs: '05-connecting-a-service.md',
      });
    });

/** A runbook entry for one missing alert, e.g. "- alert: ServiceUnreachable". */
function runbookExample(missing: string): string {
  const slo = /\(SLO "([^"]+)"\)/.exec(missing)?.[1];
  return slo ? `"- slo: ${slo}"` : `"- alert: ${missing}"`;
}

const pageAlertWithoutRunbook: Rule = (ctx) =>
  ctx.ws.services.flatMap((svc) => {
    const missing: string[] = [];
    const alertsOn = svc.alerts.enabled && svc.features.basicAlerts && svc.signals.metrics;
    if (alertsOn && pulledReceiver(svc) && svc.tier === 'critical') {
      if (!svc.runbooks.some((r) => r.alert === 'ServiceUnreachable')) {
        missing.push('ServiceUnreachable');
      }
    }
    if (alertsOn && hasHttpMetrics(svc) && svc.tier === 'critical') {
      const pages = [
        'ServiceHighErrorRate',
        ...(svc.alerts.missingTelemetry ? ['ServiceTelemetryMissing'] : []),
      ];
      missing.push(...pages.filter((a) => !svc.runbooks.some((r) => r.alert === a)));
    }
    if (svc.features.slos && svc.signals.metrics) {
      missing.push(
        ...svc.slos
          .filter((slo) => !svc.runbooks.some((r) => r.slo === slo.name))
          .map((slo) => `SLOErrorBudgetBurnFast (SLO "${slo.name}")`),
      );
    }
    if (missing.length === 0) return [];
    return [
      finding('page-alert-without-runbook', svc.name, {
        severity: 'info',
        category: 'alerting',
        title:
          missing.length === 1
            ? `An alert of ${svc.name} that pages someone has no runbook`
            : `${missing.length} alerts of ${svc.name} that page someone have no runbook`,
        why: 'A runbook tells the person on call what to check and how to mitigate. Without one, every incident starts from zero, often at night.',
        fix: `Add runbook links under "runbooks" of ${svc.name}, for example ${runbookExample(missing[0]!)} with a "url". They appear in the alert and its notification.`,
        evidence: `Without a runbook: ${missing.join(', ')}`,
        docs: '09-alerts.md',
      }),
    ];
  });

// ----- dependencies -----------------------------------------------------------------------

const DATABASE_KINDS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  redis: 'Redis',
  mongodb: 'MongoDB',
  elasticsearch: 'Elasticsearch',
  kafka: 'Kafka',
  rabbitmq: 'RabbitMQ',
};

/** Kinds Raion has an integration for, and the integration's name. */
const INTEGRATION_FOR_KIND: Record<string, string> = {
  postgresql: 'postgresql',
  postgres: 'postgresql',
  redis: 'redis',
};

function monitorAdvice(kind: string, name: string): string {
  const integration = INTEGRATION_FOR_KIND[kind];
  if (!integration) {
    return `Raion has no ${DATABASE_KINDS[kind] ?? kind} integration yet. Meanwhile, the calls to it are visible as spans in the callers' traces.`;
  }
  return (
    `Describe it as a service with the "${integration}" integration, so the collector reads its metrics with a read-only monitoring user: ` +
    `"- name: ${name}", "type: database", "integrations: [{ name: ${integration}, params: { endpoint: <host:port>${integration === 'postgresql' ? ', password: ${secret:NAME}' : ''} } }]". ` +
    `Then replace the external dependency with "- service: ${name}". See the integration's guide for the monitoring user.`
  );
}

const databaseNotMonitored: Rule = (ctx) => {
  const users = new Map<string, { kind: string; services: string[] }>();
  for (const svc of ctx.ws.services) {
    for (const dep of svc.dependencies) {
      if (!('external' in dep) || !DATABASE_KINDS[dep.external.kind]) continue;
      const entry = users.get(dep.external.name) ?? { kind: dep.external.kind, services: [] };
      entry.services.push(svc.name);
      users.set(dep.external.name, entry);
    }
  }
  const external = [...users].map(([name, { kind, services }]) =>
    finding('database-not-monitored', name, {
      severity: 'info',
      category: 'coverage',
      title: `${DATABASE_KINDS[kind]} "${name}" is not monitored`,
      why: `${services.join(', ')} ${services.length === 1 ? 'depends' : 'depend'} on it. When it slows down or runs out of connections, you see only the symptoms in the services, not the cause.`,
      fix: monitorAdvice(kind, name),
      docs: 'integrations/README.md',
    }),
  );
  // Services declared as databases that nothing reads.
  const declared = ctx.ws.services
    .filter(
      (svc) => svc.type === 'database' && !pulledReceiver(svc) && svc.capabilities.length === 0,
    )
    .map((svc) =>
      finding('database-not-monitored', svc.name, {
        severity: svc.tier === 'critical' ? 'warning' : 'info',
        category: 'coverage',
        title: `The database ${svc.name} is not monitored`,
        why: `Its dependents see slow queries and connection errors, but not the cause: connections, locks, cache and disk of ${svc.name} itself.`,
        fix: 'Add the integration for its engine (postgresql or redis), with an "endpoint" and a monitoring user. Other engines have no integration yet.',
        docs: 'integrations/README.md',
      }),
    );
  return [...external, ...declared];
};

const dependenciesNotTraced: Rule = (ctx) =>
  ctx.ws.services
    .filter(
      (svc) =>
        svc.dependencies.some((d) => 'service' in d) &&
        svc.signals.traces &&
        !(svc.features.traces && svc.features.serviceGraph),
    )
    .map((svc) => {
      const enable = editService(ctx, svc.name, ({ set }) => {
        if (!svc.features.traces) set(['features', 'traces'], true);
        if (!svc.features.serviceGraph) set(['features', 'serviceGraph'], true);
      });
      return finding('dependencies-not-traced', svc.name, {
        severity: 'info',
        category: 'dependencies',
        title: `The dependencies of ${svc.name} are declared but not traced`,
        why: `Without traces, the declared dependencies cannot be checked against reality, the service map stays empty, and a slow downstream call cannot be told apart from slowness in ${svc.name} itself.`,
        fix: `Turn on traces and the service graph for ${svc.name} (level 2 includes both), apply, then run "raion connect" again and restart the service so it starts sending traces.`,
        docs: '08-dashboards.md',
        autofix: enable
          ? { summary: `Turn on traces and the service graph for ${svc.name}`, changes: [enable] }
          : undefined,
      });
    });

const undeclaredDependency: Rule = (ctx) => {
  const edges = ctx.facts?.edges;
  if (!edges) return [];
  const byName = new Map(ctx.ws.services.map((s) => [s.name, s]));
  return edges
    .filter((e) => e.client !== e.server && e.requestsPerSecond > 0)
    .flatMap((e) => {
      const client = byName.get(e.client);
      if (!client || !byName.has(e.server)) return [];
      if (client.dependencies.some((d) => 'service' in d && d.service === e.server)) return [];
      const add = editService(ctx, client.name, ({ append }) =>
        append(['dependencies'], { service: e.server }),
      );
      return [
        finding('undeclared-dependency', `${e.client}->${e.server}`, {
          severity: 'info',
          category: 'dependencies',
          title: `${e.client} calls ${e.server}, but this dependency is not declared`,
          why: 'Declared dependencies document who is affected when a service fails, and drive the dependency panels on the dashboards. An undeclared one is a surprise during an incident.',
          fix: `Add "- service: ${e.server}" under "dependencies" of ${e.client}.`,
          evidence: `${rate(e.requestsPerSecond)} calls seen in traces over the last ${ctx.facts!.window}`,
          query: `sum by (client, server) (rate(traces_service_graph_request_total{client="${e.client}", server="${e.server}"}[5m]))`,
          docs: '08-dashboards.md',
          autofix: add
            ? { summary: `Declare that ${e.client} depends on ${e.server}`, changes: [add] }
            : undefined,
        }),
      ];
    });
};

const unusedDependency: Rule = (ctx) => {
  const { edges, requestRates } = ctx.facts ?? {};
  if (!edges || !requestRates) return [];
  const byName = new Map(ctx.ws.services.map((s) => [s.name, s]));
  const traced = (svc: ResolvedService | undefined): boolean =>
    svc !== undefined && svc.features.traces && svc.features.serviceGraph && svc.signals.traces;
  return ctx.ws.services.flatMap((svc) =>
    svc.dependencies.flatMap((dep) => {
      if (!('service' in dep)) return [];
      if (!traced(svc) || !traced(byName.get(dep.service))) return [];
      if ((requestRates[svc.name] ?? 0) <= 0) return [];
      const seen = edges.some(
        (e) => e.client === svc.name && e.server === dep.service && e.requestsPerSecond > 0,
      );
      if (seen) return [];
      return [
        finding('unused-dependency', `${svc.name}->${dep.service}`, {
          severity: 'info',
          category: 'dependencies',
          title: `${svc.name} declares a dependency on ${dep.service}, but no calls were seen`,
          why: 'Either the dependency is gone and the declaration is out of date, or the calls are not traced (for example, a client library without instrumentation), which hides them from the service map and traces.',
          fix: `If ${svc.name} no longer calls ${dep.service}, remove it from "dependencies". Otherwise check that the client it uses is instrumented. The call may also be rare; ignore this finding if so.`,
          evidence: `${svc.name} handled ${rate(requestRates[svc.name]!)} requests over the last ${ctx.facts!.window} without calling ${dep.service}`,
          docs: '08-dashboards.md',
        }),
      ];
    }),
  );
};

// ----- correlation ------------------------------------------------------------------------

const lowLogTraceCorrelation: Rule = (ctx) => {
  const logs = ctx.facts?.logs;
  if (!logs) return [];
  return ctx.ws.services.flatMap((svc) => {
    const counts = logs[svc.name];
    // Container output (containerLogs) never carries trace IDs; only SDK logs can.
    const expected =
      !svc.containerLogs &&
      pulledReceiver(svc) === undefined &&
      svc.features.traces &&
      svc.features.traceLogCorrelation &&
      svc.signals.traces &&
      svc.signals.logs;
    if (!expected || !counts || counts.lines < ctx.thresholds.minLogLines) return [];
    const ratio = counts.withTraceId / counts.lines;
    if (ratio >= ctx.thresholds.minLogTraceRatio) return [];
    const nodejs = svc.integrations.some((i) => i.name === 'nodejs');
    return [
      finding('low-log-trace-correlation', svc.name, {
        severity: 'warning',
        category: 'correlation',
        title: `${percent(1 - ratio)} of ${svc.name}'s log lines do not contain a trace ID`,
        why: 'A log line with a trace ID opens the request that wrote it in one click, with every service it touched. Without it, finding the logs of one failing request means guessing by time.',
        fix: nodejs
          ? 'Log through pino, winston or bunyan: the Node.js integration adds trace IDs to them automatically. console.log is not correlated. Lines written outside a request (for example at startup) never carry a trace ID.'
          : "Use a logging library that the service's OpenTelemetry SDK instruments, so trace and span IDs are added to each line written during a request.",
        evidence: `${counts.withTraceId} of ${counts.lines} log lines over the last ${ctx.facts!.window} carry a trace ID`,
        query: `{service_name="${svc.name}"} | trace_id = ""`,
        docs: '05-connecting-a-service.md',
      }),
    ];
  });
};

// ----- the pipeline -----------------------------------------------------------------------

const collectorDroppingTelemetry: Rule = (ctx) => {
  const c = ctx.facts?.collector;
  if (!c || c.received <= 0) return [];
  const dropped = c.refused + c.exportFailed;
  const ratio = dropped / c.received;
  if (dropped <= 0 || ratio < ctx.thresholds.maxDropRatio) return [];
  const causes: string[] = [];
  if (c.refused > 0) {
    causes.push(
      `${Math.round(c.refused)} items were refused on arrival: applications send faster than the collector's memory limit allows, or send malformed data`,
    );
  }
  if (c.exportFailed > 0) {
    causes.push(
      `${Math.round(c.exportFailed)} items could not be delivered: Prometheus, Loki or Tempo rejected them or did not answer`,
    );
  }
  return [
    finding('collector-dropping-telemetry', 'otel-collector', {
      severity: ratio >= 0.1 ? 'critical' : 'warning',
      category: 'pipeline',
      title: `The collector lost ${percent(ratio)} of the telemetry it received`,
      why: 'Lost telemetry leaves gaps in dashboards, can hide errors from alerts and SLOs, and makes traces incomplete.',
      fix: `${causes.join('. ')}. Run "raion status" and open the "Raion · Stack health" dashboard to see which signal and component are affected. If applications send bursts, reduce log volume or sample traces.`,
      evidence: `${Math.round(dropped)} of ${Math.round(c.received)} items over the last ${ctx.facts!.window}`,
      docs: '16-raion-health.md',
    }),
  ];
};

const highCardinalityMetric: Rule = (ctx) => {
  const card = ctx.facts?.cardinality;
  if (!card) return [];
  const metrics = card.metrics
    .filter((m) => m.series > ctx.thresholds.seriesPerMetric)
    .map((m) =>
      finding('high-cardinality-metric', m.name, {
        severity: 'warning',
        category: 'cost',
        title: `The metric ${m.name} has ${m.series.toLocaleString('en-US')} series`,
        why: 'Every combination of label values is stored as its own series. Too many make Prometheus slow and memory-hungry, and dashboards that use the metric time out.',
        fix: 'Find the label with many values (often a user ID, request ID or full URL) and remove it, or replace it with a bounded value such as the route template.',
        evidence: `Over ${ctx.thresholds.seriesPerMetric.toLocaleString('en-US')} series is reported`,
        query: `topk(10, count by (service_name, job) ({__name__="${m.name}"}))`,
      }),
    );
  const labels = card.labels
    .filter((l) => l.name !== '__name__' && l.values > ctx.thresholds.valuesPerLabel)
    .map((l) =>
      finding('high-cardinality-metric', `label:${l.name}`, {
        severity: 'warning',
        category: 'cost',
        title: `The label "${l.name}" has ${l.values.toLocaleString('en-US')} different values`,
        why: 'A label with unbounded values (IDs, timestamps, full URLs) creates a new series for each value, which makes Prometheus slow and memory-hungry.',
        fix: `Find the metrics that use "${l.name}" and remove the label, or replace it with a bounded value.`,
        evidence: `Over ${ctx.thresholds.valuesPerLabel.toLocaleString('en-US')} values is reported`,
        query: `topk(10, count by (__name__) ({${l.name}!=""}))`,
      }),
    );
  return [...metrics, ...labels];
};

export const RULES: Record<AdvisorRule, Rule> = {
  'critical-service-without-slo': criticalServiceWithoutSlo,
  'busiest-service-without-slo': busiestServiceWithoutSlo,
  'slos-not-evaluated': slosNotEvaluated,
  'service-without-alerts': serviceWithoutAlerts,
  'service-without-golden-signals': serviceWithoutGoldenSignals,
  'page-alert-without-runbook': pageAlertWithoutRunbook,
  'database-not-monitored': databaseNotMonitored,
  'dependencies-not-traced': dependenciesNotTraced,
  'undeclared-dependency': undeclaredDependency,
  'unused-dependency': unusedDependency,
  'low-log-trace-correlation': lowLogTraceCorrelation,
  'collector-dropping-telemetry': collectorDroppingTelemetry,
  'high-cardinality-metric': highCardinalityMetric,
};
