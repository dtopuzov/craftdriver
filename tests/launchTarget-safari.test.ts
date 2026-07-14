/**
 * Unit tests for Safari's pre-launch validation in `resolveLaunchTarget()`.
 * Pure function tests — no driver process, no browser — so these run in
 * every lane regardless of BROWSER_NAME. Safari-incompatible launch options
 * must be rejected with `CraftdriverError`/`UNSUPPORTED` before any service
 * starts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CraftdriverError, ErrorCode } from '../src/lib/errors';
import { resolveLaunchTarget } from '../src/lib/launchTarget';

// File- and test-scoped so every test below is isolated from an ambient
// HEADLESS — including the one `npm test` itself always sets
// (`"test": "HEADLESS=true vitest run"` in package.json). Most tests here
// don't mention HEADLESS at all and implicitly assume it's unset (e.g. the
// enableBiDi tests below); without clearing it before each test, running
// this suite via the ordinary `npm test` made those tests fail on
// `feature: 'HEADLESS'` instead of their own assertion. Tests that need
// HEADLESS set still do so explicitly in their own body.
const originalHeadless = process.env.HEADLESS;
beforeEach(() => {
  delete process.env.HEADLESS;
});
afterEach(() => {
  if (originalHeadless === undefined) {
    delete process.env.HEADLESS;
  } else {
    process.env.HEADLESS = originalHeadless;
  }
});

describe('resolveLaunchTarget — Safari-incompatible launch options', () => {
  it.each([
    ['true'],
    ['1'],
  ] as const)('rejects HEADLESS=%s for browserName: safari', (value) => {
    process.env.HEADLESS = value;
    expect(() => resolveLaunchTarget({ browserName: 'safari' })).toThrow(CraftdriverError);
    try {
      resolveLaunchTarget({ browserName: 'safari' });
      throw new Error('expected resolveLaunchTarget to throw');
    } catch (err) {
      expect(CraftdriverError.is(err, ErrorCode.UNSUPPORTED)).toBe(true);
      expect((err as CraftdriverError).detail).toMatchObject({
        browserName: 'safari',
        feature: 'HEADLESS',
      });
    }
  });

  it.each([
    ['args', { args: ['--foo'] }],
    ['browserPath', { browserPath: '/Applications/Safari.app' }],
    ['mobileEmulation', { mobileEmulation: 'Pixel 7' }],
    ['downloadsDir', { downloadsDir: '/tmp/downloads' }],
  ] as const)('rejects %s for browserName: safari', (feature, extra) => {
    delete process.env.HEADLESS;
    let thrown: unknown;
    try {
      resolveLaunchTarget({ browserName: 'safari', ...extra });
    } catch (err) {
      thrown = err;
    }
    expect(CraftdriverError.is(thrown, ErrorCode.UNSUPPORTED)).toBe(true);
    expect((thrown as CraftdriverError).detail).toMatchObject({
      browserName: 'safari',
      feature,
    });
  });

  it('accepts each option for chrome and firefox', () => {
    delete process.env.HEADLESS;
    for (const browserName of ['chrome', 'firefox'] as const) {
      expect(() => resolveLaunchTarget({ browserName, args: ['--foo'] })).not.toThrow();
      expect(() => resolveLaunchTarget({ browserName, browserPath: '/opt/browser' })).not.toThrow();
      expect(() => resolveLaunchTarget({ browserName, downloadsDir: '/tmp/downloads' })).not.toThrow();
    }
    // mobileEmulation is Chrome/Chromium-only at the Browser.launch() level
    // (browser.ts throws a plain Error for Firefox); resolveLaunchTarget
    // itself doesn't gate browser-family compatibility for it, only Safari.
    expect(() => resolveLaunchTarget({ browserName: 'chrome', mobileEmulation: 'Pixel 7' }))
      .not.toThrow();
  });

  it.each(['true', '1'] as const)(
    'accepts HEADLESS=%s for chrome and firefox',
    (value) => {
      process.env.HEADLESS = value;
      expect(() => resolveLaunchTarget({ browserName: 'chrome' })).not.toThrow();
      expect(() => resolveLaunchTarget({ browserName: 'firefox' })).not.toThrow();
    },
  );

  it('does not reject Safari when none of the incompatible options are present', () => {
    delete process.env.HEADLESS;
    expect(resolveLaunchTarget({ browserName: 'safari' })).toMatchObject({
      kind: 'browser',
      browserName: 'safari',
    });
  });
});

describe('resolveLaunchTarget — enableBiDi defaulting for Safari', () => {
  it('defaults bidiRequested to false for Safari when enableBiDi is omitted', () => {
    expect(resolveLaunchTarget({ browserName: 'safari' })).toMatchObject({
      bidiRequested: false,
    });
  });

  it('accepts explicit enableBiDi: false for Safari (no-op)', () => {
    expect(resolveLaunchTarget({ browserName: 'safari', enableBiDi: false })).toMatchObject({
      bidiRequested: false,
    });
  });

  it('rejects explicit enableBiDi: true for Safari', () => {
    let thrown: unknown;
    try {
      resolveLaunchTarget({ browserName: 'safari', enableBiDi: true });
    } catch (err) {
      thrown = err;
    }
    expect(CraftdriverError.is(thrown, ErrorCode.UNSUPPORTED)).toBe(true);
    expect((thrown as CraftdriverError).detail).toMatchObject({
      browserName: 'safari',
      feature: 'WebDriver BiDi',
    });
  });

  it.each(['chrome', 'firefox'] as const)(
    'defaults bidiRequested to true for %s',
    (browserName) => {
      expect(resolveLaunchTarget({ browserName })).toMatchObject({ bidiRequested: true });
    },
  );

  it.each(['chrome', 'firefox'] as const)(
    'accepts explicit enableBiDi: true and false for %s',
    (browserName) => {
      expect(resolveLaunchTarget({ browserName, enableBiDi: true }))
        .toMatchObject({ bidiRequested: true });
      expect(resolveLaunchTarget({ browserName, enableBiDi: false }))
        .toMatchObject({ bidiRequested: false });
    },
  );
});
