// Removes build output across the monorepo (cross-platform; no shell globbing).
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
for (const dir of [
  'packages/schema',
  'packages/integrations',
  'packages/core',
  'packages/deploy',
  'apps/server',
  'apps/cli',
  'apps/web',
]) {
  rmSync(join(root, dir, 'dist'), { recursive: true, force: true });
  rmSync(join(root, dir, 'tsconfig.tsbuildinfo'), { force: true });
}
rmSync(join(root, 'packages/schema/json'), { recursive: true, force: true });
