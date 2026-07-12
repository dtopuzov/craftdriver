/**
 * Unit tests for the pure deep-link logic behind `browser.electron.triggerDeeplink()`:
 * URL validation, per-platform OS launcher selection, and the Windows/Linux
 * user-data routing. The OS spawn itself is exercised end-to-end against the
 * example app's protocol handler (see tests/electron/*, gated on a protocol-capable
 * fixture); here we lock down the deterministic routing decisions.
 */
import { describe, it, expect } from 'vitest';
import { CraftdriverError, ErrorCode } from '../src/lib/errors';
import {
  appendUserDataDir,
  getPlatformCommand,
  resolveDeeplinkUrl,
  validateDeeplinkUrl,
} from '../src/lib/electronDeeplink';

describe('validateDeeplinkUrl', () => {
  it('accepts custom-protocol URLs and returns them unchanged', () => {
    expect(validateDeeplinkUrl('myapp://open?file=test.txt')).toBe('myapp://open?file=test.txt');
    expect(validateDeeplinkUrl('craftdriver-example://ping')).toBe('craftdriver-example://ping');
  });

  it('rejects http/https/file protocols with INVALID_ARGUMENT', () => {
    for (const url of ['http://example.com', 'https://example.com', 'file:///etc/hosts']) {
      try {
        validateDeeplinkUrl(url);
        throw new Error(`expected ${url} to be rejected`);
      } catch (e) {
        expect(CraftdriverError.is(e, ErrorCode.INVALID_ARGUMENT)).toBe(true);
      }
    }
  });

  it('rejects unparseable URLs', () => {
    expect(() => validateDeeplinkUrl('not a url')).toThrow(CraftdriverError);
    try {
      validateDeeplinkUrl('not a url');
    } catch (e) {
      expect(CraftdriverError.is(e, ErrorCode.INVALID_ARGUMENT)).toBe(true);
    }
  });
});

describe('appendUserDataDir', () => {
  it('adds a userData query parameter', () => {
    expect(appendUserDataDir('myapp://open', '/tmp/ud')).toBe('myapp://open?userData=%2Ftmp%2Fud');
  });

  it('preserves existing query parameters', () => {
    const out = appendUserDataDir('myapp://open?file=a.txt', '/tmp/ud');
    const parsed = new URL(out);
    expect(parsed.searchParams.get('file')).toBe('a.txt');
    expect(parsed.searchParams.get('userData')).toBe('/tmp/ud');
  });

  it('overwrites a pre-existing userData parameter', () => {
    const out = appendUserDataDir('myapp://open?userData=/old', '/new');
    expect(new URL(out).searchParams.get('userData')).toBe('/new');
  });
});

describe('getPlatformCommand', () => {
  it('uses `open` on macOS and decodes the query once', () => {
    expect(getPlatformCommand('myapp://open?file=test.txt', 'darwin')).toEqual({
      command: 'open',
      args: ['myapp://open?file=test.txt'],
    });
    // A userData value that arrived percent-encoded is decoded once so `open`
    // re-encodes it exactly once on hand-off.
    expect(getPlatformCommand('myapp://open?userData=%2Ftmp%2Fud', 'darwin').args[0]).toBe(
      'myapp://open?userData=/tmp/ud'
    );
  });

  it('uses `gio open` on Linux', () => {
    expect(getPlatformCommand('myapp://open', 'linux')).toEqual({
      command: 'gio',
      args: ['open', 'myapp://open'],
    });
  });

  it('uses rundll32 on Windows and requires the app binary path', () => {
    expect(getPlatformCommand('myapp://open', 'win32', 'C:/app.exe')).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'myapp://open'],
    });
    try {
      getPlatformCommand('myapp://open', 'win32');
      throw new Error('expected a throw without appBinaryPath');
    } catch (e) {
      expect(CraftdriverError.is(e, ErrorCode.ELECTRON_DEEPLINK_FAILED)).toBe(true);
    }
  });

  it('rejects unsupported platforms', () => {
    try {
      getPlatformCommand('myapp://open', 'freebsd' as NodeJS.Platform);
      throw new Error('expected a throw');
    } catch (e) {
      expect(CraftdriverError.is(e, ErrorCode.ELECTRON_DEEPLINK_FAILED)).toBe(true);
    }
  });
});

describe('resolveDeeplinkUrl', () => {
  it('appends userData on Windows and Linux when provided', () => {
    expect(new URL(resolveDeeplinkUrl('myapp://x', 'win32', '/ud')).searchParams.get('userData')).toBe(
      '/ud'
    );
    expect(new URL(resolveDeeplinkUrl('myapp://x', 'linux', '/ud')).searchParams.get('userData')).toBe(
      '/ud'
    );
  });

  it('does not append userData on macOS (open-url reaches the running instance)', () => {
    expect(resolveDeeplinkUrl('myapp://x', 'darwin', '/ud')).toBe('myapp://x');
  });

  it('leaves the URL unchanged when no userData is known', () => {
    expect(resolveDeeplinkUrl('myapp://x', 'linux')).toBe('myapp://x');
  });

  it('still validates the protocol', () => {
    try {
      resolveDeeplinkUrl('https://x', 'darwin');
      throw new Error('expected a throw');
    } catch (e) {
      expect(CraftdriverError.is(e, ErrorCode.INVALID_ARGUMENT)).toBe(true);
    }
  });
});
