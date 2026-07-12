import { defineConfig, configDefaults } from 'vitest/config';
import os from 'os';

const maxWorkers = Math.max(1, Math.floor(os.cpus().length / 2));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for browser tests
    hookTimeout: 30000,
    teardownTimeout: 30000,
    pool: 'forks',
    maxWorkers: maxWorkers,
    // Recipe snippet tests run as a dedicated CI gate (`npm run test:recipes`)
    // so they are not double-run here, and Chrome-only recipes (mobile
    // emulation) don't fail under the Firefox suite. The Electron e2e suites have
    // their own config + global setup (`npm run test:electron`) that downloads the
    // app — never trigger that from a plain `npm test`.
    exclude: [...configDefaults.exclude, 'tests/recipes/**', 'tests/electron/**'],
  },
  esbuild: {
    target: 'node18',
  },
});
