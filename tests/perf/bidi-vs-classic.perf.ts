/**
 * BiDi-vs-Classic performance benchmark (issue #20).
 *
 * Not part of `npm test` — this file is named `*.perf.ts` (not `*.test.ts`),
 * so the default vitest include glob never matches it. Run explicitly with:
 *
 *   npm run bench
 *
 * Measures the same flow with `enableBiDi: true` and `enableBiDi: false` and
 * reports median/p95 wall time plus the BiDi/Classic ratio, so future changes
 * to the protocol-selection code can be checked against a number instead of
 * a guess. See the "Fix BiDi performance regression" plan for the phased
 * changes this benchmark is meant to validate.
 */
import { describe, it, expect } from 'vitest';
import { Browser } from '../../src/index.js';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils.js';

const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 4;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const start = performance.now();
  const result = await fn();
  return [performance.now() - start, result];
}

/** Run WARMUP_ITERATIONS + MEASURED_ITERATIONS samples of `fn`, discarding the warmup. */
async function sample(fn: () => Promise<number>): Promise<number[]> {
  const values: number[] = [];
  for (let i = 0; i < WARMUP_ITERATIONS + MEASURED_ITERATIONS; i++) {
    const elapsed = await fn();
    if (i >= WARMUP_ITERATIONS) values.push(elapsed);
  }
  return values;
}

/** Navigate to login.html, fill 2 inputs, submit, assert the result text. Clears
 *  the session cookie afterward (untimed) so the next iteration hits a fresh
 *  form. Cookie clearing must happen after a page has loaded — clearing before
 *  any navigation hits a pre-existing Classic-mode `getCookiesClassic()` bug
 *  (`document.cookie` script on the driver's blank initial page). */
async function runFlow(browser: Browser, baseUrl: string): Promise<number> {
  const [elapsed] = await timed(async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.activePage();
    await browser.fill('#username', 'perfuser');
    await browser.fill('#password', 'secret');
    await browser.click('#submit');
    await browser.find('#result').expect().toContainText('Welcome back');
  });
  await browser.storage.clearCookies();
  return elapsed;
}

async function runConnectOnly(enableBiDi: boolean): Promise<number> {
  const start = performance.now();
  const browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi });
  const elapsed = performance.now() - start;
  await browser.quit();
  return elapsed;
}

async function runNetworkWait(browser: Browser, baseUrl: string): Promise<number> {
  await browser.navigateTo(`${baseUrl}/network.html?bidi=true`);
  const [elapsed] = await timed(() =>
    Promise.all([browser.waitForResponse('**/api/login'), browser.click('#post-login-btn')])
  );
  return elapsed;
}

function printTable(title: string, rows: Array<{ label: string; values: number[] }>): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  for (const { label, values } of rows) {
    console.log(
      `  ${label.padEnd(28)} median=${fmt(median(values)).padStart(9)}  p95=${fmt(p95(values)).padStart(9)}  n=${values.length}`
    );
  }
}

describe('BiDi vs Classic performance benchmark', () => {
  it(
    'connect-time-only: Browser.launch() for enableBiDi true vs false',
    async () => {
      const bidiSamples = await sample(() => runConnectOnly(true));
      const classicSamples = await sample(() => runConnectOnly(false));

      printTable('Browser.launch() only', [
        { label: 'enableBiDi: true', values: bidiSamples },
        { label: 'enableBiDi: false', values: classicSamples },
      ]);

      const ratio = median(bidiSamples) / median(classicSamples);
      console.log(`  BiDi/Classic connect-time ratio: ${ratio.toFixed(2)}x`);

      // Soft safety net only — this is not the tuned budget from the plan.
      // Tighten once Phase 1+2 land and a stable baseline exists.
      const budget = Number(process.env.PERF_BUDGET_RATIO) || 5.0;
      expect(ratio).toBeLessThan(budget);
    },
    180_000
  );

  it(
    'E2E flow: navigate + fill + click + assert, enableBiDi true vs false',
    async () => {
      const baseUrl = EXAMPLES_BASE_URL;
      const flowSamples: Record<'true' | 'false', number[]> = { true: [], false: [] };
      let networkWaitSamples: number[] = [];

      for (const enableBiDi of [true, false] as const) {
        const browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi });
        try {
          flowSamples[String(enableBiDi) as 'true' | 'false'] = await sample(() =>
            runFlow(browser, baseUrl)
          );

          if (enableBiDi) {
            networkWaitSamples = await sample(() => runNetworkWait(browser, baseUrl));
          }
        } finally {
          await browser.quit();
        }
      }

      printTable('E2E flow (navigate → fill ×2 → click → assert)', [
        { label: 'enableBiDi: true', values: flowSamples.true },
        { label: 'enableBiDi: false', values: flowSamples.false },
      ]);
      printTable('waitForResponse round trip (BiDi only — informational)', [
        { label: 'enableBiDi: true', values: networkWaitSamples },
      ]);

      const ratio = median(flowSamples.true) / median(flowSamples.false);
      console.log(`  BiDi/Classic E2E-flow ratio: ${ratio.toFixed(2)}x`);

      const budget = Number(process.env.PERF_BUDGET_RATIO) || 5.0;
      expect(ratio).toBeLessThan(budget);
    },
    180_000
  );
});
