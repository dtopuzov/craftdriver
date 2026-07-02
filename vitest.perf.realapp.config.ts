import { defineConfig } from 'vitest/config';

// Config for tests/perf/realapp/*.perf.ts — benchmarks against a real running
// app (craftdriver-demos' EasyMath, a real Postgres-backed React app) instead
// of the static example pages tests/perf/*.perf.ts uses. Requires a sibling
// craftdriver-demos checkout, Docker running, and `pnpm dev` already serving
// the app (default http://127.0.0.1:5173, override with E2E_BASE_URL). Run
// with `npm run bench:realapp`, never as part of plain `npm run bench`.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/perf/realapp/**/*.perf.ts'],
    testTimeout: 180000,
    hookTimeout: 180000, // db:reset shells out to `docker compose down/up` + migrate + seed
    teardownTimeout: 30000,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
  },
  esbuild: {
    target: 'node18',
  },
});
