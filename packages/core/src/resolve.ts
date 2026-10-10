import {
  INBOX_RECEIVER,
  parseDuration,
  parseSecretRef,
  presetFor,
  type FeatureFlags,
  type IntegrationParameter,
  type ParamValue,
  type ServiceSpec,
} from '@raion/schema';
import { CODES, type Diagnostic } from './diagnostics.js';
import { SERVICE_ALERT_NAMES } from './alert-names.js';
import type { ParsedDocument, ParsedSources } from './loader.js';
import {
  builtinRegistry,
  type IntegrationRegistry,
  type LoadedIntegration,
  type ResolvedCapability,
} from './integrations.js';
import type {
  ResolvedIntegration,
  ResolvedService,
  ResolvedSlo,
  ResolvedWorkspace,
} from './model.js';

type Path = (string | number)[];

interface ServiceEntry {
  name: string;
  spec: ServiceSpec;
  doc: ParsedDocument<unknown>;
  /** Path of the service spec inside its document. */
  base: Path;
}

interface SloEntry {
  service: string;
  slo: Omit<ResolvedSlo, 'service' | 'source' | 'windowMs' | 'errorBudgetRatio'>;
  doc: ParsedDocument<unknown>;
  base: Path;
  /** Path of the "service" reference, for standalone SLO documents. */
  serviceRefPath?: Path;
}

/**
 * Cross-reference checks and model resolution. Assumes every document already passed schema
 * validation. Returns a ResolvedWorkspace only when there are no errors.
 */
