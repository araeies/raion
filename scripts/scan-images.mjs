// Scans every pinned runtime image (packages/core/src/runtime/images.ts) for known
// vulnerabilities with Trivy, itself run from a pinned image. Report-only by default,
// because fixes for upstream images come from upstream; use the report to decide on upgrades.
//
//   node scripts/scan-images.mjs                 # report HIGH and CRITICAL findings
//   node scripts/scan-images.mjs --fail-critical # exit 1 if any fixable CRITICAL finding exists
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TRIVY =
  'aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa';
const source = readFileSync(
  join(import.meta.dirname, '..', 'packages', 'core', 'src', 'runtime', 'images.ts'),
  'utf8',
);
const images = [
  ...source.matchAll(/image: '([^']+)',\s*tag: '([^']+)',\s*digest: '(sha256:[0-9a-f]{64})'/g),
].map(([, image, tag, digest]) => `${image}:${tag}@${digest}`);

let critical = 0;
const rows = [];
for (const image of images) {
  const result = spawnSync(
    'docker',
    // A named volume caches Trivy's vulnerability database between images and runs.
    [
      'run',
      '--rm',
      '-v',
      'raion-trivy-cache:/root/.cache/trivy',
      TRIVY,
      'image',
      '--quiet',
      '--format',
      'json',
      '--severity',
      'HIGH,CRITICAL',
      '--ignore-unfixed',
      image,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 900_000 },
  );
  if (result.status !== 0) {
    rows.push(
      `| ${image.split('@')[0]} | scan failed | ${(result.stderr || '').trim().split('\n').pop()} |`,
    );
    continue;
  }
  const report = JSON.parse(result.stdout);
  const vulns = (report.Results ?? []).flatMap((r) => r.Vulnerabilities ?? []);
  const counts = { CRITICAL: 0, HIGH: 0 };
  for (const v of vulns) counts[v.Severity] = (counts[v.Severity] ?? 0) + 1;
  critical += counts.CRITICAL;
  rows.push(`| ${image.split('@')[0]} | ${counts.CRITICAL} | ${counts.HIGH} |`);
}

const summary = [
  '## Runtime image vulnerabilities (fixable HIGH and CRITICAL)',
  '',
  '| Image | Critical | High |',
  '|---|---|---|',
  ...rows,
  '',
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (process.argv.includes('--fail-critical') && critical > 0) process.exit(1);
