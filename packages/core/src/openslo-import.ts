import { DNS_LABEL, parseDuration } from '@raion/schema';
import { parseAllDocuments } from 'yaml';
import { toYaml } from './runtime/yaml.js';

export interface ImportedSlo {
  /** Workspace-relative file to create, e.g. slos/shop-availability.yaml. */
  path: string;
  service: string;
  name: string;
  content: string;
}

export interface OpenSloImport {
  slos: ImportedSlo[];
  /** Constructs that could not be imported, with the reason. Nothing is dropped silently. */
  problems: string[];
}

type Doc = Record<string, unknown>;
const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Doc)[k] : undefined), o);

/** A string field, or '' when missing or not a string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function promQuery(source: unknown): string | undefined {
  const type = get(source, 'metricSource', 'type');
  if (typeof type !== 'string' || type.toLowerCase() !== 'prometheus') return undefined;
  const query = get(source, 'metricSource', 'spec', 'query');
  return typeof query === 'string' ? query : undefined;
}

function toName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/**
 * Converts OpenSLO v1 SLOs into Raion SLO documents with custom SLIs. Supported: ratioMetric
 * indicators (inline or referenced via indicatorRef) with Prometheus queries that already
 * return per-second rates (counter: false), rolling day windows, Occurrences budgeting and a
 * single objective. Everything else is reported, never guessed.
 */
export function fromOpenSlo(text: string, options: { service?: string } = {}): OpenSloImport {
  const result: OpenSloImport = { slos: [], problems: [] };
  const docs = parseAllDocuments(text, { uniqueKeys: true });
  const values: Doc[] = [];
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      result.problems.push(`YAML error: ${doc.errors[0]!.message.split('\n')[0]}`);
      continue;
    }
    const value = doc.toJS({ maxAliasCount: 50 }) as unknown;
    if (value && typeof value === 'object') values.push(value as Doc);
  }

  const slis = new Map<string, unknown>();
  for (const d of values) {
    if (d.kind === 'SLI' && typeof get(d, 'metadata', 'name') === 'string') {
      slis.set(get(d, 'metadata', 'name') as string, d.spec);
    }
  }

  for (const d of values) {
    if (d.kind !== 'SLO') continue;
    const sloName = str(get(d, 'metadata', 'name'));
    const where = `SLO "${sloName}"`;
    if (d.apiVersion !== 'openslo/v1') {
      result.problems.push(
        `${where}: only openslo/v1 is supported (found ${String(d.apiVersion)})`,
      );
      continue;
    }
    const spec = d.spec as Doc | undefined;
    const service = toName(options.service ?? str(spec?.service));
    if (!DNS_LABEL.test(service)) {
      result.problems.push(`${where}: no valid service; pass --service <name>`);
      continue;
    }
    const indicatorSpec = spec?.indicator
      ? get(spec.indicator, 'spec')
      : typeof spec?.indicatorRef === 'string'
        ? slis.get(spec.indicatorRef)
        : undefined;
    const ratio = get(indicatorSpec, 'ratioMetric') as Doc | undefined;
    if (!ratio) {
      result.problems.push(
        `${where}: only ratioMetric indicators can be imported (thresholdMetric and missing indicators cannot)`,
      );
      continue;
    }
    if (ratio.counter === true) {
      result.problems.push(
        `${where}: counter: true is not supported; use queries that return per-second rates, e.g. sum(rate(x[5m]))`,
      );
      continue;
    }
    const total = promQuery(ratio.total);
    const good = ratio.good ? promQuery(ratio.good) : undefined;
    const bad = ratio.bad ? promQuery(ratio.bad) : undefined;
    if (!total || (!good && !bad)) {
      result.problems.push(`${where}: good/bad and total must be Prometheus queries`);
      continue;
    }
    if ((spec?.budgetingMethod ?? 'Occurrences') !== 'Occurrences') {
      result.problems.push(`${where}: only Occurrences budgeting can be imported`);
      continue;
    }
    const windows = (spec?.timeWindow ?? []) as Doc[];
    const window = windows[0];
    const duration = str(window?.duration);
    const ms = parseDuration(duration);
    if (
      windows.length !== 1 ||
      window?.isRolling !== true ||
      ms === undefined ||
      ms % 86_400_000 !== 0
    ) {
      result.problems.push(
        `${where}: needs exactly one rolling time window in whole days (e.g. 30d)`,
      );
      continue;
    }
    const objectives = (spec?.objectives ?? []) as Doc[];
    const target = objectives[0]?.target;
    if (objectives.length !== 1 || typeof target !== 'number' || target <= 0 || target >= 1) {
      result.problems.push(`${where}: needs exactly one objective with a target between 0 and 1`);
      continue;
    }

    const prefix = `${service}-`;
    const name =
      toName(sloName.startsWith(prefix) ? sloName.slice(prefix.length) : sloName) || 'imported';
    const description = typeof spec?.description === 'string' ? spec.description : undefined;
    const content = toYaml(
      {
        apiVersion: 'raion/v1alpha1',
        kind: 'SLO',
        metadata: { name },
        spec: {
          service,
          ...(description ? { description } : {}),
          sli: { type: 'custom', ...(good ? { good } : { bad }), total },
          target: Number((target * 100).toPrecision(10)),
          window: duration,
        },
      },
      `Imported from OpenSLO "${sloName}" by "raion slo import".`,
    );
    result.slos.push({ path: `slos/${service}-${name}.yaml`, service, name, content });
  }
  if (values.every((d) => d.kind !== 'SLO')) result.problems.push('no OpenSLO SLO documents found');
  return result;
}
