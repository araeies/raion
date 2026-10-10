/**
 * Changes to workspace files, shared by the web UI and the CLI. An edit is computed in memory,
 * checked by validating the whole workspace with it, shown as a diff, and only then written,
 * refusing if a file changed in the meantime. Edits keep comments and formatting, so they read
 * like hand edits in review and in Git.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isMap, isSeq, parseAllDocuments, type Document } from 'yaml';
import { unifiedDiff } from './advisor/diff.js';
import type { Diagnostic } from './diagnostics.js';
import type { SourceFile } from './loader.js';
import { toYaml } from './runtime/yaml.js';
import { renderSloDocument, type NewSlo } from './slo-authoring.js';
import { validateSources } from './workspace.js';

type Path = (string | number)[];

/** A change to one workspace file. `after: null` deletes the file. */
export interface EditChange {
  path: string;
  before: string | null;
  after: string | null;
  diff: string;
}

/** A computed, validated edit, ready to review and write. */
export interface WorkspaceEdit {
  summary: string;
  changes: EditChange[];
  /** Warnings the workspace will have after the edit (errors make the edit impossible). */
  warnings: Diagnostic[];
}

export class WorkspaceEditError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'exists' | 'invalid' | 'conflict' | 'unsupported',
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
  }
}

/** A new application, as the web UI's form and "raion services add" describe it. */
export interface NewService {
  name: string;
  type: string;
  language?: string;
  description?: string;
  team?: string;
  owner?: string;
  tier?: 'critical' | 'standard' | 'best-effort';
  runtime?: { type: 'compose'; composeService?: string } | { type: 'host' } | { type: 'remote' };
  /** Outside checks of its address; required for a remote application. */
  checks?: { url: string; expectStatus?: number[]; interval?: string; timeout?: string }[];
  containerLogs?: boolean;
  signals?: { metrics?: boolean; logs?: boolean; traces?: boolean };
  integrations?: unknown[];
  dependencies?: unknown[];
  slos?: unknown[];
}

/** Fields of a service the UI and CLI may change. A value of null removes the field. */
export const SERVICE_FIELDS = [
  'type',
  'language',
  'description',
  'team',
  'owner',
  'tier',
  'repository',
  'runtime',
  'containerLogs',
  'checks',
  'level',
  'features',
  'integrations',
  'signals',
  'dependencies',
  'runbooks',
  'alerts',
] as const;

/** Workspace settings the UI and CLI may change (dotted paths under spec). */
export const WORKSPACE_FIELDS = [
  'level',
  'environment',
  'retention.metrics',
  'retention.logs',
  'retention.traces',
  'infrastructure.host',
  'infrastructure.containers',
  'server.publicUrl',
  'notifications.defaultReceiver',
  'features',
] as const;

export type EditAction =
  | { kind: 'service.add'; service: NewService }
  | { kind: 'service.update'; name: string; set: Record<string, unknown> }
  | { kind: 'service.remove'; name: string }
  | { kind: 'slo.add'; slo: NewSlo }
  | {
      kind: 'slo.update';
      service: string;
      name: string;
      set: Partial<Record<'target' | 'window' | 'description' | 'policy' | 'sli', unknown>>;
    }
  | { kind: 'slo.remove'; service: string; name: string }
  | { kind: 'workspace.update'; set: Record<string, unknown> }
  | { kind: 'receiver.add'; receiver: Record<string, unknown> }
  | { kind: 'receiver.update'; name: string; receiver: Record<string, unknown> }
  | { kind: 'receiver.remove'; name: string }
  | { kind: 'team.add'; team: { name: string; route?: string; contacts?: string[] } }
  | {
      kind: 'team.update';
      name: string;
      set: { route?: string | null; contacts?: string[] | null };
    }
  | { kind: 'team.remove'; name: string };

// ----- locating things in the files ------------------------------------------------------------

interface Location {
  file: SourceFile;
  docIndex: number;
  path: Path;
}

function documents(file: SourceFile): Document.Parsed[] {
  const docs = parseAllDocuments(file.content);
  return Array.isArray(docs) ? docs : [];
}

function findDocument(
  files: readonly SourceFile[],
  match: (doc: Document.Parsed) => Path | undefined,
): Location | undefined {
  for (const file of files) {
    for (const [docIndex, doc] of documents(file).entries()) {
      const path = match(doc);
      if (path) return { file, docIndex, path };
    }
  }
  return undefined;
}