export function resolveWorkspace(
  parsed: ParsedSources,
  registry: IntegrationRegistry = builtinRegistry(),
  integrationPackages: LoadedIntegration[] = [],
): {
  workspace?: ResolvedWorkspace;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const ws = parsed.workspace;
  if (!ws) return { diagnostics };
  const spec = ws.value.spec;

  const at = (doc: ParsedDocument<unknown>, path: Path) => ({
    file: doc.file,
    ...(doc.locate(path) ?? { line: doc.line }),
    path,
  });
  const error = (
    code: string,
    doc: ParsedDocument<unknown>,
    path: Path,
    message: string,
    hint?: string,
  ) =>
    diagnostics.push({
      severity: 'error',
      code,
      message,
      ...(hint ? { hint } : {}),
      ...at(doc, path),
    });
  const warning = (
    code: string,
    doc: ParsedDocument<unknown>,
    path: Path,
    message: string,
    hint?: string,
  ) =>
    diagnostics.push({
      severity: 'warning',
      code,
      message,
      ...(hint ? { hint } : {}),
      ...at(doc, path),
    });

  // Receivers and teams --------------------------------------------------------------------
  const receiverNames = new Set<string>([INBOX_RECEIVER]);
  spec.notifications.receivers.forEach((r, i) => {
    if (receiverNames.has(r.name)) {
      error(
        CODES.DUPLICATE_NAME,
        ws,
        ['spec', 'notifications', 'receivers', i, 'name'],
        `receiver "${r.name}" is defined more than once`,
      );
    }
    receiverNames.add(r.name);
  });

  const defaultReceiver = spec.notifications.defaultReceiver;
  if (defaultReceiver && !receiverNames.has(defaultReceiver)) {
    error(
      CODES.UNKNOWN_RECEIVER,
      ws,
      ['spec', 'notifications', 'defaultReceiver'],
      `default receiver "${defaultReceiver}" is not defined`,
      suggest(defaultReceiver, receiverNames) ?? 'define it under spec.notifications.receivers',
    );
  }

  const teamNames = new Set<string>();
  spec.teams.forEach((team, i) => {
    if (teamNames.has(team.name)) {
      error(
        CODES.DUPLICATE_NAME,
        ws,
        ['spec', 'teams', i, 'name'],
        `team "${team.name}" is defined more than once`,
      );
    }
    teamNames.add(team.name);
    if (team.route && !receiverNames.has(team.route)) {
      error(
        CODES.UNKNOWN_RECEIVER,
        ws,
        ['spec', 'teams', i, 'route'],
        `team "${team.name}" routes alerts to unknown receiver "${team.route}"`,
        suggest(team.route, receiverNames) ??
          `define it under spec.notifications.receivers, or use "${INBOX_RECEIVER}"`,
      );
    }
  });

  // Services ------------------------------------------------------------------------------
  const services: ServiceEntry[] = [
    ...spec.services.map(({ name, ...serviceSpec }, i) => ({
      name,
      spec: serviceSpec,
      doc: ws,
      base: ['spec', 'services', i],
    })),
    ...parsed.services.map((d) => ({
      name: d.value.metadata.name,
      spec: d.value.spec,
      doc: d,
      base: ['spec'],
    })),
  ];

  const byName = new Map<string, ServiceEntry>();
  for (const svc of services) {
    const existing = byName.get(svc.name);
    if (existing) {
      error(
        CODES.DUPLICATE_SERVICE,
        svc.doc,
        svc.base,
        `service "${svc.name}" is defined more than once (also in ${existing.doc.file})`,
      );
      continue;
    }
    byName.set(svc.name, svc);
  }

  if (services.length === 0) {
    warning(
      CODES.NO_SERVICES,
      ws,
      ['spec'],
      'no services are defined yet; only infrastructure and platform health will be monitored',
      'add a service with "raion init --service <name>" or create services/<name>.yaml',
    );
  }

  for (const svc of byName.values()) {
    const s = svc.spec;
    if (s.team && teamNames.size > 0 && !teamNames.has(s.team)) {
      error(
        CODES.UNKNOWN_TEAM,
        svc.doc,
        [...svc.base, 'team'],
        `service "${svc.name}" belongs to unknown team "${s.team}"`,
        suggest(s.team, teamNames) ?? 'add the team under spec.teams in raion.yaml',
      );
    }
    if (s.environment && s.environment !== spec.environment) {
      error(
        CODES.ENVIRONMENT_MISMATCH,
        svc.doc,
        [...svc.base, 'environment'],
        `service "${svc.name}" is in environment "${s.environment}" but this workspace is "${spec.environment}"`,
        'a workspace manages one environment; use a separate workspace per environment',
      );
    }
    if (s.tier === 'critical' && !s.team && !s.owner) {
      warning(
        CODES.CRITICAL_WITHOUT_OWNER,
        svc.doc,
        [...svc.base, 'tier'],
        `critical service "${svc.name}" has no team or owner`,
        'set "team" or "owner" so alerts reach someone who can act on them',
      );
    }
    s.dependencies.forEach((dep, i) => {
      if (!('service' in dep)) return;
      const path = [...svc.base, 'dependencies', i, 'service'];
      if (dep.service === svc.name) {
        error(
          CODES.SELF_DEPENDENCY,
          svc.doc,
          path,
          `service "${svc.name}" lists itself as a dependency`,
        );
      } else if (!byName.has(dep.service)) {
        error(
          CODES.UNKNOWN_DEPENDENCY,
          svc.doc,
          path,
          `service "${svc.name}" depends on unknown service "${dep.service}"`,
          suggest(dep.service, byName.keys()) ??
            'define that service too, or declare it as external: { external: { name, kind } }',
        );
      }
    });
  }

  // SLOs ----------------------------------------------------------------------------------
  const sloEntries: SloEntry[] = [];
  for (const svc of byName.values()) {
    svc.spec.slos.forEach((slo, i) =>
      sloEntries.push({ service: svc.name, slo, doc: svc.doc, base: [...svc.base, 'slos', i] }),
    );
  }
  for (const d of parsed.slos) {
    const { service, ...rest } = d.value.spec;
    sloEntries.push({
      service,
      slo: { name: d.value.metadata.name, ...rest },
      doc: d,
      base: ['metadata', 'name'],
      serviceRefPath: ['spec', 'service'],
    });
  }

  const slosByService = new Map<string, ResolvedSlo[]>();
  for (const entry of sloEntries) {
    const svc = byName.get(entry.service);
    if (!svc) {
      error(
        CODES.SLO_UNKNOWN_SERVICE,
        entry.doc,
        entry.serviceRefPath ?? entry.base,
        `SLO "${entry.slo.name}" refers to unknown service "${entry.service}"`,
        suggest(entry.service, byName.keys()),
      );
      continue;
    }
    const list = slosByService.get(entry.service) ?? [];
    if (list.some((existing) => existing.name === entry.slo.name)) {
      error(
        CODES.DUPLICATE_SLO,
        entry.doc,
        entry.base,
        `service "${entry.service}" has more than one SLO named "${entry.slo.name}"`,
      );
      continue;
    }
    if (!svc.spec.signals.metrics) {
      error(
        CODES.SLO_WITHOUT_METRICS,
        entry.doc,
        entry.base,
        `SLO "${entry.slo.name}" needs metrics, but metrics are disabled for service "${entry.service}"`,
        'set signals.metrics: true for this service',
      );
    }
    const loc = entry.doc.locate(entry.base);
    list.push({
      ...entry.slo,
      service: entry.service,
      windowMs: parseDuration(entry.slo.window) ?? 0,
      errorBudgetRatio: round((100 - entry.slo.target) / 100),
      source: { file: entry.doc.file, ...(loc ? { line: loc.line } : {}) },
    });
    slosByService.set(entry.service, list);
  }

  // Runbooks and feature flags -----------------------------------------------------------
  const workspaceFeatures: FeatureFlags = {
    ...presetFor(spec.level),
    ...definedOnly(spec.features),
  };
  const resolvedServices: ResolvedService[] = [];

  for (const svc of byName.values()) {
    const s = svc.spec;
    const slos = slosByService.get(svc.name) ?? [];
    s.runbooks.forEach((rb, i) => {
      if (rb.alert && !SERVICE_ALERT_NAMES.includes(rb.alert)) {
        warning(
          CODES.RUNBOOK_UNKNOWN_ALERT,
          svc.doc,
          [...svc.base, 'runbooks', i, 'alert'],
          `runbook refers to alert "${rb.alert}", which Raion does not generate for services`,
          suggest(rb.alert, SERVICE_ALERT_NAMES) ??
            `service alerts: ${SERVICE_ALERT_NAMES.join(', ')}`,
        );
      }
      if (rb.slo && !slos.some((slo) => slo.name === rb.slo)) {
        error(
          CODES.RUNBOOK_UNKNOWN_SLO,
          svc.doc,
          [...svc.base, 'runbooks', i, 'slo'],
          `runbook refers to unknown SLO "${rb.slo}" of service "${svc.name}"`,
          suggest(
            rb.slo,
            slos.map((slo) => slo.name),
          ),
        );
      }
    });

    const level = s.level ?? spec.level;
    const features: FeatureFlags = {
      ...presetFor(level),
      ...definedOnly(spec.features),
      ...definedOnly(s.features),
    };
    if (slos.length > 0 && !features.slos) {
      warning(
        CODES.SLO_FEATURE_DISABLED,
        svc.doc,
        [...svc.base, 'slos'],
        `service "${svc.name}" defines ${slos.length} SLO(s), but SLOs are not enabled at level ${level}, so they will not be deployed`,
        'set "level: 3" or "features: { slos: true }"',
      );
    }

    // Integrations and capabilities ------------------------------------------------------
    const integrations: ResolvedIntegration[] = [];
    const capabilities: ResolvedCapability[] = [];
    const refs = s.integrations.map((ref, i) => ({
      name: typeof ref === 'string' ? ref : ref.name,
      version: typeof ref === 'string' ? undefined : ref.version,
      params: typeof ref === 'string' ? {} : (ref.params ?? {}),
      path: [...svc.base, 'integrations', i] as Path,
      implicit: false,
    }));
    if (refs.length === 0 && s.runtime?.type !== 'remote') {
      const implicit = registry.defaultFor(s.language);
      if (implicit) {
        refs.push({
          name: implicit.manifest.metadata.name,
          version: undefined,
          params: {},
          path: [...svc.base, 'language'],
          implicit: true,
        });
      }
    }
    for (const ref of refs) {
      const pkg = registry.get(ref.name);
      if (!pkg) {
        error(
          CODES.UNKNOWN_INTEGRATION,
          svc.doc,
          ref.path,
          `unknown integration "${ref.name}"`,
          suggest(ref.name, registry.names()) ??
            `available integrations: ${registry.names().join(', ')}`,
        );
        continue;
      }
      const manifest = pkg.manifest;
      if (ref.version !== undefined && ref.version !== manifest.metadata.version) {
        error(
          CODES.UNKNOWN_INTEGRATION,
          svc.doc,
          [...ref.path, 'version'],
          `integration "${ref.name}" version ${ref.version} is not available (this Raion includes ${manifest.metadata.version})`,
        );
      }
      const params: Record<string, ParamValue> = {};
      for (const [key, p] of Object.entries(manifest.spec.parameters)) {
        if (p.type === 'boolean') params[key] = p.default;
        else if (p.type === 'string' && p.default !== undefined) params[key] = p.default;
      }
      for (const [key, value] of Object.entries(ref.params)) {
        const definition = manifest.spec.parameters[key];
        const at = [...ref.path, 'params', key];
        if (!definition) {
          error(
            CODES.INVALID_INTEGRATION_PARAMS,
            svc.doc,
            at,
            `integration "${ref.name}" has no parameter "${key}"`,
            Object.keys(manifest.spec.parameters).length > 0
              ? `parameters: ${Object.keys(manifest.spec.parameters).join(', ')}`
              : 'this integration takes no parameters',
          );
          continue;
        }
        const problem = checkParam(definition, value);
        if (problem) {
          error(
            definition.type === 'secret' && typeof value === 'string'
              ? CODES.SCHEMA
              : CODES.INVALID_INTEGRATION_PARAMS,
            svc.doc,
            at,
            `parameter "${key}" ${problem}`,
            definition.type === 'secret'
              ? `store the value with "raion secrets set NAME" and write \${secret:NAME}`
              : undefined,
          );
        } else {
          params[key] = value as ParamValue;
        }
      }
      for (const [key, p] of Object.entries(manifest.spec.parameters)) {
        if (
          p.type !== 'boolean' &&
          p.required &&
          params[key] === undefined &&
          // An invalid value was already reported.
          !(key in ref.params)
        ) {
          error(
            CODES.INVALID_INTEGRATION_PARAMS,
            svc.doc,
            ref.path,
            `integration "${ref.name}" needs parameter "${key}": ${p.description}`,
          );
        }
      }
      if (
        manifest.spec.languages.length > 0 &&
        s.language &&
        !manifest.spec.languages.includes(s.language)
      ) {
        warning(
          CODES.INTEGRATION_LANGUAGE_MISMATCH,
          svc.doc,
          ref.path,
          `integration "${ref.name}" is for ${manifest.spec.languages.join(', ')}, but service "${svc.name}" is written in ${s.language}`,
        );
      }
      integrations.push({
        name: ref.name,
        version: manifest.metadata.version,
        params,
        implicit: ref.implicit,
        ...(manifest.spec.collector ? { collector: manifest.spec.collector } : {}),
      });
      for (const definition of manifest.spec.capabilities) {
        if (!capabilities.some((c) => c.id === definition.id)) {
          capabilities.push({ id: definition.id, integration: ref.name, definition });
        }
      }
    }

    // SLOs need request metrics; latency thresholds must match a histogram bucket.
    const httpServer = capabilities.find((c) => c.id === 'http.server')?.definition;
    for (const slo of slos) {
      if (slo.sli.type === 'custom') continue;
      const at = { file: slo.source.file, ...(slo.source.line ? { line: slo.source.line } : {}) };
      // Without request metrics, availability and speed can come from outside checks.
      if (
        (!httpServer || httpServer.id !== 'http.server') &&
        s.checks.length > 0 &&
        (slo.sli.type === 'availability' || slo.sli.type === 'latency')
      ) {
        continue;
      }
      if (!httpServer || httpServer.id !== 'http.server') {
        diagnostics.push({
          severity: 'warning',
          code: CODES.SLO_WITHOUT_HTTP_METRICS,
          ...at,
          message: `SLO "${slo.name}" needs HTTP request metrics, but no integration of service "${svc.name}" provides them, so it cannot be evaluated yet`,
          hint: `add an integration that provides http.server metrics (available: ${registry.names().join(', ')}), add an outside check (checks: [{ url: … }]) for an availability or latency goal, or use a custom SLI`,
        });
        continue;
      }
      if (slo.sli.type === 'latency') {
        const seconds = slo.sli.thresholdMs / 1000;
        const buckets = httpServer.metrics.requestDuration.buckets;
        if (!buckets.some((b) => Math.abs(b - seconds) < 1e-9)) {
          const nearest = [...buckets]
            .sort((a, b) => Math.abs(a - seconds) - Math.abs(b - seconds))
            .slice(0, 2);
          diagnostics.push({
            severity: 'error',
            code: CODES.LATENCY_THRESHOLD_NOT_BUCKET,
            ...at,
            message: `latency SLO "${slo.name}" uses ${slo.sli.thresholdMs}ms, but the ${httpServer.metrics.requestDuration.name} histogram only measures at ${buckets.map((b) => `${b * 1000}ms`).join(', ')}`,
            hint: `use ${nearest.map((b) => `${b * 1000}`).join(' or ')} for thresholdMs; a threshold between buckets cannot be measured exactly`,
          });
        }
      }
    }

    const loc = svc.doc.locate(svc.base);
    if (s.runtime?.type === 'remote') {
      if (s.checks.length === 0) {
        error(
          CODES.REMOTE_WITHOUT_CHECKS,
          svc.doc,
          [...svc.base, 'runtime'],
          `service "${svc.name}" runs elsewhere ("remote"), so Raion can only watch it from outside, but it has no checks`,
          'add its address under checks, e.g. "checks: [{ url: https://shop.example.com/health }]"',
        );
      }
      const pushed =
        capabilities.filter((c) => c.id !== 'logs.otlp').length > 0 && s.integrations.length > 0;
      if (pushed) {
        warning(
          CODES.REMOTE_INTEGRATION_IGNORED,
          svc.doc,
          [...svc.base, 'integrations'],
          `service "${svc.name}" runs elsewhere ("remote"); its integrations only work if the collector on this machine can reach it or it can reach the collector`,
          'keep them only if the network allows it; outside checks work in any case',
        );
      }
    }
    if (s.containerLogs && s.runtime?.type !== undefined && s.runtime.type !== 'compose') {
      error(
        CODES.CONTAINER_LOGS_NOT_COMPOSE,
        svc.doc,
        [...svc.base, 'containerLogs'],
        `service "${svc.name}" does not run in Docker Compose here, but containerLogs collects the logs of a Compose container`,
        'remove containerLogs, or send logs with an integration instead',
      );
    }
    if (
      s.containerLogs &&
      s.signals.logs &&
      features.logs &&
      capabilities.some((c) => c.id === 'logs.otlp')
    ) {
      warning(
        CODES.CONTAINER_LOGS_DUPLICATE,
        svc.doc,
        [...svc.base, 'containerLogs'],
        `service "${svc.name}" already sends its logs over OpenTelemetry (with trace IDs), so containerLogs would store each line twice`,
        'remove containerLogs, or set "signals: { logs: false }" to keep only the container output',
      );
    }
    resolvedServices.push({
      name: svc.name,
      ...optional('team', s.team),
      ...optional('owner', s.owner),
      ...optional('description', s.description),
      environment: spec.environment,
      tier: s.tier,
      type: s.type,
      ...optional('language', s.language),
      ...optional('repository', s.repository),
      runtime: s.runtime ?? { type: 'compose' },
      level,
      features,
      integrations,
      capabilities,
      signals: s.signals,
      containerLogs: s.containerLogs,
      checks: s.checks,
      dependencies: s.dependencies,
      slos,
      runbooks: s.runbooks,
      alerts: s.alerts,
      source: { file: svc.doc.file, ...(loc ? { line: loc.line } : {}) },
    });
  }

  // Team routes are an SRE-level feature (ownershipRouting); below it they would be ignored.
  const ownership =
    workspaceFeatures.ownershipRouting || resolvedServices.some((s) => s.features.ownershipRouting);
  if (!ownership) {
    spec.teams.forEach((team, i) => {
      if (team.route && team.route !== INBOX_RECEIVER) {
        warning(
          CODES.TEAM_ROUTE_IGNORED,
          ws,
          ['spec', 'teams', i, 'route'],
          `team "${team.name}" routes alerts to "${team.route}", but routing alerts to teams is only enabled at level 3`,
          'set "level: 3" or "features: { ownershipRouting: true }", or use notifications.defaultReceiver to send all alerts to one receiver',
        );
      }
    });
  }

  if (diagnostics.some((d) => d.severity === 'error')) return { diagnostics };

  return {
    diagnostics,
    workspace: {
      name: ws.value.metadata.name,
      ...optional('description', ws.value.metadata.description),
      level: spec.level,
      environment: spec.environment,
      target: spec.target,
      infrastructure: spec.infrastructure,
      retention: spec.retention,
      server: spec.server,
      features: workspaceFeatures,
      receivers: spec.notifications.receivers,
      ...optional('defaultReceiver', spec.notifications.defaultReceiver),
      teams: spec.teams,
      services: resolvedServices.sort((a, b) => a.name.localeCompare(b.name)),
      advisor: spec.advisor,
      integrationPackages,
    },
  };
}

