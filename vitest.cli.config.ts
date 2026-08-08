// Dedicated config for the browser-driving agent-surface tests in tests/cli/.
//
// Every file here launches at least one browser, and cli-e2e.test.ts spawns
// the real binary — and therefore a fresh chromedriver — once per flow. Run
// alongside the default suite's parallel workers, those launches contend for
// the machine and exceed the driver's 30s session-creation timeout, which
// surfaces as `POST /session timed out` or a `beforeAll` hook timeout on some
// unrelated file that merely happened to start at the same moment.
//
// So they get their own single-worker gate (`npm run test:cli`, mirroring
// vitest.recipes.config.ts). The CLI tests that need no browser — argument
// parsing, delta rendering, the skill installer, session/protocol fakes —
// stay in the default run, where they cost milliseconds.
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // A spawn, a browser launch and a full flow per test.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    teardownTimeout: 30_000,
    pool: 'forks',
    // The whole point: no competing browser launches.
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'tests/cli-smoke.test.ts',
      'tests/mcp-smoke.test.ts',
      'tests/cli/cli-e2e.test.ts',
      'tests/cli/agent-a11y.test.ts',
      'tests/cli/agent-batch.test.ts',
      'tests/cli/agent-actions.test.ts',
      'tests/cli/agent-expect.test.ts',
      'tests/cli/agent-pages.test.ts',
      'tests/cli/agent-logs.test.ts',
      'tests/cli/agent-mock.test.ts',
      'tests/cli/agent-trace.test.ts',
      'tests/cli/auth-state.test.ts',
      'tests/cli/journal-wait-race.test.ts',
      'tests/cli/named-sessions.test.ts',
      'tests/cli/navigation-submit.test.ts',
      'tests/cli/navigation-submit-classic.test.ts',
      'tests/cli/stable-refs.test.ts',
      'tests/cli/skill-workflow.test.ts',
      'tests/cli/snapshot-baseline.test.ts',
      'tests/cli/snapshot-content.test.ts',
    ],
    exclude: [...configDefaults.exclude],
  },
  esbuild: {
    target: 'node22',
  },
});
