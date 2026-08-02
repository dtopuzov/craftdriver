import { defineConfig } from 'vitest/config';

// Separate, sequential config for credentialed BrowserStack sessions.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/recipes/browserstack-remote.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    pool: 'forks',
    // One session at a time: BrowserStack plans meter concurrent sessions.
    maxWorkers: 1,
    fileParallelism: false,
    // No retries: a retried remote session can orphan a second, paid session
    // (and the repo flake policy is zero automatic retries regardless).
    retry: 0,
  },
  esbuild: {
    target: 'node22',
  },
});
