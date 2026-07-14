/**
 * Unit tests for Safari's no-download driver resolution (`resolveSafariDriver`)
 * and `SafariService`'s platform guard.
 *
 * Unlike Chrome/Firefox, Safari's driver ships with macOS/Safari and is never
 * downloaded, so resolution can only *locate* an installed binary or fail with
 * a clear, actionable error. These are pure-logic tests: the filesystem is
 * stubbed (`fs.existsSync`) and the PATH probe is stubbed (`child_process`
 * `spawnSync`), so they run deterministically in every lane on any platform,
 * with no real safaridriver, Safari, or macOS required.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CraftdriverError, ErrorCode } from '../src/lib/errors';

// Control the PATH probe (`which`/`where safaridriver`) deterministically.
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import { resolveSafariDriver } from '../src/lib/driverManager';
import {
  SafariService,
  isRemoteAutomationDisabledError,
  isSecondSessionRefusedError,
  augmentSafariSessionError,
} from '../src/lib/safari';
import { Builder } from '../src/lib/builder';

const SYSTEM_PATH = '/usr/bin/safaridriver';

/** Stub fs.existsSync so only the given set of paths "exists". */
function existingPaths(paths: string[]): void {
  const set = new Set(paths);
  vi.spyOn(fs, 'existsSync').mockImplementation((p) => set.has(String(p)));
}

/** Remove keys from process.env, returning a restore function. */
function unsetEnvVars(keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

describe('resolveSafariDriver — no-download resolution chain', () => {
  let restoreEnv = () => {};

  beforeEach(() => {
    restoreEnv = unsetEnvVars([
      'CRAFTDRIVER_SAFARIDRIVER_PATH',
      'CRAFTDRIVER_DRIVER_PATH',
      'CRAFTDRIVER_SKIP_PATH_PROBE',
    ]);
    // Default: nothing on PATH. Individual tests override for the PATH-probe case.
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });
    // Default: skip the PATH probe so only the explicit steps are exercised.
    // (The dedicated PATH-probe test clears this.)
    process.env.CRAFTDRIVER_SKIP_PATH_PROBE = '1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
    restoreEnv();
  });

  it('prefers an explicit binaryPath that exists over every other source', async () => {
    const explicit = '/opt/stp/safaridriver';
    // Everything else also "exists" — explicit must still win.
    existingPaths([explicit, SYSTEM_PATH, '/env/safaridriver']);
    process.env.CRAFTDRIVER_SAFARIDRIVER_PATH = '/env/safaridriver';

    await expect(resolveSafariDriver({ binaryPath: explicit })).resolves.toBe(explicit);
  });

  it('falls through a missing binaryPath to the next step', async () => {
    existingPaths([SYSTEM_PATH]);
    await expect(resolveSafariDriver({ binaryPath: '/nope/safaridriver' })).resolves.toBe(
      SYSTEM_PATH
    );
  });

  it('uses CRAFTDRIVER_SAFARIDRIVER_PATH when set and no binaryPath is given', async () => {
    const envPath = '/custom/safaridriver';
    existingPaths([envPath, SYSTEM_PATH]);
    process.env.CRAFTDRIVER_SAFARIDRIVER_PATH = envPath;

    await expect(resolveSafariDriver()).resolves.toBe(envPath);
  });

  it('uses the generic CRAFTDRIVER_DRIVER_PATH as a fallback env var', async () => {
    const envPath = '/generic/safaridriver';
    existingPaths([envPath, SYSTEM_PATH]);
    process.env.CRAFTDRIVER_DRIVER_PATH = envPath;

    await expect(resolveSafariDriver()).resolves.toBe(envPath);
  });

  it('prefers CRAFTDRIVER_SAFARIDRIVER_PATH over CRAFTDRIVER_DRIVER_PATH', async () => {
    existingPaths(['/specific/safaridriver', '/generic/safaridriver', SYSTEM_PATH]);
    process.env.CRAFTDRIVER_SAFARIDRIVER_PATH = '/specific/safaridriver';
    process.env.CRAFTDRIVER_DRIVER_PATH = '/generic/safaridriver';

    await expect(resolveSafariDriver()).resolves.toBe('/specific/safaridriver');
  });

  it('resolves /usr/bin/safaridriver when present and nothing more specific is set', async () => {
    existingPaths([SYSTEM_PATH]);
    await expect(resolveSafariDriver()).resolves.toBe(SYSTEM_PATH);
  });

  it('probes PATH when earlier steps miss and the probe is not skipped', async () => {
    existingPaths([]); // nothing on disk, not even /usr/bin/safaridriver
    delete process.env.CRAFTDRIVER_SKIP_PATH_PROBE;
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '/somewhere/safaridriver\n' });

    await expect(resolveSafariDriver()).resolves.toBe('safaridriver');
  });

  it('does not probe PATH when CRAFTDRIVER_SKIP_PATH_PROBE is set', async () => {
    existingPaths([]);
    // SKIP is set by beforeEach; a "found on PATH" result must be ignored.
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '/somewhere/safaridriver\n' });

    await expect(resolveSafariDriver()).rejects.toThrow(/Could not find 'safaridriver'/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('throws a clear, actionable error when nothing resolves (never downloads)', async () => {
    existingPaths([]);
    delete process.env.CRAFTDRIVER_SKIP_PATH_PROBE;
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });

    let thrown: unknown;
    try {
      await resolveSafariDriver();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // Explains that it ships with the OS, points at the expected location, and
    // mentions the enable step — without claiming craftdriver runs it.
    expect(message).toContain("Could not find 'safaridriver'");
    expect(message).toContain(SYSTEM_PATH);
    expect(message).toMatch(/safaridriver --enable|Allow Remote Automation/);
    expect(message).toContain('does not run this for you');
    // States plainly that the driver is not downloaded (no fetch fallback).
    expect(message).toContain('not downloaded');
  });
});

