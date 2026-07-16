/** Safari pre-flight guards share one Classic browser; no Safari install is required. */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser, CraftdriverError, ErrorCode } from '../src';
import { BROWSER_NAME, EXAMPLES_BASE_URL } from './utils';

describe('Safari-specific guards (Classic, browserName patched)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
  });

  afterAll(async () => {
    await browser.quit();
  });

  function asSafari<T>(run: () => T): T {
    const b = browser as unknown as { _browserName: string; _engine: string };
    const originalName = b._browserName;
    const originalEngine = b._engine;
    b._browserName = 'safari';
    b._engine = 'safari';
    try {
      return run();
    } finally {
      b._browserName = originalName;
      b._engine = originalEngine;
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
          void browser.network;
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
          void browser.logs;
          return undefined;
        } catch (e) {
          return e;
        }
      });
      expectUnsupported(err, 'logs');
    });

    it('grantPermissions() throws UNSUPPORTED', async () => {
      const err = await asSafari(() => browser.grantPermissions(['geolocation']).catch((e: unknown) => e));
      expectUnsupported(err, 'grantPermissions()');
    });

    it('setGeolocation() throws UNSUPPORTED', async () => {
      const err = await asSafari(() =>
        browser.setGeolocation({ latitude: 1, longitude: 1 }).catch((e: unknown) => e)
      );
      expectUnsupported(err, 'setGeolocation()');
    });

    it('emulate() throws UNSUPPORTED', async () => {
      const err = await asSafari(() => browser.emulate({ locale: 'de-DE' }).catch((e: unknown) => e));
      expectUnsupported(err, 'emulate()');
    });

    it('newContext() throws UNSUPPORTED', async () => {
      const err = await asSafari(() => browser.newContext().catch((e: unknown) => e));
      expectUnsupported(err, 'newContext()');
    });

    it('contexts() throws UNSUPPORTED', async () => {
      const err = await asSafari(() => browser.contexts().catch((e: unknown) => e));
      expectUnsupported(err, 'contexts()');
    });

    it('screenshot({ fullPage: true }) throws UNSUPPORTED', async () => {
      const err = await asSafari(() => browser.screenshot({ fullPage: true }).catch((e: unknown) => e));
      expectUnsupported(err, 'screenshot({ fullPage: true })');
    });

    it('openPage() throws UNSUPPORTED', async () => {
      const err = await asSafari(() => browser.openPage({ url: 'about:blank' }).catch((e: unknown) => e));
      expectUnsupported(err, 'openPage()');
    });

    it('defaultContext getter throws UNSUPPORTED', () => {
      const err = asSafari(() => {
        try {
          void browser.defaultContext;
          return undefined;
        } catch (e) {
          return e;
        }
      });
      expectUnsupported(err, 'defaultContext');
    });

    it('addInitScript() throws UNSUPPORTED', async () => {
      const err = await asSafari(() =>
        browser.addInitScript(() => { /* no-op */ }).catch((e: unknown) => e)
      );
      expectUnsupported(err, 'addInitScript()');
    });

    it('waitForRequest() throws UNSUPPORTED', () => {
      const err = asSafari(() => {
        try {
          void browser.waitForRequest('**/x');
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
          void browser.waitForResponse('**/x');
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
          void browser.on('request', () => { /* no-op */ });
          return undefined;
        } catch (e) {
          return e;
        }
      });
      expectUnsupported(err, "browser.on('request')");
    });

    it('waitForDownload() throws UNSUPPORTED', async () => {
      const err = await asSafari(() =>
        browser.waitForDownload(async () => { /* no-op */ }).catch((e: unknown) => e)
      );
      expectUnsupported(err, 'waitForDownload()');
    });

    it('gesture.swipe() throws UNSUPPORTED (touch-type pointer input)', async () => {
      const err = await asSafari(() =>
        browser.gesture.swipe({ from: [0, 0], to: [10, 10] }).catch((e: unknown) => e)
      );
      expectUnsupported(err, 'gesture.swipe()');
    });

    it('gesture.pinch() throws UNSUPPORTED (touch-type pointer input)', async () => {
      const err = await asSafari(() =>
        browser.gesture.pinch({ center: [50, 50] }).catch((e: unknown) => e)
      );
      expectUnsupported(err, 'gesture.pinch()');
    });
  });

  describe('on non-Safari without BiDi (unchanged plain Error)', () => {
    it('network getter still throws a plain Error, not CraftdriverError', () => {
      let err: unknown;
      try {
        void browser.network;
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
        void browser.logs;
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^Log monitoring requires BiDi\. /);
    });

    it('grantPermissions() still throws a plain Error, not CraftdriverError', async () => {
      const err = await browser.grantPermissions(['geolocation']).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^grantPermissions\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('setGeolocation() still throws a plain Error, not CraftdriverError', async () => {
      const err = await browser.setGeolocation({ latitude: 1, longitude: 1 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^setGeolocation\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('emulate() still throws a plain Error, not CraftdriverError', async () => {
      const err = await browser.emulate({ locale: 'de-DE' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^emulate\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('newContext() still throws a plain Error, not CraftdriverError', async () => {
      const err = await browser.newContext().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^newContext\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('contexts() still throws a plain Error, not CraftdriverError', async () => {
      const err = await browser.contexts().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^contexts\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('screenshot({ fullPage: true }) still throws a plain Error, not CraftdriverError', async () => {
      const err = await browser.screenshot({ fullPage: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(
        /^screenshot\(\{ fullPage: true \}\) requires BiDi \(enableBiDi: true\)\. /
      );
    });

    it('openPage() still throws a plain Error, not CraftdriverError', async () => {
      const err = await browser.openPage({ url: 'about:blank' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^openPage\(\) requires BiDi \(enableBiDi: true\)\. /);
    });

    it('addInitScript() still throws a plain Error, not CraftdriverError', async () => {
      const err = await browser.addInitScript(() => { /* no-op */ }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^addInitScript\(\) requires BiDi\. /);
    });

    it('waitForRequest() still throws a plain Error, not CraftdriverError', () => {
      let err: unknown;
      try {
        void browser.waitForRequest('**/x');
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
        void browser.on('request', () => { /* no-op */ });
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
        void browser.defaultContext;
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CraftdriverError);
      expect((err as Error).message).toMatch(/^defaultContext requires BiDi \(enableBiDi: true\)\. /);
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
    it('reports false for a real browser instance patched to look like Safari', () => {
      expect(asSafari(() => browser.isBiDiEnabled())).toBe(false);
    });

    it('structural invariant: bidiSession is undefined when BiDi was never enabled', () => {
      // Lighter unit-level check of the same fact isBiDiEnabled() reads from:
      // no bidiSession was ever created for this Browser instance, because it
      // was launched with enableBiDi: false — exactly what 1.1.3 forces for
      // every real Safari launch, regardless of what the caller asked for.
      const b = browser as unknown as { bidiSession: unknown };
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
    beforeAll(async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/dialogs.html`);
    });

    it('onDialog() throws UNSUPPORTED synchronously on Safari', () => {
      let err: unknown;
      try {
        asSafari(() =>
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
      const err = await asSafari(() =>
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
      const message = await asSafari(() => browser.getDialogMessage());
      expect(message).toBe('Hello from alert');
      await asSafari(() => browser.acceptDialog());
      await browser.expect('h1').toHaveText('Dialogs');
    });
  });
});