function workspaceLocation(files: readonly SourceFile[]): Location {
  const loc = findDocument(files, (doc) =>
    doc.get('kind') === 'Workspace' ? ['spec'] : undefined,
  );
  if (!loc)
    throw new WorkspaceEditError('the workspace has no raion.yaml Workspace document', 'invalid');
  return loc;
}

function indexIn(doc: Document.Parsed, path: Path, key: string, value: string): number {
  const list = doc.getIn(path);
  if (!isSeq(list)) return -1;
  return list.items.findIndex((item) => isMap(item) && item.get(key) === value);
}

function serviceLocation(files: readonly SourceFile[], name: string): Location | undefined {
  return findDocument(files, (doc) => {
    if (doc.get('kind') === 'Service' && doc.getIn(['metadata', 'name']) === name) return ['spec'];
    if (doc.get('kind') === 'Workspace') {
      const i = indexIn(doc, ['spec', 'services'], 'name', name);
      if (i >= 0) return ['spec', 'services', i];
    }
    return undefined;
  });
}

function sloLocation(
  files: readonly SourceFile[],
  service: string,
  name: string,
): (Location & { standalone: boolean }) | undefined {
  const standalone = findDocument(files, (doc) =>
    doc.get('kind') === 'SLO' &&
    doc.getIn(['metadata', 'name']) === name &&
    doc.getIn(['spec', 'service']) === service
      ? ['spec']
      : undefined,
  );
  if (standalone) return { ...standalone, standalone: true };
  const svc = serviceLocation(files, service);
  if (!svc) return undefined;
  const doc = documents(svc.file)[svc.docIndex]!;
  const i = indexIn(doc, [...svc.path, 'slos'], 'name', name);
  return i >= 0 ? { ...svc, path: [...svc.path, 'slos', i], standalone: false } : undefined;
}

// ----- building changes ------------------------------------------------------------------------

function change(path: string, before: string | null, after: string | null): EditChange {
  const lf = (text: string) => text.replaceAll('\r\n', '\n');
  const crlf = before?.includes('\r\n') ?? false;
  const out = after === null ? null : crlf ? lf(after).replaceAll('\n', '\r\n') : after;
  return {
    path,
    before,
    after: out,
    diff: unifiedDiff(path, before === null ? null : lf(before), after === null ? '' : lf(after)),
  };
}

function editDocument(loc: Location, edit: (doc: Document.Parsed, base: Path) => void): EditChange {
  const docs = documents(loc.file);
  edit(docs[loc.docIndex]!, loc.path);
  return change(
    loc.file.path,
    loc.file.content,
    docs.map((d) => d.toString({ lineWidth: 0 })).join(''),
  );
}

/** Sets `key` (a dotted path) under `base`; null removes it. */
function apply(doc: Document.Parsed, base: Path, key: string, value: unknown): void {
  const path = [...base, ...key.split('.')];
  if (value === null || value === undefined) doc.deleteIn(path);
  else doc.setIn(path, doc.createNode(value));
}

function checkFields(set: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(set)) {
    if (!allowed.some((a) => key === a || key.startsWith(`${a}.`))) {
      throw new WorkspaceEditError(`"${key}" cannot be changed on a ${what}`, 'unsupported');
    }
  }
}

function serviceFile(service: NewService): SourceFile {
  const { name, ...spec } = service;
  return {
    path: `services/${name}.yaml`,
    content: toYaml(
      {
        apiVersion: 'raion/v1alpha1',
        kind: 'Service',
        metadata: { name },
        spec: { tier: 'standard', ...spec },
      },
      `An application Raion monitors. Created with Raion; edit here or in the Raion web UI.`,
    ),
  };
}

