import { defineConfig, configDefaults } from 'vitest/config';
import os from 'os';

const localMaxWorkers = Math.max(1, Math.floor(os.cpus().length / 2));
// Each integration-test file owns a browser/driver pair. Two pairs fit on a
// developer machine, but have intermittently starved each other on the shared
// CI runner (late browser effects, empty intercepted bodies, and setup phases
// crossing otherwise generous deadlines). Keep CI deterministic; local runs
// retain the faster parallel default.
const maxWorkers = process.env.CI
  ? 1
  : process.env.BROWSER_NAME === 'firefox'
    ? Math.min(2, localMaxWorkers)
    : localMaxWorkers;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds for browser tests
    // Browser setup has its own bounded phases: Firefox driver readiness can
    // take 15s, session creation 30s, and an initial navigation another 30s.
    // Keep the harness outside those deadlines so loaded CI runners surface
    // CraftDriver's specific error instead of a premature generic hook timeout.
    hookTimeout: 90000,
    teardownTimeout: 30000,
    pool: 'forks',
    maxWorkers: maxWorkers,
    // Recipe snippet tests run as a dedicated CI gate (`npm run test:recipes`)
    // so they are not double-run here, and Chrome-only recipes (mobile
    // emulation) don't fail under the Firefox suite. The Electron e2e suites have
    // their own config + global setup (`npm run test:electron`) that downloads the
    // app — never trigger that from a plain `npm test`.
    // The browser-driving agent-surface tests each launch a browser (and
    // cli-e2e spawns one per flow). Run in parallel with this suite those
    // launches starve each other past the driver's session-creation timeout,
    // failing whichever unrelated file happened to start alongside them. They
    // have their own single-worker gate, `npm run test:cli`; the browser-free
    // CLI tests stay here.
    exclude: [
      ...configDefaults.exclude,
      'tests/recipes/**',
      // Packs and installs the tarball before it asserts anything; run via
      // `npm run test:release`, not on every default run.
      'tests/release/**',
      'tests/electron/**',
      // Every browser-driving CLI test belongs to the single-worker
      // `npm run test:cli` gate. Adding one there without excluding it here
      // leaves it running in this suite's parallel workers too, where the
      // concurrent chromedriver starts exceed the driver's session-creation
      // timeout — and the failure lands on whichever unrelated file happened
      // to start alongside it, not on the test that caused it.
      // Keep this list in sync with `vitest.cli.config.ts`.
      'tests/cli-smoke.test.ts',
      'tests/mcp-smoke.test.ts',
      'tests/cli/cli-e2e.test.ts',
      'tests/cli/agent-actions.test.ts',
      'tests/cli/agent-pages.test.ts',
      'tests/cli/agent-logs.test.ts',
      'tests/cli/agent-mock.test.ts',
      'tests/cli/agent-trace.test.ts',
      'tests/cli/auth-state.test.ts',
      'tests/cli/journal-wait-race.test.ts',
      'tests/cli/named-sessions.test.ts',
      'tests/cli/stable-refs.test.ts',
      'tests/cli/skill-workflow.test.ts',
      'tests/cli/snapshot-baseline.test.ts',
    ],
  },
  esbuild: {
    target: 'node18',
  },
});
