// Release gate: packs the tarball, installs it into a throwaway consumer
// project, and drives the documented workflow end to end.
//
// Its own config because it is slow and heavy in a different way from the
// other gates: `npm pack` plus `npm install` before a single assertion runs,
// then real browser launches on top. Single-worker for the same reason
// `vitest.cli.config.ts` is — concurrent chromedriver starts exceed the
// driver's session-creation timeout and the failure lands on an unrelated file.
//
// Not part of `npm test`. Run before a release, or when changing packaging,
// the installer, or the shipped skill.
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // npm install of the packed tarball dominates the first hook.
    testTimeout: 600_000,
    hookTimeout: 900_000,
    teardownTimeout: 60_000,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    include: ['tests/release/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
  },
  esbuild: {
    target: 'node18',
  },
});