describe('SafariService — platform guard', () => {
  const originalPlatform = process.platform;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.restoreAllMocks();
  });

  it('throws CraftdriverError/UNSUPPORTED immediately on a non-darwin platform, before any fs access', () => {
    setPlatform('linux');
    // If the guard ran before the filesystem, existsSync is never consulted.
    const existsSpy = vi.spyOn(fs, 'existsSync');

    let thrown: unknown;
    try {
      // eslint-disable-next-line no-new
      new SafariService();
    } catch (err) {
      thrown = err;
    }

    expect(CraftdriverError.is(thrown, ErrorCode.UNSUPPORTED)).toBe(true);
    expect((thrown as CraftdriverError).detail).toMatchObject({
      browserName: 'safari',
      platform: 'linux',
    });
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it('constructs on darwin without throwing', () => {
    setPlatform('darwin');
    expect(() => new SafariService()).not.toThrow();
  });
});

describe('SafariService — buildCommandArgs()', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('produces space-separated "--port N" (not chromedriver/geckodriver-style "--port=N")', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const service = new SafariService() as unknown as {
      buildCommandArgs(port: number): string[];
    };
    expect(service.buildCommandArgs(4444)).toEqual(['--port', '4444']);
  });

  it('appends extra args (e.g. --diagnose) after the port flag, untouched', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const service = new SafariService({ args: ['--diagnose'] }) as unknown as {
      buildCommandArgs(port: number): string[];
    };
    expect(service.buildCommandArgs(4444)).toEqual(['--port', '4444', '--diagnose']);
  });
});

describe('isRemoteAutomationDisabledError / augmentSafariSessionError', () => {
  const positiveSamples = [
    'Could not create automation session: Remote Automation is not enabled.',
    'Enable Remote Automation in the Develop menu to allow testing.',
    'To enable automation, run safaridriver --enable and restart Safari.',
    'REMOTE AUTOMATION is disabled for this user.',
  ];

  const negativeSamples = [
    'connect ECONNREFUSED 127.0.0.1:4444',
    'invalid session id',
    'Failed to create session: unknown error: element not interactable',
    'Driver process exited before it was ready (code 1).',
  ];

  it.each(positiveSamples)('detects a realistic enable-automation error: %s', (message) => {
    expect(isRemoteAutomationDisabledError(message)).toBe(true);
  });

  it.each(negativeSamples)('does not false-positive on unrelated errors: %s', (message) => {
    expect(isRemoteAutomationDisabledError(message)).toBe(false);
  });

  it('augments a matching error with the enable remedy, preserving the original as cause', () => {
    const original = new Error(
      'Failed to create session: Remote Automation is not enabled in Safari.'
    );
    const augmented = augmentSafariSessionError(original);

    expect(augmented).not.toBe(original);
    expect(augmented.message).toContain('Remote Automation is not enabled in Safari.');
    expect(augmented.message).toMatch(/safaridriver --enable/);
    expect(augmented.message).toMatch(/Allow Remote Automation/);
    expect(augmented.message).toContain('does not run this for you');
    expect(augmented.cause).toBe(original);
  });

  it('passes through a non-matching error unchanged', () => {
    const original = new Error('invalid session id');
    expect(augmentSafariSessionError(original)).toBe(original);
  });

  it('wraps a non-Error thrown value without matching', () => {
    const augmented = augmentSafariSessionError('connection refused');
    expect(augmented).toBeInstanceOf(Error);
    expect(augmented.message).toBe('connection refused');
  });
});

/**
 * Safari's second-session refusal (a distinct `safaridriver`
 * session-creation failure from the "Allow Remote Automation" one above) must
 * surface as-is, augmented with a serialize-your-tests hint — never as a raw
 * timeout, and never papered over with an in-process queue/retry.
 */
