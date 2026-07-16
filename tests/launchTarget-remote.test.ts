/**
 * Unit tests for `remote`'s pre-launch validation in `resolveLaunchTarget()`
 * and the CLI/MCP-only `assertLocalOnlyLaunch()` guard. Pure function tests —
 * no driver process, no browser, no network — so these run in every lane
 * regardless of BROWSER_NAME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CraftdriverError, ErrorCode } from '../src/lib/errors';
import { resolveLaunchTarget, assertLocalOnlyLaunch, type RemoteLaunchTarget } from '../src/lib/launchTarget';

// See launchTarget-safari.test.ts for why this is needed: npm test always
// sets HEADLESS=true, and several assertions below assume it's unset.
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

const REMOTE_URL = 'https://hub.example.com/wd/hub';

describe('resolveLaunchTarget — remote', () => {
  it('accepts a minimal remote shape and defaults browserName to chrome', () => {
    const target = resolveLaunchTarget({ remote: { url: REMOTE_URL } }) as RemoteLaunchTarget;
    expect(target.kind).toBe('remote');
    expect(target.browserName).toBe('chrome');
    expect(target.bidiRequested).toBe(true);
  });

  it('does not restrict browserName to the local whitelist', () => {
    const target = resolveLaunchTarget({
      browserName: 'MicrosoftEdge',
      remote: { url: REMOTE_URL },
    }) as RemoteLaunchTarget;
    expect(target.browserName).toBe('MicrosoftEdge');
  });

  it('keeps the provider-facing name verbatim but derives a normalized engine family', () => {
    const cases: Array<[string, string]> = [
      ['Safari', 'safari'],
      ['Firefox', 'firefox'],
      ['Chrome', 'chrome'],
      ['MicrosoftEdge', 'chrome'],
      ['some-custom-browser', 'some-custom-browser'],
    ];
    for (const [provided, engine] of cases) {
      const target = resolveLaunchTarget({
        browserName: provided,
        remote: { url: REMOTE_URL },
      }) as RemoteLaunchTarget;
      // Provider-facing name is passed through untouched (case preserved)...
      expect(target.browserName).toBe(provided);
      // ...while internal engine checks get a normalized, case-insensitive family.
      expect(target.engine).toBe(engine);
    }
  });

  it('rejects a non-string browserName rather than silently defaulting it to chrome', () => {
    expect(() =>
      resolveLaunchTarget({ browserName: 42 as any, remote: { url: REMOTE_URL } })
    ).toThrow(/browserName must be a non-empty string/);
    expect(() =>
      resolveLaunchTarget({ remote: { url: REMOTE_URL, capabilities: { browserName: 42 } } })
    ).toThrow(/remote\.capabilities\.browserName must be a non-empty string/);
  });

  it('rejects a whitespace-only browserName', () => {
    expect(() =>
      resolveLaunchTarget({ browserName: '   ', remote: { url: REMOTE_URL } })
    ).toThrow(/browserName must be a non-empty string/);
  });

  it('HEADLESS=true does not affect a remote unknown-browser or Safari launch', () => {
    process.env.HEADLESS = 'true';
    expect(() =>
      resolveLaunchTarget({ browserName: 'some-custom-browser', remote: { url: REMOTE_URL } })
    ).not.toThrow();
    expect(() =>
      resolveLaunchTarget({ browserName: 'safari', remote: { url: REMOTE_URL } })
    ).not.toThrow();
  });

  it('defaults BiDi on for chrome/chromium/firefox/edge, off for safari and unrecognized names', () => {
    for (const name of ['chrome', 'chromium', 'firefox', 'edge', 'microsoftedge']) {
      const target = resolveLaunchTarget({
        browserName: name,
        remote: { url: REMOTE_URL },
      }) as RemoteLaunchTarget;
      expect(target.bidiRequested).toBe(true);
    }
    for (const name of ['safari', 'some-unknown-browser']) {
      const target = resolveLaunchTarget({
        browserName: name,
        remote: { url: REMOTE_URL },
      }) as RemoteLaunchTarget;
      expect(target.bidiRequested).toBe(false);
    }
  });

  it('honors an explicit enableBiDi: true for an unrecognized remote browser name', () => {
    const target = resolveLaunchTarget({
      browserName: 'some-unknown-browser',
      enableBiDi: true,
      remote: { url: REMOTE_URL },
    }) as RemoteLaunchTarget;
    expect(target.bidiRequested).toBe(true);
  });

  it('respects enableBiDi: false for a normally-BiDi-default browser', () => {
    const target = resolveLaunchTarget({
      browserName: 'chrome',
      enableBiDi: false,
      remote: { url: REMOTE_URL },
    }) as RemoteLaunchTarget;
    expect(target.bidiRequested).toBe(false);
  });

  it('rejects webSocketUrl: false while BiDi stays enabled (transport/feature contradiction)', () => {
    try {
      resolveLaunchTarget({
        browserName: 'chrome',
        remote: { url: REMOTE_URL, capabilities: { webSocketUrl: false } },
      });
      throw new Error('expected resolveLaunchTarget to throw');
    } catch (err) {
      expect(CraftdriverError.is(err, ErrorCode.INVALID_ARGUMENT)).toBe(true);
      expect((err as Error).message).toMatch(/webSocketUrl/);
    }
  });

  it('allows webSocketUrl: false when BiDi is off (enableBiDi: false or Safari)', () => {
    expect(() =>
      resolveLaunchTarget({
        browserName: 'chrome',
        enableBiDi: false,
        remote: { url: REMOTE_URL, capabilities: { webSocketUrl: false } },
      })
    ).not.toThrow();
    expect(() =>
      resolveLaunchTarget({
        browserName: 'safari',
        remote: { url: REMOTE_URL, capabilities: { webSocketUrl: false } },
      })
    ).not.toThrow();
  });

  it('is case-insensitive when comparing top-level browserName against remote.capabilities.browserName', () => {
    expect(() =>
      resolveLaunchTarget({
        browserName: 'Chrome',
        remote: { url: REMOTE_URL, capabilities: { browserName: 'chrome' } },
      })
    ).not.toThrow();
  });

  it('rejects a genuine conflict between browserName and remote.capabilities.browserName', () => {
    expect(() =>
      resolveLaunchTarget({
        browserName: 'chrome',
        remote: { url: REMOTE_URL, capabilities: { browserName: 'firefox' } },
      })
    ).toThrow(/conflicts/);
  });

  it('rejects remote combined with electron', () => {
    expect(() =>
      resolveLaunchTarget({
        remote: { url: REMOTE_URL },
        electron: { appBinaryPath: '/tmp/app' },
      })
    ).toThrow(/remote cannot be combined with electron/);
  });

  it.each([
    ['electronService', { electronService: {} }],
    ['chromeService', { chromeService: {} }],
    ['firefoxService', { firefoxService: {} }],
    ['safariService', { safariService: {} }],
    ['mobileEmulation', { mobileEmulation: 'Pixel 7' }],
    ['args', { args: ['--foo'] }],
    ['browserPath', { browserPath: '/opt/chrome' }],
    ['downloadsDir', { downloadsDir: '/tmp/downloads' }],
  ] as const)('rejects remote combined with %s', (feature, extra) => {
    expect(() => resolveLaunchTarget({ remote: { url: REMOTE_URL }, ...extra })).toThrow(
      new RegExp(`remote cannot be combined with ${feature}`)
    );
  });

  it('rejects a missing/empty remote.url before any other validation', () => {
    expect(() => resolveLaunchTarget({ remote: {} })).toThrow(/remote\.url/);
    expect(() => resolveLaunchTarget({ remote: { url: '' } })).toThrow(/remote\.url/);
  });

  it('rejects a non-object remote value', () => {
    expect(() => resolveLaunchTarget({ remote: 'https://hub.example.com' })).toThrow();
  });
});

describe('assertLocalOnlyLaunch — CLI/MCP boundary', () => {
  it('throws CraftdriverError/UNSUPPORTED when remote is set', () => {
    let thrown: unknown;
    try {
      assertLocalOnlyLaunch({ remote: { url: REMOTE_URL } });
    } catch (err) {
      thrown = err;
    }
    expect(CraftdriverError.is(thrown, ErrorCode.UNSUPPORTED)).toBe(true);
    expect((thrown as CraftdriverError).detail).toMatchObject({ feature: 'remote' });
  });

  it('does not throw for local or electron launch shapes', () => {
    expect(() => assertLocalOnlyLaunch({})).not.toThrow();
    expect(() => assertLocalOnlyLaunch({ browserName: 'chrome' })).not.toThrow();
    expect(() =>
      assertLocalOnlyLaunch({ electron: { appBinaryPath: '/tmp/app' } })
    ).not.toThrow();
  });
});
