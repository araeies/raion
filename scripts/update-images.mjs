// Re-resolves the digest of every runtime image in packages/core/src/runtime/images.ts.
//
// To upgrade a component: change its `tag` in images.ts, run this script, review the
// upstream release notes, then run `pnpm run check` and `pnpm run test:e2e`.
//
//   node scripts/update-images.mjs          # update digests in place
//   node scripts/update-images.mjs --check  # exit 1 if any pinned digest differs from the registry
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = join(import.meta.dirname, '..', 'packages', 'core', 'src', 'runtime', 'images.ts');
const check = process.argv.includes('--check');
let source = readFileSync(file, 'utf8');

const entry = /image: '([^']+)',\s*tag: '([^']+)',\s*digest: '(sha256:[0-9a-f]{64})'/g;
let changed = 0;
for (const [, image, tag, digest] of [...source.matchAll(entry)]) {
  const out = execFileSync(
    'docker',
    ['buildx', 'imagetools', 'inspect', `${image}:${tag}`, '--format', '{{json .Manifest}}'],
    {
      encoding: 'utf8',
    },
  );
  const latest = JSON.parse(out).digest;
  if (latest === digest) {
    console.log(`  = ${image}:${tag}`);
    continue;
  }
  changed++;
  console.log(`  ~ ${image}:${tag}\n      ${digest}\n   -> ${latest}`);
  source = source.replace(digest, latest);
}

if (check) {
  process.exit(changed > 0 ? 1 : 0);
}
if (changed > 0) writeFileSync(file, source);
console.log(changed > 0 ? `Updated ${changed} digest(s).` : 'All digests are current.');
