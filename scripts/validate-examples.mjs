// Validates every example workspace with the built CLI, exactly as a user or CI job would:
// examples/workspaces/* plus the observability/ workspace of every example application.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'apps', 'cli', 'dist', 'index.js');
const examples = join(root, 'examples');

const dirs = (path) =>
  readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(path, e.name));

const workspaces = [
  ...dirs(join(examples, 'workspaces')),
  ...dirs(examples)
    .map((app) => join(app, 'observability'))
    .filter((ws) => existsSync(join(ws, 'raion.yaml'))),
];

let failed = 0;
for (const workspace of workspaces) {
  try {
    execFileSync(process.execPath, [cli, 'validate', workspace], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}
if (failed > 0) {
  console.error(`${failed} example workspace(s) failed validation`);
  process.exit(1);
}
