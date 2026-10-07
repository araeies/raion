import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  documentHeader,
  documentSchemas,
  type ServiceDocument,
  type SloDocument,
  type WorkspaceDocument,
} from '@raion/schema';
import { Document, LineCounter, isNode, parseAllDocuments, type Node } from 'yaml';
import type { ZodError } from 'zod';
import { CODES, type Diagnostic } from './diagnostics.js';
import { isPackageFile } from './integration-packages.js';

export const WORKSPACE_FILE = 'raion.yaml';
/** Directories scanned for additional Service and SLO documents. */
export const DOCUMENT_DIRS = ['services', 'slos'] as const;

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 2000;
/** Guards against "billion laughs" alias expansion. */
const MAX_ALIAS_COUNT = 100;

export interface SourceFile {
  /** Workspace-relative path with forward slashes. */
  path: string;
  content: string;
}

export interface ParsedDocument<T> {
  value: T;
  file: string;
  /** 1-based line of the document start. */
  line: number;
  /** Finds the position of a path inside this document (closest existing ancestor). */
  locate: (path: (string | number)[]) => { line: number; column: number } | undefined;
}

export interface ParsedSources {
  workspace?: ParsedDocument<WorkspaceDocument>;
  services: ParsedDocument<ServiceDocument>[];
  slos: ParsedDocument<SloDocument>[];
  diagnostics: Diagnostic[];
}

/** Reads raion.yaml plus services/ and slos/ from a workspace directory. */
export async function readWorkspaceSources(
  dir: string,
): Promise<{ files: SourceFile[]; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const files: SourceFile[] = [];
  const paths: string[] = [];

  try {
    await stat(join(dir, WORKSPACE_FILE));
    paths.push(join(dir, WORKSPACE_FILE));
  } catch {
    diagnostics.push({
      severity: 'error',
      code: CODES.MISSING_WORKSPACE_FILE,
      message: `no ${WORKSPACE_FILE} found in ${dir}`,
      hint: 'run "raion init" to create a workspace, or pass the directory that contains raion.yaml',
    });
    return { files, diagnostics };
  }

  for (const sub of DOCUMENT_DIRS) {
    paths.push(...(await listYamlFiles(join(dir, sub))));
  }
  // The workspace's own integration packages (one directory each) and their lock file.
  paths.push(...(await listPackageFiles(join(dir, 'integrations'))));
  try {
    await stat(join(dir, 'integrations.lock.yaml'));
    paths.push(join(dir, 'integrations.lock.yaml'));
  } catch {
    // no lock file
  }

  if (paths.length > MAX_FILES) {
    diagnostics.push({
      severity: 'error',
      code: CODES.FILE_LIMIT,
      message: `workspace contains ${paths.length} configuration files; the limit is ${MAX_FILES}`,
    });
    return { files, diagnostics };
  }

  for (const path of paths) {
    const rel = relative(dir, path).split(sep).join('/');
    const info = await stat(path);
    if (info.size > MAX_FILE_BYTES) {
      diagnostics.push({
        severity: 'error',
        code: CODES.FILE_LIMIT,
        file: rel,
        message: `file is ${info.size} bytes; the limit is ${MAX_FILE_BYTES} bytes`,
      });
      continue;
    }
    files.push({ path: rel, content: await readFile(path, 'utf8') });
  }
  return { files, diagnostics };
}

/** integrations/<name>/integration.yaml and the package's Markdown documentation. */
async function listPackageFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        (e.name === 'integration.yaml' || /\.md$/i.test(e.name)) &&
        // Exactly one level deep: integrations/<name>/<file>.
        relative(dir, e.parentPath).split(sep).length === 1 &&
        relative(dir, e.parentPath) !== '',
    )
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

