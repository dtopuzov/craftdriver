/**
 * Shadow query-depth benchmark for issue #40.
 *
 * Measures immediately-visible and delayed actions in flat DOM, one open root,
 * and two nested open roots over both BiDi and Classic. Query command counts
 * deliberately exclude the final native element action; they catch accidental
 * duplicate prefix resolution or page-wide root scans in the resolver itself.
 *
 * Run alone with:
 *
 *   HEADLESS=true npx vitest run --config vitest.perf.config.ts tests/perf/shadow-dom.perf.ts
 */
import { describe, expect, it } from 'vitest';
import { Browser } from '../../src/index.js';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils.js';
import { median, printTable, timed } from './_perf-utils.js';

const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 4;

interface Measurement {
  elapsed: number;
  queryCommands: number;
}

type PathKind = 'flat' | 'one-root' | 'two-roots';

function instrumentQueryCommands(browser: Browser): {
  reset(): void;
  count(): number;
  restore(): void;
} {
  const internal = browser as unknown as {
    driver: Record<string, unknown>;
    bidiSession?: {
      isConnected(): boolean;
      getConnection(): { send(method: string, params?: Record<string, unknown>): Promise<unknown> };
    };
  };
  let count = 0;
  const restores: Array<() => void> = [];
  for (const name of ['findElement', 'findElements', 'executeScript', 'findElementsFromShadowRoot']) {
    const original = internal.driver[name];
    if (typeof original !== 'function') continue;
    internal.driver[name] = function (this: unknown, ...args: unknown[]) {
      count += 1;
      return original.apply(this, args);
    };
    restores.push(() => { internal.driver[name] = original; });
  }
  if (internal.bidiSession?.isConnected()) {
    const connection = internal.bidiSession.getConnection();
    const original = connection.send.bind(connection);
    connection.send = (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'script.callFunction' || method === 'browsingContext.locateNodes') count += 1;
      return original(method, params);
    };
    restores.push(() => { connection.send = original; });
  }
  return {
    reset: () => { count = 0; },
    count: () => count,
    restore: () => restores.reverse().forEach((restore) => restore()),
  };
}

async function runPath(
  browser: Browser,
  instrument: ReturnType<typeof instrumentQueryCommands>,
  path: PathKind,
  delayed: boolean
): Promise<Measurement> {
  await browser.navigateTo(`${EXAMPLES_BASE_URL}/shadow-dom.html`);
  instrument.reset();
  const [elapsed] = await timed(async () => {
    if (path === 'flat') {
      await browser.locator(delayed ? '#delayed-flat-action' : '#replace-card').click();
      return;
    }
    if (path === 'one-root') {
      await browser
        .locator('#card')
        .shadowRoot()
        .locator(delayed ? '#delayed-card-action' : '#edit')
        .click();
      return;
    }
    const nested = browser
      .locator('#card')
      .shadowRoot()
      .locator('address-form')
      .shadowRoot();
    await nested
      .locator(delayed ? '#delayed-shadow-action' : '#nested-save')
      .click();
  });
  return { elapsed, queryCommands: instrument.count() };
}

async function samples(
  browser: Browser,
  instrument: ReturnType<typeof instrumentQueryCommands>,
  path: PathKind,
  delayed: boolean
): Promise<Measurement[]> {
  const out: Measurement[] = [];
  for (let i = 0; i < WARMUP_ITERATIONS + MEASURED_ITERATIONS; i++) {
    const value = await runPath(browser, instrument, path, delayed);
    if (i >= WARMUP_ITERATIONS) out.push(value);
  }
  return out;
}

describe('Shadow DOM query-depth performance', () => {
  it('reports median/p95 latency and depth-proportional query command counts', async () => {
    for (const enableBiDi of [true, false]) {
      const browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi });
      const instrument = instrumentQueryCommands(browser);
      try {
        for (const delayed of [false, true]) {
          const result = new Map<PathKind, Measurement[]>();
          for (const path of ['flat', 'one-root', 'two-roots'] as const) {
            result.set(path, await samples(browser, instrument, path, delayed));
          }
          const label = `${enableBiDi ? 'BiDi' : 'Classic'} ${delayed ? 'delayed' : 'immediate'} action`;
          printTable(label, [...result].map(([path, values]) => ({
            label: path,
            values: values.map((value) => value.elapsed),
          })));
          console.log(
            `  median query commands: ${[...result].map(([path, values]) =>
              `${path}=${median(values.map((value) => value.queryCommands))}`
            ).join(', ')}`
          );

          const flat = median(result.get('flat')!.map((value) => value.queryCommands));
          const one = median(result.get('one-root')!.map((value) => value.queryCommands));
          const two = median(result.get('two-roots')!.map((value) => value.queryCommands));
          if (!delayed) {
            expect(one).toBeGreaterThan(flat);
            expect(two).toBeGreaterThan(one);
          } else {
            // Deeper attempts take longer, so their delayed node can appear in
            // fewer polls. Assert each poll is still exactly depth-linear:
            // document=1, document+one root=3, document+two roots=5 commands.
            expect(result.get('flat')!.every((value) => value.queryCommands % 1 === 0)).toBe(true);
            expect(result.get('one-root')!.every((value) => value.queryCommands % 3 === 0)).toBe(true);
            expect(result.get('two-roots')!.every((value) => value.queryCommands % 5 === 0)).toBe(true);
            expect(flat).toBeGreaterThanOrEqual(1);
            expect(one).toBeGreaterThanOrEqual(3);
            expect(two).toBeGreaterThanOrEqual(5);
          }
          // Wide timing budget: a regression tripwire, not a hardware score.
          expect(median(result.get('two-roots')!.map((value) => value.elapsed)))
            .toBeLessThan(Math.max(1000, median(result.get('flat')!.map((value) => value.elapsed)) * 20));
        }
      } finally {
        instrument.restore();
        await browser.quit();
      }
    }
  }, 180_000);
});
