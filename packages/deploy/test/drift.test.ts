import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareRuntime, stateRoot } from '../src/index.js';

const COMPOSE =
  'services:\n  prometheus:\n    image: prom/prometheus:v3@sha256:aaa\n  loki:\n    image: grafana/loki:3@sha256:bbb\n';

const expected = [
  { path: 'compose.yaml', content: COMPOSE },
  { path: 'prometheus/prometheus.yml', content: 'global: {}\n' },
];

const running = [
  { service: 'prometheus', state: 'running', image: 'prom/prometheus:v3@sha256:aaa' },
  { service: 'loki', state: 'running', image: 'grafana/loki:3@sha256:bbb' },
];

function compare(
  actual: Record<string, string>,
  containers = running,
  components = ['prometheus', 'loki'],
) {
  return compareRuntime({
    release: '0003-abc',
    expected,
    actual: new Map(Object.entries(actual)),
    components,
    containers,
  });
}

const files = { 'compose.yaml': COMPOSE, 'prometheus/prometheus.yml': 'global: {}\n' };

describe('drift', () => {
  it('finds nothing when the stack matches the release', () => {
    expect(compare(files)).toEqual({ release: '0003-abc', items: [] });
  });

  it('finds edited, deleted and added files', () => {
    const report = compare({
      'compose.yaml': COMPOSE,
      'prometheus/prometheus.yml': 'global: { scrape_interval: 1s }\n',
      'prometheus/rules/mine.yml': 'groups: []\n',
    });
    expect(report.items.map((i) => [i.kind, i.subject])).toEqual([
      ['file-modified', 'prometheus/prometheus.yml'],
      ['file-extra', 'prometheus/rules/mine.yml'],
    ]);
    expect(compare({ 'compose.yaml': COMPOSE }).items[0]).toMatchObject({
      kind: 'file-missing',
      subject: 'prometheus/prometheus.yml',
    });
  });

  it('finds stopped, missing, added and replaced containers', () => {
    const report = compare(files, [
      { service: 'prometheus', state: 'exited', image: 'prom/prometheus:latest' },
      { service: 'debug-shell', state: 'running', image: 'alpine' },
    ]);
    expect(report.items.map((i) => [i.kind, i.subject])).toEqual([
      ['component-stopped', 'prometheus'],
      ['image-changed', 'prometheus'],
      ['component-missing', 'loki'],
      ['component-extra', 'debug-shell'],
    ]);
    expect(report.items[1]!.detail).toBe(
      'runs prom/prometheus:latest, the release specifies prom/prometheus:v3@sha256:aaa',
    );
  });
});

describe('state directory', () => {
  it('is .raion in the workspace, or RAION_STATE_DIR outside a CI checkout', () => {
    expect(stateRoot('/ws', {})).toBe(join('/ws', '.raion'));
    expect(stateRoot('/ws', { RAION_STATE_DIR: '/srv/raion/shop' })).toBe(
      resolve('/srv/raion/shop'),
    );
    expect(() => stateRoot('/ws', { RAION_STATE_DIR: 'relative/dir' })).toThrow('absolute');
  });
});