async function listYamlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name) && !e.name.startsWith('.'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/** Parses and schema-validates source files. Pure: no I/O. */
export function parseSources(files: readonly SourceFile[]): ParsedSources {
  const result: ParsedSources = { services: [], slos: [], diagnostics: [] };
  const diag = (d: Diagnostic) => result.diagnostics.push(d);

  for (const file of files) {
    // Integration packages are loaded separately (integration-packages.ts).
    if (isPackageFile(file.path)) continue;
    const lineCounter = new LineCounter();
    const docs = parseAllDocuments(file.content, {
      lineCounter,
      uniqueKeys: true,
      prettyErrors: false,
    });
    // An empty file yields an EmptyStream, which is an empty array.
    for (const doc of docs) {
      const docLine = lineCounter.linePos(doc.range[0]).line;
      if (doc.errors.length > 0) {
        for (const err of doc.errors) {
          const pos = lineCounter.linePos(err.pos[0]);
          diag({
            severity: 'error',
            code: CODES.YAML_SYNTAX,
            file: file.path,
            line: pos.line,
            column: pos.col,
            message: `YAML syntax error: ${err.message.split('\n')[0] ?? err.message}`,
          });
        }
        continue;
      }
      if (doc.contents === null) continue; // empty document, e.g. trailing "---"

      let value: unknown;
      try {
        value = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
      } catch (error) {
        diag({
          severity: 'error',
          code: CODES.YAML_SYNTAX,
          file: file.path,
          line: docLine,
          message: `YAML could not be read: ${(error as Error).message}`,
        });
        continue;
      }

      const locate = (path: (string | number)[]) => locatePath(doc, lineCounter, path);

      const header = documentHeader.safeParse(value);
      if (!header.success) {
        for (const issue of header.error.issues) {
          diag({
            severity: 'error',
            code: CODES.INVALID_HEADER,
            file: file.path,
            ...(locate(issue.path as (string | number)[]) ?? { line: docLine }),
            path: issue.path as (string | number)[],
            message: issue.message,
            hint: 'every document starts with "apiVersion: raion/v1alpha1" and a "kind" (Workspace, Service or SLO)',
          });
        }
        continue;
      }

      const kind = header.data.kind;
      const parsed = documentSchemas[kind].safeParse(value);
      if (!parsed.success) {
        pushSchemaIssues(parsed.error, file.path, docLine, locate, diag);
        continue;
      }

      switch (kind) {
        case 'Workspace':
          if (file.path !== WORKSPACE_FILE) {
            diag({
              severity: 'error',
              code: CODES.WORKSPACE_PLACEMENT,
              file: file.path,
              line: docLine,
              message: `a Workspace document must be in ${WORKSPACE_FILE}`,
            });
          } else if (result.workspace) {
            diag({
              severity: 'error',
              code: CODES.WORKSPACE_PLACEMENT,
              file: file.path,
              line: docLine,
              message: `${WORKSPACE_FILE} contains more than one Workspace document`,
            });
          } else {
            result.workspace = {
              value: parsed.data as WorkspaceDocument,
              file: file.path,
              line: docLine,
              locate,
            };
          }
          break;
        case 'Service':
          result.services.push({
            value: parsed.data as ServiceDocument,
            file: file.path,
            line: docLine,
            locate,
          });
          break;
        case 'SLO':
          result.slos.push({
            value: parsed.data as SloDocument,
            file: file.path,
            line: docLine,
            locate,
          });
          break;
      }
    }
  }

  if (!result.workspace && !result.diagnostics.some((d) => d.file === WORKSPACE_FILE)) {
    diag({
      severity: 'error',
      code: CODES.MISSING_WORKSPACE_FILE,
      file: WORKSPACE_FILE,
      message: `${WORKSPACE_FILE} must contain a document with "kind: Workspace"`,
    });
  }
  return result;
}

function pushSchemaIssues(
  error: ZodError,
  file: string,
  docLine: number,
  locate: (path: (string | number)[]) => { line: number; column: number } | undefined,
  diag: (d: Diagnostic) => void,
): void {
  for (const issue of error.issues) {
    const path = issue.path as (string | number)[];
    let message = issue.message;
    if (issue.code === 'unrecognized_keys') {
      message = `unknown field${issue.keys.length > 1 ? 's' : ''}: ${issue.keys.join(', ')}`;
    } else if (issue.code === 'invalid_type' && /received undefined$/.test(issue.message)) {
      // Zod does not report the input value, but its default message says what was received.
      message = 'this field is required';
    }
    const where = path.length > 0 ? `${formatPath(path)}: ` : '';
    diag({
      severity: 'error',
      code: CODES.SCHEMA,
      file,
      ...(locate(path) ?? { line: docLine }),
      path,
      message: `${where}${message}`,
    });
  }
}

export function formatPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part),
    '',
  );
}

/** Finds the closest existing YAML node for a path and returns its position. */
function locatePath(
  doc: Document,
  lineCounter: LineCounter,
  path: (string | number)[],
): { line: number; column: number } | undefined {
  for (let len = path.length; len >= 0; len--) {
    const node: unknown = len === 0 ? doc.contents : doc.getIn(path.slice(0, len), true);
    if (isNode(node) && (node as Node).range) {
      const pos = lineCounter.linePos((node as Node).range![0]);
      return { line: pos.line, column: pos.col };
    }
  }
  return undefined;
}
