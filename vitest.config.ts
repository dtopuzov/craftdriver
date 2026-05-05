import { defineConfig } from 'vitest/config';
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
  },
  esbuild: {
    target: 'node18',
  },
});