function definedOnly<T extends object>(
  value: T | undefined,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/** Spreads `{ key: value }` only when value is defined, so resolved objects carry no undefined keys. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** "did you mean …?" based on edit distance. */
export function suggest(input: string, candidates: Iterable<string>): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(input, candidate);
    if (
      distance <= Math.max(2, Math.floor(input.length / 3)) &&
      (!best || distance < best.distance)
    ) {
      best = { name: candidate, distance };
    }
  }
  return best ? `did you mean "${best.name}"?` : undefined;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[b.length]!;
}

/** Why a value does not fit an integration parameter, or undefined when it does. */
function checkParam(p: IntegrationParameter, value: unknown): string | undefined {
  switch (p.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be true or false';
    case 'secret':
      return typeof value === 'string' && parseSecretRef(value)
        ? undefined
        : 'is a credential: use a reference such as ${secret:NAME}, never the value itself';
    case 'string': {
      if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
        return 'must be a non-empty text value';
      }
      if (p.format === 'hostPort' && !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(value)) {
        return 'must be host:port, e.g. "orders-db:5432"';
      }
      if (
        p.format === 'url' &&
        !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(value)
      ) {
        return 'must be an http(s) URL such as "http://edge:8080/nginx_status"';
      }
      if (p.format === 'identifier' && !/^[A-Za-z_][A-Za-z0-9_.@-]{0,62}$/.test(value)) {
        return 'must be a name of letters, digits, "_", ".", "@" or "-"';
      }
      return undefined;
    }
  }
}
