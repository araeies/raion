import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against sources, so `pnpm test` does not depend on a prior build.
    alias: {
      '@raion/schema': src('packages/schema'),
      '@raion/core': src('packages/core'),
      '@raion/deploy': src('packages/deploy'),
      '@raion/server': src('apps/server'),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'apps/web/src/**/*.test.tsx',
    ],
    testTimeout: 20_000,
    // The first server build in a file loads the whole app; under full parallel load (and on
    // slower CI runners) that cold start can exceed the 10 s default for hooks.
    hookTimeout: 30_000,
  },
});
