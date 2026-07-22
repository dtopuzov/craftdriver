// Dedicated config for the recipe snippet tests in tests/recipes/.
// These are excluded from the default vitest run (see vitest.config.ts) and run
// as their own CI gate via `npm run test:recipes`. Keeping a separate config —
// like vitest.perf.config.ts — is what lets `include` target tests/recipes/
// without the default run's exclude hiding them.
import { defineConfig, configDefaults } from 'vitest/config';
import os from 'os';

// Recipe files also launch independent browsers. Avoid competing browser and
// driver processes on the shared CI runner; preserve local parallelism.
const maxWorkers = process.env.CI ? 1 : Math.max(1, Math.floor(os.cpus().length / 2));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    pool: 'forks',
    maxWorkers: maxWorkers,
    include: ['tests/recipes/**/*.test.ts'],
    // browserstack-remote.test.ts and selenium-grid-remote.test.ts each need a
    // live remote endpoint (a metered cloud account / a running Selenium Grid)
    // and have their own dedicated commands + configs
    // (`npm run test:browserstack`, `npm run test:grid`) — neither may run as
    // part of this default recipes gate.
    exclude: [
      ...configDefaults.exclude,
      'tests/recipes/browserstack-remote.test.ts',
      'tests/recipes/selenium-grid-remote.test.ts',
    ],
  },
  esbuild: {
    target: 'node18',
  },
});
