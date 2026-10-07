import { isMap, isSeq, parseAllDocuments, type Document } from 'yaml';
import type { SourceFile } from '../loader.js';
import { unifiedDiff } from './diff.js';
import type { FileChange } from './types.js';

type Path = (string | number)[];

/** Where a part of a document lives in the workspace files. */
export interface YamlLocation {
  file: SourceFile;
  docIndex: number;
  /** Path of the node inside the document, e.g. ['spec'] or ['spec', 'services', 2]. */
  path: Path;
}

function documents(file: SourceFile): Document.Parsed[] {
  const docs = parseAllDocuments(file.content);
  return Array.isArray(docs) ? docs : [];
}

/** The spec of a service: a `kind: Service` document, or an entry of the Workspace's `services`. */
export function locateService(
  files: readonly SourceFile[],
  name: string,
): YamlLocation | undefined {
  for (const file of files) {
    for (const [docIndex, doc] of documents(file).entries()) {
      const kind = doc.get('kind');
      if (kind === 'Service' && doc.getIn(['metadata', 'name']) === name) {
        return { file, docIndex, path: ['spec'] };
      }
      if (kind === 'Workspace') {
        const services = doc.getIn(['spec', 'services']);
        if (isSeq(services)) {
          const index = services.items.findIndex(
            (item) => isMap(item) && item.get('name') === name,
          );
          if (index >= 0) return { file, docIndex, path: ['spec', 'services', index] };
        }
      }
    }
  }
  return undefined;
}

/** The Workspace document's spec. */
export function locateWorkspace(files: readonly SourceFile[]): YamlLocation | undefined {
  for (const file of files) {
    for (const [docIndex, doc] of documents(file).entries()) {
      if (doc.get('kind') === 'Workspace') return { file, docIndex, path: ['spec'] };
    }
  }
  return undefined;
}

/**
 * Edits one document of a file in place. Comments, key order and the formatting of
 * everything else are kept, so the change reads like a hand edit in review.
 */
export function editYaml(
  location: YamlLocation,
  edit: (doc: Document.Parsed, base: Path) => void,
): FileChange {
  const docs = documents(location.file);
  const doc = docs[location.docIndex];
  if (!doc) throw new Error(`${location.file.path}: document ${location.docIndex} not found`);
  edit(doc, location.path);
  const after = docs.map((d) => d.toString({ lineWidth: 0 })).join('');
  return change(location.file.path, location.file.content, after);
}

/** Sets a value, creating intermediate maps as needed. */
export function setIn(doc: Document.Parsed, path: Path, value: unknown): void {
  doc.setIn(path, doc.createNode(value));
}

/** Appends to a list, creating the list when it does not exist. */
export function appendIn(doc: Document.Parsed, path: Path, value: unknown): void {
  const list = doc.getIn(path);
  if (isSeq(list)) list.add(doc.createNode(value));
  else doc.setIn(path, doc.createNode([value]));
}

/** A file change. Keeps Windows line endings when the original file uses them. */
export function change(path: string, before: string | null, after: string): FileChange {
  const lf = (text: string) => text.replaceAll('\r\n', '\n');
  const crlf = before?.includes('\r\n') ?? false;
  return {
    path,
    before,
    after: crlf ? lf(after).replaceAll('\n', '\r\n') : after,
    diff: unifiedDiff(path, before === null ? null : lf(before), lf(after)),
  };
}

/** The workspace files with the changes applied, for validating a fix before offering it. */
export function withChanges(
  files: readonly SourceFile[],
  changes: readonly FileChange[],
): SourceFile[] {
  const result = new Map(files.map((f) => [f.path, f.content]));
  for (const c of changes) result.set(c.path, c.after);
  return [...result].map(([path, content]) => ({ path, content }));
}
