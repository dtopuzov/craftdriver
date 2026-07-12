import { defineConfig } from 'vitest/config';

// Dedicated config for the Electron e2e suites (`npm run test:electron`). A global
// setup downloads the packaged example app once before the suites run (see
// tests/electron/global-setup.ts); the main `npm test` config excludes tests/electron
// so it never triggers that download.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/electron/**/*.test.ts'],
    globalSetup: ['tests/electron/global-setup.ts'],
    testTimeout: 60_000, // launching + driving a real GUI app
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    pool: 'forks',
    // One app at a time: these drive a real windowed app and share the fixture.
    maxWorkers: 1,
    fileParallelism: false,
  },
  esbuild: { target: 'node18' },
});
