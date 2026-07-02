/**
 * BiDi-vs-Classic benchmark against a *real* running app (craftdriver-demos'
 * EasyMath: React + a real Postgres-backed API), not the static example
 * pages `tests/perf/*.perf.ts` uses. Mirrors
 * `craftdriver-demos/tests/e2e/spec/registration.spec.ts`'s 4 measured steps
 * (validation error, account-level error from a real network round trip,
 * a11y check, keyboard-driven submit) as closely as possible using the same
 * selectors as that spec's page objects.
 *
 * Why this file exists: `craftdriver-demos` depends on the *published*
 * `craftdriver` npm package, not this repo's working tree, so running its
 * spec directly never exercises local changes. This benchmark imports
 * `Browser` from `../../../src/index.js` — always the current code.
 *
 * Prerequisites (not automated by this file, unlike `db:reset` below):
 *   - A sibling `craftdriver-demos` checkout (override with CRAFTDRIVER_DEMOS_DIR).
 *   - Docker running (for the demos app's Postgres container).
 *   - The demos app's dev server already running (`pnpm dev` in that repo),
 *     default http://127.0.0.1:5173 (override with E2E_BASE_URL).
 *
 * Run with `npm run bench:realapp`. Set SKIP_DB_RESET=1 to skip the
 * `pnpm db:reset` step (faster re-runs once seeded data already exists).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it, beforeAll, expect } from 'vitest';
import { Browser, By, Key } from '../../../src/index.js';
import { median, timed, printTable } from '../_perf-utils.js';

const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 3;

const baseUrl = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';
const registerPath = '/register';
const demosDir = process.env.CRAFTDRIVER_DEMOS_DIR ?? path.resolve(process.cwd(), '..', 'craftdriver-demos');

// Matches craftdriver-demos/tests/e2e/data/seeded-users.ts — seeded by `db:seed`.
const seededExistingEmail = 'ada.student@example.test';

function makeRegistrationStudent() {
  const suffix = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  return {
    displayName: `Perf Student ${suffix}`,
    email: `perf.student.${suffix}@example.test`,
    password: 'learning-2026',
  };
}

async function runValidationError(browser: Browser, baseUrl: string): Promise<number> {
  const [elapsed] = await timed(async () => {
    await browser.navigateTo(`${baseUrl}${registerPath}`);
    await browser.fill(By.labelText('Learner’s name'), 'A');
    await browser.fill(By.labelText('Email'), 'not-an-email');
    await browser.fill('#registration-password', 'short');
    await browser.fill(By.labelText('Confirm password'), 'short');
    await browser.click('#registration-submit');
    await browser.find('#registration-display-name-error').expect().toHaveText(
      'Enter a name with at least 2 characters.'
    );
    await browser.find('#registration-email-error').expect().toHaveText(
      'Enter a valid email address.'
    );
  });
  return elapsed;
}

async function runExistingEmailError(browser: Browser, baseUrl: string): Promise<number> {
  const [elapsed] = await timed(async () => {
    await browser.navigateTo(`${baseUrl}${registerPath}`);
    await browser.fill(By.labelText('Learner’s name'), 'Ada Duplicate');
    await browser.fill(By.labelText('Email'), seededExistingEmail);
    await browser.fill('#registration-password', 'learning-2026');
    await browser.fill(By.labelText('Confirm password'), 'learning-2026');
    await browser.click('#registration-submit');
    await browser.find('#registration-form-error').expect().toHaveText(
      'An account with this email already exists. Please sign in instead.'
    );
  });
  return elapsed;
}

async function runA11yCheck(browser: Browser, baseUrl: string): Promise<number> {
  const [elapsed] = await timed(async () => {
    await browser.navigateTo(`${baseUrl}${registerPath}`);
    await browser.a11y.check();
  });
  return elapsed;
}

async function runKeyboardSubmit(browser: Browser, baseUrl: string): Promise<number> {
  const [elapsed] = await timed(async () => {
    const learner = makeRegistrationStudent();
    await browser.navigateTo(`${baseUrl}${registerPath}`);
    await browser.keyboard.press(Key.Tab);
    await browser.keyboard.type(learner.displayName);
    await browser.keyboard.press(Key.Tab);
    await browser.keyboard.type(learner.email);
    await browser.keyboard.press(Key.Tab);
    await browser.keyboard.type(learner.password);
    await browser.keyboard.press(Key.Tab);
    await browser.keyboard.type(learner.password);
    await browser.keyboard.press(Key.Enter);
    await browser.find('#student-dashboard-title').expect().toHaveText('My exams');
  });
  return elapsed;
}

const STEPS: Array<{ label: string; run: (b: Browser, baseUrl: string) => Promise<number> }> = [
  { label: 'validation error', run: runValidationError },
  { label: 'existing-email account error (real network)', run: runExistingEmailError },
  { label: 'a11y check', run: runA11yCheck },
  { label: 'keyboard submit', run: runKeyboardSubmit },
];

describe('BiDi vs Classic performance benchmark — real app (EasyMath registration)', () => {
  beforeAll(async () => {
    if (process.env.SKIP_DB_RESET === '1') return;
    execFileSync('pnpm', ['db:reset'], { cwd: demosDir, stdio: 'inherit' });
  }, 120_000);

  it(
    '4-step suite against a real Postgres-backed app, enableBiDi true vs false',
    async () => {
      const totalSamples: Record<'true' | 'false', number[]> = { true: [], false: [] };
      const stepSamples: Record<'true' | 'false', number[][]> = {
        true: STEPS.map(() => []),
        false: STEPS.map(() => []),
      };

      for (const enableBiDi of [true, false] as const) {
        const key = String(enableBiDi) as 'true' | 'false';
        const browser = await Browser.launch({ browserName: 'chrome', enableBiDi });
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
      printTable('4-step suite total (EasyMath registration)', [
        { label: 'enableBiDi: true', values: totalSamples.true },
        { label: 'enableBiDi: false', values: totalSamples.false },
      ]);

      const ratio = median(totalSamples.true) / median(totalSamples.false);
      console.log(`  BiDi/Classic real-app ratio: ${ratio.toFixed(2)}x`);

      // Informational only — no tuned budget yet for the real-app shape.
      const budget = Number(process.env.PERF_BUDGET_RATIO) || 10.0;
      expect(ratio).toBeLessThan(budget);
    },
    180_000
  );
});
