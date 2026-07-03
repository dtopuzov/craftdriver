/**
 * Launch critical-path benchmark.
 *
 * The existing `bidi-vs-classic.perf.ts` E2E benchmark launches the browser
 * ONCE and then times a reused-browser flow, so it amortizes launch cost out
 * and cannot show a launch-time change. This benchmark does the opposite: it
 * includes `Browser.launch()` in the timed window and uses a FRESH browser
 * every iteration.
 *
 * It was written to evaluate PERF-05 (background BiDi connect) and instead
 * showed that the BiDi handshake is ~35ms — not the launch bottleneck. The
 * real launch cost was driver resolution (relaunching the browser via a
 * blocking spawnSync to read its version on every launch). This benchmark now
 * backs that fix: caching driver resolution cut launch by ~530ms for both BiDi
 * and Classic. See PERF-05.md and docs/driver-configuration.md.
 *
 * Two metrics:
 *   - launch-only:      wall time of `Browser.launch()` alone.
 *   - cold-critical:    launch + first Classic-only actions (navigate, fill,
 *                       click, assert), launch included — the real-world path
 *                       an automation run pays before it does anything useful.
 *
 * Run with:  npm run bench -- launch-critical-path
 */
import { describe, it, expect } from 'vitest';
import { Browser } from '../../src/index.js';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils.js';
import { median, sample, printTable } from './_perf-utils.js';

const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 5;

/** Time `Browser.launch()` alone (fresh browser, quit is untimed). */
async function launchOnly(enableBiDi: boolean): Promise<number> {
  const start = performance.now();
  const browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi });
  const elapsed = performance.now() - start;
  await browser.quit();
  return elapsed;
}

/** Time the full cold path a real run pays: launch + first Classic actions.
 *  Launch is INSIDE the timed window; browser is fresh each call. */
async function coldCriticalPath(enableBiDi: boolean, baseUrl: string): Promise<number> {
  const start = performance.now();
  const browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi });
  await browser.navigateTo(`${baseUrl}/login.html`);
  await browser.fill('#username', 'perfuser');
  await browser.fill('#password', 'secret');
  await browser.click('#submit');
  await browser.find('#result').expect().toContainText('Welcome back');
  const elapsed = performance.now() - start;
  await browser.quit();
  return elapsed;
}

describe('Launch critical-path benchmark (PERF-05)', () => {
  it(
    'launch-only: Browser.launch() wall time, BiDi vs Classic',
    async () => {
      const bidi = await sample(() => launchOnly(true), WARMUP_ITERATIONS, MEASURED_ITERATIONS);
      const classic = await sample(() => launchOnly(false), WARMUP_ITERATIONS, MEASURED_ITERATIONS);

      printTable('Browser.launch() wall time (launch-only)', [
        { label: 'enableBiDi: true', values: bidi },
        { label: 'enableBiDi: false', values: classic },
      ]);
      const ratio = median(bidi) / median(classic);
      const gap = median(bidi) - median(classic);
      console.log(`  BiDi/Classic launch ratio: ${ratio.toFixed(2)}x  (BiDi adds ${gap.toFixed(0)}ms to launch)`);

      const budget = Number(process.env.PERF_BUDGET_RATIO) || 5.0;
      expect(ratio).toBeLessThan(budget);
    },
    180_000
  );

  it(
    'cold-critical: launch + navigate + fill + click + assert, BiDi vs Classic',
    async () => {
      const baseUrl = EXAMPLES_BASE_URL;
      const bidi = await sample(() => coldCriticalPath(true, baseUrl), WARMUP_ITERATIONS, MEASURED_ITERATIONS);
      const classic = await sample(() => coldCriticalPath(false, baseUrl), WARMUP_ITERATIONS, MEASURED_ITERATIONS);

      printTable('Cold critical path (launch + first Classic actions)', [
        { label: 'enableBiDi: true', values: bidi },
        { label: 'enableBiDi: false', values: classic },
      ]);
      const ratio = median(bidi) / median(classic);
      const gap = median(bidi) - median(classic);
      console.log(`  BiDi/Classic cold-path ratio: ${ratio.toFixed(2)}x  (BiDi adds ${gap.toFixed(0)}ms)`);

      const budget = Number(process.env.PERF_BUDGET_RATIO) || 5.0;
      expect(ratio).toBeLessThan(budget);
    },
    180_000
  );
});