const describe: Record<EditAction['kind'], (a: never) => string> = {
  'service.add': (a: { service: NewService }) => `Add the application ${a.service.name}`,
  'service.update': (a: { name: string }) => `Change the settings of ${a.name}`,
  'service.remove': (a: { name: string }) => `Stop monitoring ${a.name}`,
  'slo.add': (a: { slo: NewSlo }) => `Add the reliability goal "${a.slo.name}" to ${a.slo.service}`,
  'slo.update': (a: { service: string; name: string }) =>
    `Change the reliability goal "${a.name}" of ${a.service}`,
  'slo.remove': (a: { service: string; name: string }) =>
    `Remove the reliability goal "${a.name}" of ${a.service}`,
  'workspace.update': () => 'Change the workspace settings',
  'receiver.add': (a: { receiver: { name?: unknown } }) =>
    `Add the notification channel ${String(a.receiver.name)}`,
  'receiver.update': (a: { name: string }) => `Change the notification channel ${a.name}`,
  'receiver.remove': (a: { name: string }) => `Remove the notification channel ${a.name}`,
  'team.add': (a: { team: { name: string } }) => `Add the team ${a.team.name}`,
  'team.update': (a: { name: string }) => `Change the team ${a.name}`,
  'team.remove': (a: { name: string }) => `Remove the team ${a.name}`,
};

function changesFor(files: readonly SourceFile[], action: EditAction): EditChange[] {
  switch (action.kind) {
    case 'service.add': {
      if (serviceLocation(files, action.service.name))
        throw new WorkspaceEditError(
          `an application named "${action.service.name}" already exists`,
          'exists',
        );
      const file = serviceFile(action.service);
      if (files.some((f) => f.path === file.path))
        throw new WorkspaceEditError(`${file.path} already exists`, 'exists');
      return [change(file.path, null, file.content)];
    }
    case 'service.update': {
      checkFields(action.set, SERVICE_FIELDS, 'service');
      const loc = serviceLocation(files, action.name);
      if (!loc)
        throw new WorkspaceEditError(`there is no application named "${action.name}"`, 'not_found');
      return [
        editDocument(loc, (doc, base) => {
          for (const [k, v] of Object.entries(action.set)) apply(doc, base, k, v);
        }),
      ];
    }
    case 'service.remove': {
      const loc = serviceLocation(files, action.name);
      if (!loc)
        throw new WorkspaceEditError(`there is no application named "${action.name}"`, 'not_found');
      const changes: EditChange[] = [];
      const docs = documents(loc.file);
      if (loc.path.length === 1 && docs.length === 1) {
        changes.push(change(loc.file.path, loc.file.content, null));
      } else if (loc.path.length === 1) {
        docs.splice(loc.docIndex, 1);
        changes.push(
          change(
            loc.file.path,
            loc.file.content,
            docs.map((d) => d.toString({ lineWidth: 0 })).join(''),
          ),
        );
      } else {
        changes.push(editDocument(loc, (doc, base) => doc.deleteIn(base)));
      }
      // Its standalone SLO files go with it.
      for (const file of files) {
        const ds = documents(file);
        if (
          ds.length === 1 &&
          ds[0]!.get('kind') === 'SLO' &&
          ds[0]!.getIn(['spec', 'service']) === action.name
        ) {
          changes.push(change(file.path, file.content, null));
        }
      }
      return changes;
    }
    case 'slo.add': {
      const file = renderSloDocument(action.slo);
      if (sloLocation(files, action.slo.service, action.slo.name))
        throw new WorkspaceEditError(
          `${action.slo.service} already has a reliability goal named "${action.slo.name}"`,
          'exists',
        );
      if (files.some((f) => f.path === file.path))
        throw new WorkspaceEditError(`${file.path} already exists`, 'exists');
      return [change(file.path, null, file.content)];
    }
    case 'slo.update': {
      checkFields(
        action.set,
        ['target', 'window', 'description', 'policy', 'sli'],
        'reliability goal',
      );
      const loc = sloLocation(files, action.service, action.name);
      if (!loc)
        throw new WorkspaceEditError(
          `${action.service} has no reliability goal named "${action.name}"`,
          'not_found',
        );
      return [
        editDocument(loc, (doc, base) => {
          for (const [k, v] of Object.entries(action.set)) apply(doc, base, k, v);
        }),
      ];
    }
    case 'slo.remove': {
      const loc = sloLocation(files, action.service, action.name);
      if (!loc)
        throw new WorkspaceEditError(
          `${action.service} has no reliability goal named "${action.name}"`,
          'not_found',
        );
      if (loc.standalone && documents(loc.file).length === 1)
        return [change(loc.file.path, loc.file.content, null)];
      return [
        editDocument(loc, (doc, base) => doc.deleteIn(loc.standalone ? base.slice(0, -1) : base)),
      ];
    }
    case 'workspace.update': {
      checkFields(action.set, WORKSPACE_FIELDS, 'workspace');
      return [
        editDocument(workspaceLocation(files), (doc, base) => {
          for (const [k, v] of Object.entries(action.set)) apply(doc, base, k, v);
        }),
      ];
    }
    case 'receiver.add':
    case 'receiver.update':
    case 'receiver.remove':
      return [
        editDocument(workspaceLocation(files), (doc, base) => {
          const path = [...base, 'notifications', 'receivers'];
          const name = action.kind === 'receiver.add' ? String(action.receiver.name) : action.name;
          const i = indexIn(doc, path, 'name', name);
          if (action.kind === 'receiver.add') {
            if (i >= 0)
              throw new WorkspaceEditError(
                `a notification channel named "${name}" already exists`,
                'exists',
              );
            const list = doc.getIn(path);
            if (isSeq(list)) list.add(doc.createNode(action.receiver));
            else doc.setIn(path, doc.createNode([action.receiver]));
            return;
          }
          if (i < 0)
            throw new WorkspaceEditError(
              `there is no notification channel named "${name}"`,
              'not_found',
            );
          if (action.kind === 'receiver.remove') doc.deleteIn([...path, i]);
          else doc.setIn([...path, i], doc.createNode({ ...action.receiver, name }));
        }),
      ];
    case 'team.add':
    case 'team.update':
    case 'team.remove':
      return [
        editDocument(workspaceLocation(files), (doc, base) => {
          const path = [...base, 'teams'];
          const name = action.kind === 'team.add' ? action.team.name : action.name;
          const i = indexIn(doc, path, 'name', name);
          if (action.kind === 'team.add') {
            if (i >= 0)
              throw new WorkspaceEditError(`a team named "${name}" already exists`, 'exists');
            const list = doc.getIn(path);
            if (isSeq(list)) list.add(doc.createNode(action.team));
            else doc.setIn(path, doc.createNode([action.team]));
            return;
          }
          if (i < 0) throw new WorkspaceEditError(`there is no team named "${name}"`, 'not_found');
          if (action.kind === 'team.remove') doc.deleteIn([...path, i]);
          else for (const [k, v] of Object.entries(action.set)) apply(doc, [...path, i], k, v);
        }),
      ];
  }
}

