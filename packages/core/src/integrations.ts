import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { builtinIntegrationsDir } from '@raion/integrations';
import {
  integrationManifest,
  type CapabilityId,
  type IntegrationCapability,
  type IntegrationManifest,
  type ServiceSpec,
} from '@raion/schema';
import { parseDocument } from 'yaml';

/**
 * Variables an integration may reference with ${...}. Anything else is rejected when the
 * manifest is loaded, so a package can never read arbitrary data from the workspace.
 */
export const INTEGRATION_VARIABLES = [
  'service.name',
  'service.namespace',
  'environment',
  'resource.attributes',
  'otlp.httpEndpoint',
  'otlp.grpcEndpoint',
  'signals.metrics',
  'signals.logs',
  'signals.traces',
] as const;
export type IntegrationVariable = (typeof INTEGRATION_VARIABLES)[number];

const PLACEHOLDER = /\$\{([^}]*)\}/g;
const MAX_MANIFEST_BYTES = 256 * 1024;

export interface LoadedIntegration {
  manifest: IntegrationManifest;
  /** Directory of the package. */
  dir: string;
  /** Contents of the documentation file. */
  docs: string;
}

export class IntegrationLoadError extends Error {}

/** Placeholders used in a string, e.g. ["service.name"]. */
export function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** Substitutes ${variables} into a template. Unknown variables are an error, never left in place. */
export function interpolate(
  template: string,
  variables: Record<IntegrationVariable, string>,
): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    if (!(INTEGRATION_VARIABLES as readonly string[]).includes(key)) {
      throw new IntegrationLoadError(`unknown placeholder \${${key}}`);
    }
    return variables[key as IntegrationVariable];
  });
}

function checkManifest(manifest: IntegrationManifest): void {
  const env = manifest.spec.instrumentation?.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    const strings = typeof value === 'string' ? [value] : value.cases.map((c) => c.value);
    for (const s of strings) {
      for (const p of placeholders(s)) {
        if (!(INTEGRATION_VARIABLES as readonly string[]).includes(p)) {
          throw new IntegrationLoadError(
            `${manifest.metadata.name}: ${key} uses unknown placeholder \${${p}}`,
          );
        }
      }
    }
    if (typeof value !== 'string') {
      for (const c of value.cases) {
        if (c.when && !(c.when.param in manifest.spec.parameters)) {
          throw new IntegrationLoadError(
            `${manifest.metadata.name}: ${key} refers to unknown parameter "${c.when.param}"`,
          );
        }
      }
    }
  }
}

/** Parses and validates a manifest from its text; `origin` names it in errors. */
export function parseIntegration(
  content: string,
  origin: string,
  dir: string,
  readDocs: (file: string) => string | undefined,
): LoadedIntegration {
  if (Buffer.byteLength(content) > MAX_MANIFEST_BYTES) {
    throw new IntegrationLoadError(`${origin} is too large`);
  }
  const doc = parseDocument(content, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new IntegrationLoadError(`${origin}: ${doc.errors[0]!.message}`);
  const parsed = integrationManifest.safeParse(doc.toJS({ maxAliasCount: 50 }));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new IntegrationLoadError(`${origin}: ${issue.path.join('.')}: ${issue.message}`);
  }
  try {
    checkManifest(parsed.data);
  } catch (error) {
    throw new IntegrationLoadError(`${origin}: ${(error as Error).message}`);
  }
  return { manifest: parsed.data, dir, docs: readDocs(parsed.data.spec.docs) ?? '' };
}

/** Reads and validates one integration package directory. */
export function loadIntegration(dir: string): LoadedIntegration {
  const file = join(dir, 'integration.yaml');
  if (statSync(file).size > MAX_MANIFEST_BYTES)
    throw new IntegrationLoadError(`${file} is too large`);
  return parseIntegration(readFileSync(file, 'utf8'), file, dir, (docs) => {
    const path = join(dir, docs);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  });
}

export class IntegrationRegistry {
  readonly #byName = new Map<string, LoadedIntegration>();

  constructor(integrations: LoadedIntegration[]) {
    for (const i of integrations) {
      if (this.#byName.has(i.manifest.metadata.name)) {
        throw new IntegrationLoadError(
          `integration "${i.manifest.metadata.name}" is defined twice`,
        );
      }
      this.#byName.set(i.manifest.metadata.name, i);
    }
  }

  /** Loads every package (subdirectory with an integration.yaml) in a directory. */
  static fromDirectory(dir: string): IntegrationRegistry {
    const packages = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'integration.yaml')))
      .map((e) => loadIntegration(join(dir, e.name)));
    return new IntegrationRegistry(packages);
  }

  get(name: string): LoadedIntegration | undefined {
    return this.#byName.get(name);
  }

  names(): string[] {
    return [...this.#byName.keys()].sort();
  }

  /** The integration a service of this language uses when it lists none explicitly. */
  defaultFor(language: ServiceSpec['language']): LoadedIntegration | undefined {
    if (!language) return undefined;
    return [...this.#byName.values()].find((i) => i.manifest.spec.languages.includes(language));
  }
}

let builtin: IntegrationRegistry | undefined;

/** Raion's first-party integrations (loaded once). */
export function builtinRegistry(): IntegrationRegistry {
  builtin ??= IntegrationRegistry.fromDirectory(builtinIntegrationsDir);
  return builtin;
}

export interface ResolvedCapability {
  id: CapabilityId;
  /** Integration that provides it. */
  integration: string;
  definition: IntegrationCapability;
}

export function capabilityOf<T extends CapabilityId>(
  capabilities: readonly ResolvedCapability[],
  id: T,
): Extract<IntegrationCapability, { id: T }> | undefined {
  return capabilities.find((c) => c.id === id)?.definition as
    Extract<IntegrationCapability, { id: T }> | undefined;
}

/** Built-in integrations plus the workspace's own packages (integrations/). */
export function registryFor(ws: {
  integrationPackages: readonly LoadedIntegration[];
}): IntegrationRegistry {
  if (ws.integrationPackages.length === 0) return builtinRegistry();
  return new IntegrationRegistry([
    ...builtinRegistry()
      .names()
      .map((n) => builtinRegistry().get(n)!),
    ...ws.integrationPackages,
  ]);
}
