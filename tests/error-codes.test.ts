import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, By, CraftdriverError, ErrorCode } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('error codes', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: true });
    browser.setDefaultTimeout(500);
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
  });

  it('locator.click on a missing selector throws NO_MATCH', async () => {
    let err: unknown;
    try {
      await browser.locator('#definitely-not-here').click();
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.NO_MATCH)).toBe(true);
    expect((err as CraftdriverError).detail).toMatchObject({
      using: 'css selector',
      value: '#definitely-not-here',
    });
  });

  it('locator on an existing-but-hidden element throws TIMEOUT_WAITING_VISIBLE', async () => {
    // Inject an attached but display:none element so the locator can match it.
    await browser.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'hidden-target';
      el.textContent = 'hidden';
      el.style.display = 'none';
      document.body.appendChild(el);
    });
    let err: unknown;
    try {
      // Use a chained locator (not the fast simple path) so we hit
      // _waitForVisible directly and exercise the visible-vs-no-match split.
      await browser.locator('body').locator('#hidden-target').click();
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.TIMEOUT_WAITING_VISIBLE)).toBe(true);
  });

  it('expect() failure throws EXPECT_MISMATCH', async () => {
    let err: unknown;
    try {
      await browser.locator('h1').expect().toHaveText('this is not the heading');
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.EXPECT_MISMATCH)).toBe(true);
  });

  it('evaluate() with a non-JSON arg throws EVAL_BAD_ARG', async () => {
    let err: unknown;
    try {
      await browser.evaluate((x: unknown) => x, () => 1);
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.EVAL_BAD_ARG)).toBe(true);
  });

  it('evaluate() of code that throws yields EVAL_THREW', async () => {
    let err: unknown;
    try {
      await browser.evaluate(() => {
        throw new Error('boom from page');
      });
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.EVAL_THREW)).toBe(true);
  });

  // ── Phase 0: WebDriver protocol errors surface as DRIVER_ERROR ────────────
  // A snapshot handle from findAll() clicks its captured element directly with
  // no retry, so a genuine protocol failure (stale / intercepted) surfaces raw
  // instead of being retried away — the ideal probe for the HTTP-layer fix.

  it('clicking a snapshot handle whose element was removed throws DRIVER_ERROR (stale)', async () => {
    const [handle] = await browser.findAll('#username');
    await browser.evaluate(() => document.getElementById('username')?.remove());
    let err: unknown;
    try {
      await handle.click();
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)).toBe(true);
    expect(String((err as CraftdriverError).detail?.webDriverError)).toContain('stale element');
    const stack = String((err as Error).stack);
    expect(stack).toContain('tests/error-codes.test.ts');
    expect(stack).not.toContain('src/lib/http.ts');
  });

  it('clicking a snapshot handle covered by an overlay throws DRIVER_ERROR (intercepted)', async () => {
    const [handle] = await browser.findAll('#username');
    await browser.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.id = 'cover';
      overlay.style.position = 'fixed';
      overlay.style.inset = '0';
      overlay.style.background = 'rgba(0,0,0,0.01)';
      overlay.style.zIndex = '99999';
      document.body.appendChild(overlay);
    });
    let err: unknown;
    try {
      await handle.click();
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)).toBe(true);
    expect(String((err as CraftdriverError).detail?.webDriverError)).toContain('intercepted');
  });

  it('evaluate() returning error-shaped data resolves — status gating, not body shape', async () => {
    // Regression guard: a *successful* command whose value happens to look like
    // a WebDriver error body must NOT be misread as a protocol failure.
    const result = await browser.evaluate(() => ({ error: 'x', message: 'y', stacktrace: 'z' }));
    expect(result).toEqual({ error: 'x', message: 'y', stacktrace: 'z' });
  });

  it('stopTrace() without startTrace() throws STATE_INVALID', async () => {
    let err: unknown;
    try {
      await browser.stopTrace();
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.STATE_INVALID)).toBe(true);
  });

  it('locator.waitFor() with a bogus state throws INVALID_ARGUMENT', async () => {
    let err: unknown;
    try {
      await browser.locator('h1').waitFor({ state: 'nonsense' as never });
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.INVALID_ARGUMENT)).toBe(true);
  });

  it('every CraftdriverError remains instanceof Error and carries a hint where applicable', async () => {
    let err: CraftdriverError | undefined;
    try {
      await browser.locator(By.css('#missing-too')).click();
    } catch (e) {
      err = e as CraftdriverError;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CraftdriverError);
    expect(typeof err!.hint).toBe('string');
  });
});