/** The workspace files with the changes applied. */
export function withEdit(
  files: readonly SourceFile[],
  changes: readonly EditChange[],
): SourceFile[] {
  const result = new Map(files.map((f) => [f.path, f.content]));
  for (const c of changes) {
    if (c.after === null) result.delete(c.path);
    else result.set(c.path, c.after);
  }
  return [...result].map(([path, content]) => ({ path, content }));
}

/**
 * Computes an edit and checks the whole workspace with it. Throws with the validation errors
 * when the result would be invalid, so an edit is only ever offered when it can be deployed.
 */
export function planEdit(files: readonly SourceFile[], action: EditAction): WorkspaceEdit {
  const changes = changesFor(files, action);
  const result = validateSources(withEdit(files, changes));
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    throw new WorkspaceEditError(errors.map((d) => d.message).join('; '), 'invalid', errors);
  }
  const touched = new Set(changes.map((c) => c.path));
  return {
    summary: (describe[action.kind] as (a: EditAction) => string)(action),
    changes,
    warnings: result.diagnostics.filter((d) => d.file !== undefined && touched.has(d.file)),
  };
}

/**
 * Writes an edit. Refuses when any file changed since the edit was computed (someone else, an
 * editor, a git pull), so nobody's change is overwritten; nothing is written in that case.
 */
export async function writeEdit(workspaceDir: string, edit: WorkspaceEdit): Promise<string[]> {
  const root = resolve(workspaceDir);
  const targets = edit.changes.map((c) => {
    const target = resolve(root, c.path);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new WorkspaceEditError(`refusing to write outside the workspace: ${c.path}`, 'invalid');
    return { change: c, target };
  });
  for (const { change: c, target } of targets) {
    const current = existsSync(target) ? await readFile(target, 'utf8') : null;
    if (current !== c.before) {
      throw new WorkspaceEditError(
        `${c.path} was changed by someone else in the meantime; reload and try again`,
        'conflict',
      );
    }
  }
  for (const { change: c, target } of targets) {
    if (c.after === null) await rm(target, { force: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, c.after, c.before === null ? { flag: 'wx' } : {});
    }
  }
  return targets.map((t) => t.change.path);
}
