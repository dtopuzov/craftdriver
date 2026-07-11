import { defineConfig } from 'vitest/config';

// Dedicated config for tests/perf/*.perf.ts — kept separate from vitest.config.ts
// so `npm test` (which uses the default include glob `**/*.{test,spec}.ts` and
// therefore never matches `*.perf.ts`) never picks these up. Perf runs need a
// single worker/fork so CPU contention from parallel test workers doesn't skew
// wall-clock measurements.
//
// Only matches the top-level tests/perf/*.perf.ts files. Keep perf harnesses
// self-contained so `npm run bench` is reproducible from this repo alone.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/perf/*.perf.ts'],
    testTimeout: 120000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
  },
  esbuild: {
    target: 'node18',
  },
});
