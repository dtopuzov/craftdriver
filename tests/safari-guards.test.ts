/**
 * Safari's `browserName`-keyed UNSUPPORTED guards, in one lane.
 *
 * Two families of guard share the same shape and the same test harness, so
 * they live together here:
 *
 *   1. BiDi-only surface (`network`, `logs`, `grantPermissions()`,
 *      `setGeolocation()`, `emulate()`, `newContext()`, `contexts()`,
 *      full-page `screenshot()`, dialogs, etc.) — unavailable because Safari
 *      has no WebDriver BiDi.
 *   2. Touch actions (`gesture.swipe()`/`gesture.pinch()`), which send W3C
 *      pointer input with `pointerType: 'touch'` that desktop `safaridriver`
 *      gives no indication it synthesizes on a touchscreen-less Mac.
 *
 * Both must throw `CraftdriverError`/`UNSUPPORTED` with a stable
 * `{ browserName: 'safari', feature }` detail when `browserName` is Safari,
 * while every other browser launched with `enableBiDi: false` keeps
 * throwing the exact same plain `Error` it always has.
 *
 * This does not require a real Safari install. Every guard here is a
 * pre-flight check keyed on `this._browserName` (and, for the BiDi family,
 * `bidiSession` connectivity), so it's exercised against a real browser
 * launched with `enableBiDi: false` (giving an unconnected `bidiSession`,
 * exactly as Safari's would be) with `_browserName` patched to `'safari'` to
 * prove the Safari branch fires before any network call is made.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser, CraftdriverError, ErrorCode } from '../src';
import { BROWSER_NAME, EXAMPLES_BASE_URL } from './utils';

describe('Safari-specific UNSUPPORTED guards', () => {
  let noBidi: Browser;

  beforeAll(async () => {
    noBidi = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
  });

  afterAll(async () => {
    await noBidi.quit();
  });

  function asSafari<T>(run: () => T): T {
    const b = noBidi as unknown as { _browserName: string };
    const original = b._browserName;
    b._browserName = 'safari';
    try {
      return run();
    } finally {
      b._browserName = original;
    }
  }

  function expectUnsupported(err: unknown, feature: string): void {
    expect(err).toBeInstanceOf(CraftdriverError);
    expect((err as CraftdriverError).code).toBe(ErrorCode.UNSUPPORTED);
    expect((err as CraftdriverError).detail).toMatchObject({
      browserName: 'safari',
      feature,
    });
  }

  describe('on Safari (browserName patched, BiDi unconnected)', () => {
    it('network getter throws UNSUPPORTED', () => {
      const err = asSafari(() => {
        try {
          void noBidi.network;
          return undefined;
        } catch (e) {
          return e;
        }
      });
      expectUnsupported(err, 'network');
    });

    it('logs getter throws UNSUPPORTED', () => {
      const err = asSafari(() => {
        try {
          void noBidi.logs;
          return undefined;
        } catch (e) {
          return e;
        }
      });
      expectUnsupported(err, 'logs');
    });

    it('grantPermissions() throws UNSUPPORTED', async () => {
      const err = await asSafari(() => noBidi.grantPermissions(['geolocation']).catch((e: unknown) => e));
      expectUnsupported(err, 'grantPermissions()');
    });

    it('setGeolocation() throws UNSUPPORTED', async () => {
      const err = await asSafari(() =>
        noBidi.setGeolocation({ latitude: 1, longitude: 1 }).catch((e: unknown) => e)
      );
      expectUnsupported(err, 'setGeolocation()');
    });

    it('emulate() throws UNSUPPORTED', async () => {
      const err = await asSafari(() => noBidi.emulate({ locale: 'de-DE' }).catch((e: unknown) => e));
      expectUnsupported(err, 'emulate()');
    });

    it('newContext() throws UNSUPPORTED', async () => {
      const err = await asSafari(() => noBidi.newContext().catch((e: unknown) => e));
      expectUnsupported(err, 'newContext()');
    });

    it('contexts() throws UNSUPPORTED', async () => {
      const err = await asSafari(() => noBidi.contexts().catch((e: unknown) => e));
      expectUnsupported(err, 'contexts()');
    });

    it('screenshot({ fullPage: true }) throws UNSUPPORTED', async () => {
      const err = await asSafari(() => noBidi.screenshot({ fullPage: true }).catch((e: unknown) => e));
      expectUnsupported(err, 'screenshot({ fullPage: true })');
    });

    it('openPage() throws UNSUPPORTED', async () => {
      const err = await asSafari(() => noBidi.openPage({ url: 'about:blank' }).catch((e: unknown) => e));
      expectUnsupported(err, 'openPage()');
    });

    it('defaultContext getter throws UNSUPPORTED', () => {
      const err = asSafari(() => {
        try {
          void noBidi.defaultContext;
          return undefined;
        } catch (e) {
          return e;
        }
      });
      expectUnsupported(err, 'defaultContext');
    });

    it('addInitScript() throws UNSUPPORTED', async () => {
      const err = await asSafari(() =>
        noBidi.addInitScript(() => { /* no-op */ }).catch((e: unknown) => e)
      );
      expectUnsupported(err, 'addInitScript()');
    });

    it('waitForRequest() throws UNSUPPORTED', () => {
      const err = asSafari(() => {
        try {
          void noBidi.waitForRequest('**/x');
          return undefined;
        } catch (e) {
          return e;
        }
      });
      expectUnsupported(err, 'waitForRequest()');
    });

    it('waitForResponse() throws UNSUPPORTED', () => {
      const err = asSafari(() => {
        try {
          void noBidi.waitForResponse('**/x');
          return undefined;
        } catch (e) {
          return e;
        }
      });
      expectUnsupported(err, 'waitForResponse()');
    });

    it("on('request') throws UNSUPPORTED", () => {
      const err = asSafari(() => {
        try {
          void noBidi.on('request', () => { /* no-op */ });
          return undefined;
        } catch (e) {
          return e;
        }
      });
      expectUnsupported(err, "browser.on('request')");
    });

    it('waitForDownload() throws UNSUPPORTED', async () => {
      const err = await asSafari(() =>
        noBidi.waitForDownload(async () => { /* no-op */ }).catch((e: unknown) => e)
      );
      expectUnsupported(err, 'waitForDownload()');
    });

    it('gesture.swipe() throws UNSUPPORTED (touch-type pointer input)', async () => {
      const err = await asSafari(() =>
        noBidi.gesture.swipe({ from: [0, 0], to: [10, 10] }).catch((e: unknown) => e)
      );
      expectUnsupported(err, 'gesture.swipe()');
    });

    it('gesture.pinch() throws UNSUPPORTED (touch-type pointer input)', async () => {
      const err = await asSafari(() =>
        noBidi.gesture.pinch({ center: [50, 50] }).catch((e: unknown) => e)
      );
      expectUnsupported(err, 'gesture.pinch()');
    });
  });

  describe('on non-Safari without BiDi (unchanged plain Error)', () => {
    it('network getter still throws a plain Error, not CraftdriverError', () => {
      let err: unknown;
      try {
        void noBidi.network;
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^Network interception requires BiDi\. /);
    });

    it('logs getter still throws a plain Error, not CraftdriverError', () => {
      let err: unknown;
      try {
        void noBidi.logs;
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^Log monitoring requires BiDi\. /);
    });

    it('grantPermissions() still throws a plain Error, not CraftdriverError', async () => {
      const err = await noBidi.grantPermissions(['geolocation']).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^grantPermissions\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('setGeolocation() still throws a plain Error, not CraftdriverError', async () => {
      const err = await noBidi.setGeolocation({ latitude: 1, longitude: 1 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^setGeolocation\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('emulate() still throws a plain Error, not CraftdriverError', async () => {
      const err = await noBidi.emulate({ locale: 'de-DE' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^emulate\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('newContext() still throws a plain Error, not CraftdriverError', async () => {
      const err = await noBidi.newContext().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^newContext\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('contexts() still throws a plain Error, not CraftdriverError', async () => {
      const err = await noBidi.contexts().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^contexts\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('screenshot({ fullPage: true }) still throws a plain Error, not CraftdriverError', async () => {
      const err = await noBidi.screenshot({ fullPage: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(
        /^screenshot\(\{ fullPage: true \}\) requires BiDi \(enableBiDi: true\)\. /
      );
    });

    it('openPage() still throws a plain Error, not CraftdriverError', async () => {
      const err = await noBidi.openPage({ url: 'about:blank' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^openPage\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('addInitScript() still throws a plain Error, not CraftdriverError', async () => {
      const err = await noBidi.addInitScript(() => { /* no-op */ }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^addInitScript\(\) requires BiDi\. /);
    });

    it('waitForRequest() still throws a plain Error, not CraftdriverError', () => {
      let err: unknown;
      try {
        void noBidi.waitForRequest('**/x');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^waitForRequest\(\) requires BiDi\. /);
    });

    it("on('request') still throws a plain Error, not CraftdriverError", () => {
      let err: unknown;
      try {
        void noBidi.on('request', () => { /* no-op */ });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^browser\.on\('request'\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('defaultContext still throws a plain Error, not CraftdriverError', () => {
      let err: unknown;
      try {
        void noBidi.defaultContext;
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^defaultContext requires BiDi \(enableBiDi: true\)\. /);
    });
  });
});

/**
 * Prove `isBiDiEnabled()` structurally cannot report `true` for Safari.
 *
 * `resolveLaunchTarget()` rejects `enableBiDi: true` for
 * `browserName: 'safari'` before any driver
 * process starts, and Safari's capabilities branch never sends
 * `webSocketUrl: true` in Safari's capabilities branch — so a Safari-launched
 * `Browser`'s `bidiSession` can never become a connected `BidiSession`.
 * `isBiDiEnabled()` is `this.bidiSession?.isConnected() ?? false`, so this is
 * provable directly: a `Browser` launched with `enableBiDi: false` (which is
 * what every real Safari launch resolves to, by construction) always has an
 * `undefined` `bidiSession`, regardless of what `_browserName` claims to be.
 */
describe('isBiDiEnabled() on Safari', () => {
  let noBidi: Browser;

  beforeAll(async () => {
    noBidi = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
  });

  afterAll(async () => {
    await noBidi.quit();
  });

  it('reports false for a real browser instance patched to look like Safari', () => {
    const b = noBidi as unknown as { _browserName: string };
    const original = b._browserName;
    b._browserName = 'safari';
    try {
      expect(noBidi.isBiDiEnabled()).toBe(false);
    } finally {
      b._browserName = original;
    }
  });

  it('structural invariant: bidiSession is undefined when BiDi was never enabled', () => {
    // Lighter unit-level check of the same fact isBiDiEnabled() reads from:
    // no bidiSession was ever created for this Browser instance, because it
    // was launched with enableBiDi: false — exactly what 1.1.3 forces for
    // every real Safari launch, regardless of what the caller asked for.
    const b = noBidi as unknown as { bidiSession: unknown };
    expect(b.bidiSession).toBeUndefined();
  });
});

/**
 * Safari's Classic-mode `onDialog()`/`waitForDialog()` contract.
 *
 * Safari has no WebDriver BiDi, so there is no push-event mechanism for
 * dialogs. Rather than silently no-op (today's Classic behavior for every
 * other browser) or let `waitForDialog()` hang until its own generic
 * timeout — which looks like a missed dialog, not "this API isn't supported
 * here" — `onDialog()` fails immediately for Safari with a clear
 * `CraftdriverError`/`UNSUPPORTED`, and `waitForDialog()` (built on
 * `onDialog()`) must propagate that same error rather than swallowing it and
 * waiting out its own timeout.
 *
 * The imperative dialog methods (`acceptDialog()`, `dismissDialog()`,
 * `getDialogMessage()`) are unaffected — they already work in Classic mode
 * via `driver.acceptAlert()`/`dismissAlert()`/`getAlertText()`/
 * `sendAlertText()` — and this task must not gate them. That is proven here
 * against a real dialog on the example page, using whatever browser this
 * sandbox actually runs (non-Safari) — the point is that patching
 * `_browserName` to `'safari'` around the imperative calls does not throw
 * UNSUPPORTED, i.e. they are not routed through onDialog()/requireBiDi() at
 * all.
 */
describe('onDialog()/waitForDialog() Safari Classic-mode contract', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/dialogs.html`);
  });

  afterAll(async () => {
    await browser.quit();
  });

  function asSafari<T>(b: Browser, run: () => T): T {
    const patched = b as unknown as { _browserName: string };
    const original = patched._browserName;
    patched._browserName = 'safari';
    try {
      return run();
    } finally {
      patched._browserName = original;
    }
  }

  it('onDialog() throws UNSUPPORTED synchronously on Safari', () => {
    let err: unknown;
    try {
      asSafari(browser, () =>
        browser.onDialog(() => {
          /* never called */
        })
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CraftdriverError);
    expect((err as CraftdriverError).code).toBe(ErrorCode.UNSUPPORTED);
    expect((err as CraftdriverError).detail).toMatchObject({
      browserName: 'safari',
      feature: 'onDialog()',
    });
  });

  it('waitForDialog() rejects with the same UNSUPPORTED error on Safari, not a generic timeout', async () => {
    const err = await asSafari(browser, () =>
      browser.waitForDialog({ timeout: 50 }).catch((e: unknown) => e)
    );
    expect(err).toBeInstanceOf(CraftdriverError);
    expect((err as CraftdriverError).code).toBe(ErrorCode.UNSUPPORTED);
    expect((err as CraftdriverError).detail).toMatchObject({
      browserName: 'safari',
      feature: 'onDialog()',
    });
    // Not the generic "timed out after Nms" message a swallowed throw would
    // eventually produce.
    expect((err as Error).message).not.toMatch(/timed out/);
  });

  it('onDialog() still returns a no-op unsubscribe for non-Safari (regression check)', () => {
    let called = false;
    const off = browser.onDialog(() => {
      called = true;
    });
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
    expect(called).toBe(false);
  });

  it('acceptDialog()/dismissDialog()/getDialogMessage() are not gated for Safari', async () => {
    // Patching _browserName to 'safari' around the imperative calls must not
    // throw UNSUPPORTED — these methods talk to the driver directly and are
    // never routed through onDialog()/requireBiDi().
    await browser.click('#show-alert');
    const message = await asSafari(browser, () => browser.getDialogMessage());
    expect(message).toBe('Hello from alert');
    await asSafari(browser, () => browser.acceptDialog());
    await browser.expect('h1').toHaveText('Dialogs');
  });
});
