/**
 * Heavier "issue #20 repro shape" BiDi-vs-Classic benchmark.
 *
 * `bidi-vs-classic.perf.ts` measures a light 2-input login flow. The
 * original #20 repro that showed a 1.7x regression was a heavier 5-test
 * registration suite: form validation, an account-level error from a real
 * network round trip (the step that tripled in duration), an a11y audit,
 * and a keyboard-driven submit. That spec isn't in this repo, so this
 * benchmark reconstructs an equivalent shape out of existing example pages
 * (`login.html`, `network.html`, `a11y.html`, `keyboard.html`) instead of
 * adding a new fixture, per the "reuse existing example pages" rule in
 * `.github/instructions/tests.instructions.md`.
 *
 * Not part of `npm test` (see bidi-vs-classic.perf.ts for why `*.perf.ts`
 * is excluded). Run with `npm run bench`.
 */
import { describe, it, expect } from 'vitest';
import { Browser, Key } from '../../src/index.js';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils.js';
import { median, timed, printTable } from './_perf-utils.js';

const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 4;

/** Submit the login form empty — inline validation error, no navigation away. */
async function runValidationError(browser: Browser, baseUrl: string): Promise<number> {
  const [elapsed] = await timed(async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.click('#submit');
    await browser.find('#result').expect().toContainText('Missing credentials');
  });
  return elapsed;
}

/**
 * POST round trip, waited for via DOM polling (not `waitForResponse`) — the
 * original repro's account-level-error step ran under both Classic and BiDi,
 * so it can't have depended on a BiDi-only wait primitive. No `?bidi=true`:
 * network.html's client-side fetch mock supplies the round-trip delay so the
 * timing is comparable across both modes.
 */
async function runNetworkRoundTrip(browser: Browser, baseUrl: string): Promise<number> {
  const [elapsed] = await timed(async () => {
    await browser.navigateTo(`${baseUrl}/network.html`);
    await browser.click('#post-login-btn');
    await browser.find('#login-result').expect().toContainText('success');
  });
  return elapsed;
}

/** a11y audit of a page with seeded violations (accessibility.should-not-violate step). */
async function runA11yCheck(browser: Browser, baseUrl: string): Promise<number> {
  const [elapsed] = await timed(async () => {
    await browser.navigateTo(`${baseUrl}/a11y.html`);
    await browser.a11y.audit();
  });
  return elapsed;
}

/** Submit via keyboard Enter instead of a click. */
async function runKeyboardSubmit(browser: Browser, baseUrl: string): Promise<number> {
  const [elapsed] = await timed(async () => {
    await browser.navigateTo(`${baseUrl}/keyboard.html`);
    await browser.click('#enterTarget');
    await browser.keyboard.type('done');
    await browser.keyboard.press(Key.Enter);
    await browser.find('#enterResult').expect().toContainText('submitted');
  });
  return elapsed;
}

const STEPS: Array<{ label: string; run: (b: Browser, baseUrl: string) => Promise<number> }> = [
  { label: 'validation error', run: runValidationError },
  { label: 'network round trip', run: runNetworkRoundTrip },
  { label: 'a11y audit', run: runA11yCheck },
  { label: 'keyboard submit', run: runKeyboardSubmit },
];

describe('BiDi vs Classic performance benchmark — heavier issue #20 repro shape', () => {
  it(
    '4-step suite (validation, network round trip, a11y, keyboard submit), enableBiDi true vs false',
    async () => {
      const baseUrl = EXAMPLES_BASE_URL;
      const totalSamples: Record<'true' | 'false', number[]> = { true: [], false: [] };
      const stepSamples: Record<'true' | 'false', number[][]> = {
        true: STEPS.map(() => []),
        false: STEPS.map(() => []),
      };

      for (const enableBiDi of [true, false] as const) {
        const key = String(enableBiDi) as 'true' | 'false';
        const browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi });
        try {
          for (let i = 0; i < WARMUP_ITERATIONS + MEASURED_ITERATIONS; i++) {
            let total = 0;
            for (let s = 0; s < STEPS.length; s++) {
              const elapsed = await STEPS[s].run(browser, baseUrl);
              total += elapsed;
              if (i >= WARMUP_ITERATIONS) stepSamples[key][s].push(elapsed);
            }
            if (i >= WARMUP_ITERATIONS) totalSamples[key].push(total);
          }
        } finally {
          await browser.quit();
        }
      }

      for (let s = 0; s < STEPS.length; s++) {
        printTable(`Step: ${STEPS[s].label}`, [
          { label: 'enableBiDi: true', values: stepSamples.true[s] },
          { label: 'enableBiDi: false', values: stepSamples.false[s] },
        ]);
      }
      printTable('4-step suite total (registration-shape)', [
        { label: 'enableBiDi: true', values: totalSamples.true },
        { label: 'enableBiDi: false', values: totalSamples.false },
      ]);

      const ratio = median(totalSamples.true) / median(totalSamples.false);
      console.log(`  BiDi/Classic registration-shape ratio: ${ratio.toFixed(2)}x`);

      // Soft safety net, same shape as bidi-vs-classic.perf.ts — not a tuned budget.
      const budget = Number(process.env.PERF_BUDGET_RATIO) || 5.0;
      expect(ratio).toBeLessThan(budget);
    },
    180_000
  );
});