describe('isSecondSessionRefusedError / augmentSafariSessionError (second session)', () => {
  const positiveSamples = [
    'SessionNotCreatedError: Could not create a new session. A session is already active.',
    'session not created: Unable to create a new remote session because one is already in progress.',
    'Failed to create session: There is already an active session for this browser.',
    'session not created: only one Safari WebDriver session may be active at a time.',
    'Could not start new session: another session is currently running.',
  ];

  const negativeSamples = [
    // Genuine "session not created" failures unrelated to a second session
    // (e.g. a real crash-at-launch) must not be mistaken for this case.
    'session not created: unable to create a new session because Safari crashed on launch',
    'session not created: chrome not reachable',
    // A raw timeout / driver-not-ready failure must never be falsely augmented.
    'Driver service not ready: timed out waiting for /status after 30000ms.',
    // The other Safari-specific failure mode must not cross-match this one.
    'Could not create automation session: Remote Automation is not enabled.',
    'connect ECONNREFUSED 127.0.0.1:4444',
  ];

  it.each(positiveSamples)('detects a realistic second-session refusal: %s', (message) => {
    expect(isSecondSessionRefusedError(message)).toBe(true);
  });

  it.each(negativeSamples)('does not false-positive on unrelated errors: %s', (message) => {
    expect(isSecondSessionRefusedError(message)).toBe(false);
  });

  it('augments a matching error with the serialization hint, preserving the original as cause', () => {
    const original = new Error(
      'session not created: Unable to create a new remote session because one is already in progress.'
    );
    const augmented = augmentSafariSessionError(original);

    expect(augmented).not.toBe(original);
    expect(augmented).toBeInstanceOf(Error);
    expect(augmented.message).toContain(
      'Unable to create a new remote session because one is already in progress.'
    );
    expect(augmented.message).toMatch(/only one Safari WebDriver session/i);
    expect(augmented.message).toMatch(/serially/i);
    expect(augmented.message).toMatch(/separate macOS hosts/i);
    expect(augmented.message).toMatch(/Safari Technology Preview/i);
    expect(augmented.cause).toBe(original);
  });

  it('surfaces clearly rather than as a raw/opaque timeout', () => {
    const original = new Error(
      'session not created: There is already an active session for this browser.'
    );
    const augmented = augmentSafariSessionError(original);

    // The augmented message must read as an explained, actionable Safari
    // constraint, not a bare "timed out" with no context.
    expect(augmented.message).not.toMatch(/^timed out/i);
    expect(augmented.message.length).toBeGreaterThan(original.message.length);
    expect(augmented.message).toMatch(/not a craftdriver limitation/i);
  });

  it('does not augment an unrelated raw timeout error (no false serialization hint)', () => {
    const original = new Error('Driver service not ready: timed out waiting for /status after 30000ms.');
    const augmented = augmentSafariSessionError(original);
    expect(augmented).toBe(original);
    expect(augmented.message).not.toMatch(/only one Safari WebDriver session/i);
  });
});

/**
 * Confirm Safari Technology Preview needs no new code branch — it works
 * purely because `binaryPath` is checked first in the resolution chain and is
 * treated as an opaque filesystem path.
 */
const STP_PATH = '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver';
const stpInstalled = fs.existsSync(STP_PATH);

describe.skipIf(!stpInstalled)('Safari Technology Preview lane (requires STP installed)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolveSafariDriver resolves the STP binaryPath with zero special-casing', async () => {
    await expect(resolveSafariDriver({ binaryPath: STP_PATH })).resolves.toBe(STP_PATH);
  });

  it('constructs a SafariService pointed at STP without throwing', () => {
    expect(() => new SafariService({ binaryPath: STP_PATH })).not.toThrow();
  });
});

describe('Builder — Safari wiring', () => {
  const originalPlatform = process.platform;
  let restoreEnv = () => {};

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    restoreEnv = unsetEnvVars([
      'CRAFTDRIVER_SAFARIDRIVER_PATH',
      'CRAFTDRIVER_DRIVER_PATH',
      'CRAFTDRIVER_SKIP_PATH_PROBE',
    ]);
    process.env.CRAFTDRIVER_SKIP_PATH_PROBE = '1';
    existingPaths([]); // no safaridriver anywhere on this sandbox
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
    restoreEnv();
  });

  it('reaches SafariService.start() and fails with a driver-resolution error, not the old placeholder', async () => {
    // Previously, Builder.build() threw a hardcoded
    // "Safari support is not implemented yet." for browserName: 'safari'. Now
    // it constructs a real SafariService and attempts to resolve/start
    // safaridriver — proving the placeholder is gone and the wiring is real,
    // even though this sandbox has no safaridriver to actually launch.
    let thrown: unknown;
    try {
      await new Builder().forBrowser('safari').build();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toMatch(/not implemented yet/i);
    expect(message).toContain("Could not find 'safaridriver'");
  });

  it('uses a caller-supplied SafariService via setSafariService()', async () => {
    const service = new SafariService();
    const startSpy = vi.spyOn(service, 'start').mockRejectedValue(new Error('boom'));
    await expect(
      new Builder().forBrowser('safari').setSafariService(service).build(),
    ).rejects.toThrow('boom');
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

describe('binaryPath resolution has no "must be named safaridriver" assumption', () => {
  const tmpFiles: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    for (const f of tmpFiles) {
      fs.rmSync(f, { force: true });
    }
  });

  it('resolves an arbitrary, oddly-named existing file passed as binaryPath', async () => {
    const tmpPath = path.join(os.tmpdir(), `not-named-safaridriver-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmpPath, '');
    tmpFiles.push(tmpPath);

    await expect(resolveSafariDriver({ binaryPath: tmpPath })).resolves.toBe(tmpPath);
  });
});
