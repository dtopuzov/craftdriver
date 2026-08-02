import { defineConfig } from 'vitest/config';

// Separate, sequential config for tests that require SELENIUM_GRID_URL.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/recipes/selenium-grid-remote.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    teardownTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
  },
  esbuild: {
    target: 'node22',
  },
});
