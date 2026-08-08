import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, By, CraftdriverError, ErrorCode, type ErrorCodeValue } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

async function expectCraftdriverError(
  action: () => Promise<unknown>,
  code: ErrorCodeValue
): Promise<CraftdriverError> {
  const err = await action().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CraftdriverError);
  const craftdriverError = err as CraftdriverError;
  expect(craftdriverError.code).toBe(code);
  return craftdriverError;
}

describe('error codes', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    browser.setDefaultTimeout(500);
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
  });

  it('locator.click on a missing selector throws NO_MATCH', async () => {
    const err = await expectCraftdriverError(
      () => browser.locator('#definitely-not-here').click(),
      ErrorCode.NO_MATCH
    );

    expect(err.detail).toMatchObject({
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

    // Use a chained locator (not the fast simple path) so we hit
    // _waitForVisible directly and exercise the visible-vs-no-match split.
    await expectCraftdriverError(
      () => browser.locator('body').locator('#hidden-target').click(),
      ErrorCode.TIMEOUT_WAITING_VISIBLE
    );
  });

  // The browser-level actions used to report a bare
  // `TIMEOUT: Wait timed out after 4980ms` for both of the cases below — no
  // selector, no state, nothing separating "your selector is wrong" from
  // "it's there but hidden". Both codes are documented, and this is the path
  // the CLI and MCP surfaces call, so the diagnosis has to survive it.
  describe('browser-level actions diagnose a failed visibility wait', () => {
    beforeEach(async () => {
      await browser.evaluate(() => {
        const el = document.createElement('input');
        el.id = 'hidden-input';
        el.style.display = 'none';
        document.body.appendChild(el);
      });
    });

    const actions = {
      click: (b: Browser, sel: string) => b.click(sel),
      fill: (b: Browser, sel: string) => b.fill(sel, 'x'),
      clear: (b: Browser, sel: string) => b.clear(sel),
    } as const;

    for (const [name, action] of Object.entries(actions)) {
      it(`browser.${name}() on a hidden element throws TIMEOUT_WAITING_VISIBLE`, async () => {
        const err = await expectCraftdriverError(
          () => action(browser, '#hidden-input'),
          ErrorCode.TIMEOUT_WAITING_VISIBLE
        );
        expect(err.message).toContain('#hidden-input');
        expect(err.detail).toMatchObject({ matched: 1 });
      });

      it(`browser.${name}() on a missing element throws NO_MATCH`, async () => {
        const err = await expectCraftdriverError(
          () => action(browser, '#definitely-not-here'),
          ErrorCode.NO_MATCH
        );
        expect(err.detail).toMatchObject({ matched: 0 });
      });
    }
  });

  it('expect() failure throws EXPECT_MISMATCH', async () => {
    await expectCraftdriverError(
      () => browser.locator('h1').expect().toHaveText('this is not the heading'),
      ErrorCode.EXPECT_MISMATCH
    );
  });

  it('evaluate() with a non-JSON arg throws EVAL_BAD_ARG', async () => {
    await expectCraftdriverError(
      () =>
        browser.evaluate(
          (x: unknown) => x,
          () => 1
        ),
      ErrorCode.EVAL_BAD_ARG
    );
  });

  it('evaluate() of code that throws yields EVAL_THREW', async () => {
    await expectCraftdriverError(
      () =>
        browser.evaluate(() => {
          throw new Error('boom from page');
        }),
      ErrorCode.EVAL_THREW
    );
  });

  // ── WebDriver protocol errors surface as DRIVER_ERROR ─────────────────────
  // A snapshot handle from findAll() clicks its captured element directly with
  // no retry, so a genuine protocol failure (stale / intercepted) surfaces raw
  // instead of being retried away — the ideal probe for the HTTP-layer fix.

  it('clicking a snapshot handle whose element was removed throws DRIVER_ERROR (stale)', async () => {
    const [handle] = await browser.findAll('#username');
    await browser.evaluate(() => document.getElementById('username')?.remove());

    const err = await expectCraftdriverError(() => handle.click(), ErrorCode.DRIVER_ERROR);
    expect(String(err.detail?.webDriverError)).toContain('stale element');
    const stack = String(err.stack);
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

    const err = await expectCraftdriverError(() => handle.click(), ErrorCode.DRIVER_ERROR);
    expect(String(err.detail?.webDriverError)).toContain('intercepted');
  });

  it('evaluate() returning error-shaped data resolves — status gating, not body shape', async () => {
    // Regression guard: a *successful* command whose value happens to look like
    // a WebDriver error body must NOT be misread as a protocol failure.
    const result = await browser.evaluate(() => ({ error: 'x', message: 'y', stacktrace: 'z' }));
    expect(result).toEqual({ error: 'x', message: 'y', stacktrace: 'z' });
  });

  it('stopTrace() without startTrace() throws STATE_INVALID', async () => {
    await expectCraftdriverError(() => browser.stopTrace(), ErrorCode.STATE_INVALID);
  });

  it('locator.waitFor() with a bogus state throws INVALID_ARGUMENT', async () => {
    await expectCraftdriverError(
      () => browser.locator('h1').waitFor({ state: 'nonsense' as never }),
      ErrorCode.INVALID_ARGUMENT
    );
  });

  it('every CraftdriverError remains instanceof Error and carries a hint where applicable', async () => {
    const err = await expectCraftdriverError(
      () => browser.locator(By.css('#missing-too')).click(),
      ErrorCode.NO_MATCH
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CraftdriverError);
    expect(typeof err.hint).toBe('string');
  });
});
