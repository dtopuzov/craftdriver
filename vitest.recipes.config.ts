// Dedicated config for the recipe snippet tests in tests/recipes/.
// These are excluded from the default vitest run (see vitest.config.ts) and run
// as their own CI gate via `npm run test:recipes`. Keeping a separate config —
// like vitest.perf.config.ts — is what lets `include` target tests/recipes/
// without the default run's exclude hiding them.
import { defineConfig, configDefaults } from 'vitest/config';
import os from 'os';

const maxWorkers = Math.max(1, Math.floor(os.cpus().length / 2));

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
    exclude: [...configDefaults.exclude],
  },
  esbuild: {
    target: 'node18',
  },
});
