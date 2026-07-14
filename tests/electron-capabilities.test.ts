/**
 * Unit tests for the Electron launch surface — pure capability building and
 * Electron driver resolution. No Electron app, no chromedriver, no network:
 * these assert the W3C caps and the resolution chain in isolation so failures
 * localize (the real end-to-end drive lives in the integration suite).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildLaunchCapabilities } from '../src/lib/capabilities';
import {
  detectElectronVersion,
  detectElectronVersionFromApp,
  readChromeDriverVersion,
  resolveElectronChromeDriver,
  resolveElectronChromeDriverInfo,
} from '../src/lib/driverManager';
import { chromiumMajorForElectron, knownElectronMajors } from '../src/lib/electronVersions';
import { resolveLaunchTarget } from '../src/lib/launchTarget';
import { Browser, ChromeService, ElectronService, FirefoxService } from '../src';

const APP = '/opt/MyApp.app/Contents/MacOS/MyApp';

describe('resolveLaunchTarget — public launch policy', () => {
  it('keeps browsers BiDi-first', () => {
    expect(resolveLaunchTarget({})).toMatchObject({
      kind: 'browser', browserName: 'chrome', bidiRequested: true,
    });
    expect(resolveLaunchTarget({ enableBiDi: false })).toMatchObject({
      kind: 'browser', bidiRequested: false,
    });
  });

  it('defaults Electron to Classic and supports explicit BiDi opt-in', () => {
    expect(resolveLaunchTarget({ electron: { appBinaryPath: APP } })).toMatchObject({
      kind: 'electron', browserName: 'chrome', bidiRequested: false, appBinaryPath: APP,
    });
    expect(resolveLaunchTarget({
      electron: { appBinaryPath: APP }, enableBiDi: true,
    })).toMatchObject({ kind: 'electron', bidiRequested: true });
  });

  it('carries an explicit electron.version onto the target', () => {
    expect(resolveLaunchTarget({ electron: { appBinaryPath: APP, version: '37.2.0' } }))
      .toMatchObject({ kind: 'electron', appBinaryPath: APP, version: '37.2.0' });
    // Absent by default.
    expect(resolveLaunchTarget({ electron: { appBinaryPath: APP } }).version).toBeUndefined();
  });

  it('defaults mainProcess to false and carries an explicit opt-in', () => {
    expect(resolveLaunchTarget({ electron: { appBinaryPath: APP } }))
      .toMatchObject({ kind: 'electron', mainProcess: false });
    expect(resolveLaunchTarget({ electron: { appBinaryPath: APP, mainProcess: true } }))
      .toMatchObject({ kind: 'electron', mainProcess: true });
  });

  it.each([
    [{ electron: null }, /electron must be an object/],
    [{ electron: {} }, /appBinaryPath is required/],
    [{ electron: { appBinaryPath: '' } }, /appBinaryPath must be a non-empty string/],
    [{ electron: { appBinaryPath: APP, appBinarPath: APP } }, /Unsupported electron option/],
    [{ electron: { appBinaryPath: APP, mobileEmulation: 'Pixel 7' } }, /Unsupported electron option/],
    [{ electron: { appBinaryPath: APP, args: '--foo' } }, /electron.args must be an array/],
    [{ electron: { appBinaryPath: APP, version: '' } }, /electron.version must be a non-empty string/],
    [{ electron: { appBinaryPath: APP, version: '37.0.0', chromedriverPath: '/d' } },
      /electron.version cannot be combined with electron.chromedriverPath/],
    [{ electron: { appBinaryPath: APP, version: '37.0.0' }, electronService: new ElectronService() },
      /electron.version cannot be combined with electronService/],
    [{ electron: { appBinaryPath: APP, mainProcess: 'yes' } }, /electron.mainProcess must be a boolean/],
    [{ electron: { appBinaryPath: APP }, browserName: 'chrome' }, /browserName/],
    [{ electron: { appBinaryPath: APP }, args: ['--foo'] }, /electron.args/],
    [{ electron: { appBinaryPath: APP }, browserPath: APP }, /browserPath/],
    [{ electron: { appBinaryPath: APP }, mobileEmulation: 'Pixel 7' }, /mobileEmulation/],
    [{ electron: { appBinaryPath: APP }, chromeService: new ChromeService() }, /chromeService/],
    [{ electron: { appBinaryPath: APP }, firefoxService: new FirefoxService() }, /firefoxService/],
    [{ electronService: new ElectronService() }, /requires the electron launch option/],
    [{
      electron: { appBinaryPath: APP, chromedriverPath: '/driver' },
      electronService: new ElectronService(),
    }, /cannot be combined with electronService/],
  ] as const)('rejects malformed or mixed launch options %#', (options, expected) => {
    expect(() => resolveLaunchTarget(options as unknown as Record<string, unknown>)).toThrow(expected);
  });

  it('rejects a missing executable before starting a driver', async () => {
    await expect(Browser.launch({
      electron: { appBinaryPath: path.join(os.tmpdir(), 'craftdriver-no-such-electron-app') },
    })).rejects.toThrow(/appBinaryPath.*does not exist/);
  });

  it('rejects a directory and an invalid service before starting a driver', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-launch-validation-'));
    const app = path.join(tmp, process.platform === 'win32' ? 'app.exe' : 'app');
    fs.writeFileSync(app, '');
    if (process.platform !== 'win32') fs.chmodSync(app, 0o755);
    try {
      await expect(Browser.launch({
        electron: { appBinaryPath: tmp },
      })).rejects.toThrow(/appBinaryPath.*is not a file/);
      await expect(Browser.launch({
        electron: { appBinaryPath: app },
        electronService: {} as ElectronService,
      })).rejects.toThrow(/must be an ElectronService instance/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a non-executable app file before starting a driver',
    async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-launch-permissions-'));
      const app = path.join(tmp, 'app');
      fs.writeFileSync(app, '');
      fs.chmodSync(app, 0o644);
      try {
        await expect(Browser.launch({ electron: { appBinaryPath: app } }))
          .rejects.toThrow(/appBinaryPath.*is not executable/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

function chromeOpts(caps: Record<string, unknown>): Record<string, unknown> {
  return caps['goog:chromeOptions'] as Record<string, unknown>;
}

describe('buildLaunchCapabilities — Electron', () => {
  it('sets goog:chromeOptions.binary to the app executable', () => {
    const caps = buildLaunchCapabilities({
      browserName: 'chrome', isElectron: true, isHeadless: false,
      bidiRequested: false, browserBinary: APP, downloadsDir: '/tmp/dl',
    });
    expect(chromeOpts(caps).binary).toBe(APP);
  });

  it('defaults to Classic — no webSocketUrl when BiDi not requested', () => {
    const caps = buildLaunchCapabilities({
      browserName: 'chrome', isElectron: true, isHeadless: false,
      bidiRequested: false, browserBinary: APP, downloadsDir: '/tmp/dl',
    });
    expect(caps.webSocketUrl).toBeUndefined();
    expect(caps.unhandledPromptBehavior).toBeUndefined();
  });

  it('requests BiDi when opted in', () => {
    const caps = buildLaunchCapabilities({
      browserName: 'chrome', isElectron: true, isHeadless: false,
      bidiRequested: true, browserBinary: APP, downloadsDir: '/tmp/dl',
    });
    expect(caps.webSocketUrl).toBe(true);
    expect(caps.unhandledPromptBehavior).toBeDefined();
  });

  it('never injects --headless for Electron, even when HEADLESS is on', () => {
    const caps = buildLaunchCapabilities({
      browserName: 'chrome', isElectron: true, isHeadless: true, // HEADLESS=true
      bidiRequested: false, browserBinary: APP, downloadsDir: '/tmp/dl',
      args: ['--foo'],
    });
    expect(chromeOpts(caps).args).toEqual(['--foo']); // no --headless=new
  });

  it('forwards extra args to goog:chromeOptions.args', () => {
    const caps = buildLaunchCapabilities({
      browserName: 'chrome', isElectron: true, isHeadless: false,
      bidiRequested: false, browserBinary: APP, downloadsDir: '/tmp/dl',
      args: ['--enable-logging', '--v=1'],
    });
    expect(chromeOpts(caps).args).toEqual(['--enable-logging', '--v=1']);
  });

  it('never emits mobileEmulation for Electron', () => {
    const caps = buildLaunchCapabilities({
      browserName: 'chrome', isElectron: true, isHeadless: false,
      bidiRequested: false, browserBinary: APP, downloadsDir: '/tmp/dl',
    });
    expect(chromeOpts(caps).mobileEmulation).toBeUndefined();
  });
});

describe('buildLaunchCapabilities — browser regression (unchanged behavior)', () => {
  it('chrome still injects --headless=new when headless', () => {
    const caps = buildLaunchCapabilities({
      browserName: 'chrome', isHeadless: true, bidiRequested: true,
      downloadsDir: '/tmp/dl',
    });
    expect(chromeOpts(caps).args).toEqual(['--headless=new']);
    expect(caps.webSocketUrl).toBe(true);
  });

  it('firefox builds moz:firefoxOptions with -headless and download prefs', () => {
    const caps = buildLaunchCapabilities({
      browserName: 'firefox', isHeadless: true, bidiRequested: false,
      downloadsDir: '/tmp/dl',
    });
    const moz = caps['moz:firefoxOptions'] as Record<string, unknown>;
    expect((moz.args as string[])).toContain('-headless');
    expect((moz.prefs as Record<string, unknown>)['browser.download.dir']).toBe('/tmp/dl');
    expect(caps['goog:chromeOptions']).toBeUndefined();
  });
});

describe('buildLaunchCapabilities — Safari (no vendor capabilities)', () => {
  it('emits only browserName-level input, no goog:chromeOptions/moz:firefoxOptions/webSocketUrl', () => {
    const caps = buildLaunchCapabilities({
      browserName: 'safari', isHeadless: false, bidiRequested: false,
      downloadsDir: '/tmp/dl',
    });
    expect(caps['goog:chromeOptions']).toBeUndefined();
    expect(caps['moz:firefoxOptions']).toBeUndefined();
    expect(caps.webSocketUrl).toBeUndefined();
    expect(caps.unhandledPromptBehavior).toBeUndefined();
    expect(caps).toEqual({});
  });

  it('never emits webSocketUrl for Safari even if bidiRequested were miscomputed true', () => {
    // Defense in depth: resolveLaunchTarget()/Browser.launch already guarantee
    // bidiRequested is false for Safari — this proves the
    // capabilities branch itself doesn't trust that invariant either.
    const caps = buildLaunchCapabilities({
      browserName: 'safari', isHeadless: false, bidiRequested: true,
      downloadsDir: '/tmp/dl',
    });
    expect(caps.webSocketUrl).toBeUndefined();
    expect(caps.unhandledPromptBehavior).toBeUndefined();
  });

  it('ignores args/browserBinary/mobileEmulation inputs for Safari (not applicable, rejected upstream)', () => {
    const caps = buildLaunchCapabilities({
      browserName: 'safari', isHeadless: false, bidiRequested: false,
      downloadsDir: '/tmp/dl', browserBinary: '/Applications/Safari.app',
      args: ['--foo'], mobileEmulation: { deviceName: 'Pixel 7' },
    });
    expect(caps).toEqual({});
  });
});

describe('resolveElectronChromeDriver', () => {
  const savedEnv = process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
  const tempDirs: string[] = [];
  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    else process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH = savedEnv;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an explicit chromedriverPath that exists', async () => {
    const tmp = makeTempDir('ecd-');
    const driver = path.join(tmp, 'chromedriver');
    fs.writeFileSync(driver, '#!/bin/sh\n');
    if (process.platform !== 'win32') fs.chmodSync(driver, 0o755);
    await expect(resolveElectronChromeDriver({ chromedriverPath: driver })).resolves.toBe(driver);
    await expect(resolveElectronChromeDriverInfo({ chromedriverPath: driver })).resolves.toEqual({
      path: driver,
      source: 'explicit',
    });
  });

  it('throws (does not fall through) when an explicit path is missing', async () => {
    await expect(
      resolveElectronChromeDriver({ chromedriverPath: '/no/such/chromedriver' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('rejects a directory and a non-executable driver before spawning it', async () => {
    const tmp = makeTempDir('ecd-invalid-');
    await expect(resolveElectronChromeDriver({ chromedriverPath: tmp }))
      .rejects.toThrow(/is not a file/);

    if (process.platform !== 'win32') {
      const driver = path.join(tmp, 'chromedriver');
      fs.writeFileSync(driver, '#!/bin/sh\n');
      fs.chmodSync(driver, 0o644);
      await expect(resolveElectronChromeDriver({ chromedriverPath: driver }))
        .rejects.toThrow(/is not executable/);
    }
  });

  it('resolves a relative explicit path to an absolute spawn path', async () => {
    const tmp = makeTempDir('ecd-relative-');
    const driver = path.join(tmp, 'chromedriver');
    fs.writeFileSync(driver, '#!/bin/sh\n');
    if (process.platform !== 'win32') fs.chmodSync(driver, 0o755);
    const cwd = process.cwd();
    try {
      process.chdir(tmp);
      await expect(resolveElectronChromeDriver({ chromedriverPath: './chromedriver' }))
        .resolves.toBe(fs.realpathSync(driver));
    } finally {
      process.chdir(cwd);
    }
  });

  it('honors CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH', async () => {
    const tmp = makeTempDir('ecd-');
    const driver = path.join(tmp, 'chromedriver');
    fs.writeFileSync(driver, '#!/bin/sh\n');
    if (process.platform !== 'win32') fs.chmodSync(driver, 0o755);
    process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH = driver;
    await expect(resolveElectronChromeDriver()).resolves.toBe(driver);
    await expect(resolveElectronChromeDriverInfo()).resolves.toEqual({
      path: driver,
      source: 'environment',
    });
  });

  it('resolves the electron-chromedriver package from the project cwd', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    const tmp = makeTempDir('ecd-package-');
    const packageDir = path.join(tmp, 'node_modules', 'electron-chromedriver');
    const binDir = path.join(packageDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const driver = path.join(binDir, process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver');
    fs.writeFileSync(driver, '');
    if (process.platform !== 'win32') fs.chmodSync(driver, 0o755);
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: 'electron-chromedriver', version: '1.0.0', main: 'index.js',
    }));
    fs.writeFileSync(path.join(packageDir, 'index.js'), `module.exports = ${JSON.stringify(driver)};\n`);

    const cwd = process.cwd();
    try {
      process.chdir(tmp);
      await expect(resolveElectronChromeDriver()).resolves.toBe(driver);
      await expect(resolveElectronChromeDriverInfo()).resolves.toEqual({
        path: driver,
        source: 'package',
      });
    } finally {
      process.chdir(cwd);
    }
  });

  it('throws actionable guidance when nothing resolves (no system-Chrome fallback)', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    // Run from a scratch dir with no electron-chromedriver installed.
    const tmp = makeTempDir('ecd-empty-');
    const cwd = process.cwd();
    try {
      process.chdir(tmp);
      await expect(resolveElectronChromeDriver()).rejects.toThrow(/electron-chromedriver/);
    } finally {
      process.chdir(cwd);
    }
  });

  it.skipIf(process.platform === 'win32')('reads a ChromeDriver version for diagnostics', () => {
    const tmp = makeTempDir('ecd-version-');
    const executable = path.join(tmp, 'chromedriver');
    fs.writeFileSync(
      executable,
      '#!/bin/sh\necho "ChromeDriver 123.4.5.6"\n',
    );
    fs.chmodSync(executable, 0o755);

    expect(readChromeDriverVersion(executable)).toBe('123.4.5.6');
  });
});

describe('chromiumMajorForElectron — vendored map (pure)', () => {
  it('maps known Electron majors to their bundled Chromium major', () => {
    expect(chromiumMajorForElectron('37.2.0')).toBe(138);
    expect(chromiumMajorForElectron('43.1.0')).toBe(150); // craftdriver's compat target
    expect(chromiumMajorForElectron('26.0.0')).toBe(116);
    // 39–42 fill the once-missing gap (39 verified live: Fiddler Everywhere 7.8).
    expect(chromiumMajorForElectron('39.8.6')).toBe(142); // Fiddler
    expect(chromiumMajorForElectron('40.0.0')).toBe(144);
    expect(chromiumMajorForElectron('41.0.0')).toBe(146);
    expect(chromiumMajorForElectron('42.0.0')).toBe(148);
  });

  it('is contiguous across 26→43 (no gaps that would fail a real app)', () => {
    for (let major = 26; major <= 43; major++) {
      expect(chromiumMajorForElectron(`${major}.0.0`)).toBeDefined();
    }
  });

  it('accepts a bare major and tolerates leading whitespace', () => {
    expect(chromiumMajorForElectron('37')).toBe(138);
    expect(chromiumMajorForElectron('  37.2.0')).toBe(138);
  });

  it('returns undefined for unmapped or malformed versions', () => {
    expect(chromiumMajorForElectron('999.0.0')).toBeUndefined();
    expect(chromiumMajorForElectron('')).toBeUndefined();
    expect(chromiumMajorForElectron('nightly')).toBeUndefined();
  });

  it('exposes its known majors ascending, for diagnostics', () => {
    const majors = knownElectronMajors();
    expect(majors).toEqual([...majors].sort((a, b) => a - b));
    expect(majors).toContain(37);
    expect(majors).toContain(43);
  });
});

describe('resolveElectronChromeDriverInfo — version → Chrome for Testing', () => {
  const savedEnvPath = process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
  const savedOffline = process.env.CRAFTDRIVER_OFFLINE;
  const tempDirs: string[] = [];
  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    restore('CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH', savedEnvPath);
    restore('CRAFTDRIVER_OFFLINE', savedOffline);
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeDriver = (dir: string): string => {
    const driver = path.join(dir, 'chromedriver');
    fs.writeFileSync(driver, '#!/bin/sh\n');
    if (process.platform !== 'win32') fs.chmodSync(driver, 0o755);
    return driver;
  };

  it('lets an explicit chromedriverPath win over version (no download)', async () => {
    const driver = writeDriver(makeTempDir('ecd-ver-path-'));
    await expect(
      resolveElectronChromeDriverInfo({ chromedriverPath: driver, version: '37.2.0' }),
    ).resolves.toEqual({ path: driver, source: 'explicit' });
  });

  it('lets the env override win over version (no download)', async () => {
    const driver = writeDriver(makeTempDir('ecd-ver-env-'));
    process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH = driver;
    await expect(resolveElectronChromeDriverInfo({ version: '37.2.0' }))
      .resolves.toMatchObject({ path: driver, source: 'environment' });
  });

  it('throws an actionable error for an unmapped version, before any network', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    await expect(resolveElectronChromeDriverInfo({ version: '999.0.0' }))
      .rejects.toThrow(/Could not map Electron version "999\.0\.0"[\s\S]*Known Electron majors/);
  });

  it('a mapped version reaches the download step (blocked cleanly when offline)', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    process.env.CRAFTDRIVER_OFFLINE = '1';
    // Proves 37 mapped (Chromium 138) and routed to the downloader, without a
    // real network call — offline short-circuits with a driver-path hint.
    await expect(resolveElectronChromeDriverInfo({ version: '37.2.0' }))
      .rejects.toThrow(/CRAFTDRIVER_OFFLINE is set[\s\S]*Chromium 138[\s\S]*chromedriverPath/);
  });
});

describe('detectElectronVersion + auto-detected resolution', () => {
  const savedEnvPath = process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
  const savedOffline = process.env.CRAFTDRIVER_OFFLINE;
  const tempDirs: string[] = [];
  const cwd = process.cwd();

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    process.chdir(cwd);
    restore('CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH', savedEnvPath);
    restore('CRAFTDRIVER_OFFLINE', savedOffline);
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Build a temp project dir with the named packages "installed" in node_modules. */
  const makeProject = (installs: {
    electron?: string;
    electronNightly?: string;
    electronChromedriver?: boolean;
  }): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecd-detect-'));
    tempDirs.push(root);
    const installPkg = (name: string, version: string) => {
      const dir = path.join(root, 'node_modules', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
    };
    if (installs.electron) installPkg('electron', installs.electron);
    if (installs.electronNightly) installPkg('electron-nightly', installs.electronNightly);
    if (installs.electronChromedriver) {
      const binDir = path.join(root, 'node_modules', 'electron-chromedriver', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      const driver = path.join(binDir, process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver');
      fs.writeFileSync(driver, '');
      if (process.platform !== 'win32') fs.chmodSync(driver, 0o755);
      const pkgDir = path.join(root, 'node_modules', 'electron-chromedriver');
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
        name: 'electron-chromedriver', version: '1.0.0', main: 'index.js',
      }));
      fs.writeFileSync(path.join(pkgDir, 'index.js'), `module.exports = ${JSON.stringify(driver)};\n`);
    }
    return root;
  };

  it('reads the concrete version from a local electron install', () => {
    expect(detectElectronVersion(makeProject({ electron: '37.2.0' }))).toBe('37.2.0');
  });

  it('falls back to electron-nightly, and is undefined when neither is installed', () => {
    expect(detectElectronVersion(makeProject({ electronNightly: '40.0.0-nightly.1' })))
      .toBe('40.0.0-nightly.1');
    expect(detectElectronVersion(makeProject({}))).toBeUndefined();
  });

  it('lets an installed electron-chromedriver win over auto-detection (no download)', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    process.chdir(makeProject({ electron: '37.2.0', electronChromedriver: true }));
    // Package resolves before the detection branch — never a surprise download.
    await expect(resolveElectronChromeDriverInfo()).resolves.toMatchObject({ source: 'package' });
  });

  it('auto-detects and routes to CfT when only electron is installed (offline proves the route)', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    process.env.CRAFTDRIVER_OFFLINE = '1';
    process.chdir(makeProject({ electron: '37.2.0' }));
    // Detected 37 → Chromium 138 → download step; offline short-circuits cleanly.
    await expect(resolveElectronChromeDriverInfo())
      .rejects.toThrow(/CRAFTDRIVER_OFFLINE is set[\s\S]*Chromium 138/);
  });

  it('falls through to the generic error for an unmapped detected version', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    process.chdir(makeProject({ electron: '999.0.0' }));
    // Unmapped → detection branch skips (no throw of its own) → generic guidance.
    await expect(resolveElectronChromeDriverInfo())
      .rejects.toThrow(/No chromedriver found for Electron/);
  });

  it('lets an explicit version override auto-detection', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    process.env.CRAFTDRIVER_OFFLINE = '1';
    process.chdir(makeProject({ electron: '37.2.0' })); // detected would be 37 → 138
    // Explicit 43 → 150 wins: the offline message names 150, not 138.
    await expect(resolveElectronChromeDriverInfo({ version: '43.1.0' }))
      .rejects.toThrow(/Chromium 150/);
  });

  // Reading the Electron version from a packaged app's own bundle is macOS-only
  // (the tiny Electron Framework Info.plist, read via PlistBuddy) — the zero-config
  // path for a production app that ships no `electron` install.
  const isMac = process.platform === 'darwin';

  /** Build a fake macOS .app whose Electron Framework Info.plist carries CFBundleVersion. */
  const makeApp = (cfBundleVersion: string): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecd-app-'));
    tempDirs.push(root);
    const macos = path.join(root, 'Example.app', 'Contents', 'MacOS');
    const fwRes = path.join(
      root, 'Example.app', 'Contents', 'Frameworks',
      'Electron Framework.framework', 'Resources',
    );
    fs.mkdirSync(macos, { recursive: true });
    fs.mkdirSync(fwRes, { recursive: true });
    const bin = path.join(macos, 'Example');
    fs.writeFileSync(bin, '');
    fs.writeFileSync(
      path.join(fwRes, 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      `<plist version="1.0"><dict><key>CFBundleVersion</key><string>${cfBundleVersion}</string></dict></plist>\n`,
    );
    return bin;
  };

  it.skipIf(!isMac)('detectElectronVersionFromApp reads CFBundleVersion, undefined otherwise', () => {
    expect(detectElectronVersionFromApp(makeApp('39.8.6'))).toBe('39.8.6');
    expect(detectElectronVersionFromApp('/no/such/app/Contents/MacOS/x')).toBeUndefined();
    expect(detectElectronVersionFromApp(undefined)).toBeUndefined();
  });

  it.skipIf(!isMac)('resolves the driver from a packaged app bundle (source app-bundle-version)', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    process.env.CRAFTDRIVER_OFFLINE = '1';
    process.chdir(makeProject({})); // no installed electron — bundle is the only signal
    const bin = makeApp('39.8.6'); // Electron 39 → Chromium 142
    // Offline short-circuits, but names the mapped Chromium — proving the route.
    await expect(resolveElectronChromeDriverInfo({ appBinaryPath: bin }))
      .rejects.toThrow(/CRAFTDRIVER_OFFLINE is set[\s\S]*Chromium 142/);
  });

  it.skipIf(!isMac)('app-bundle version beats a differently-versioned installed electron', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    process.env.CRAFTDRIVER_OFFLINE = '1';
    process.chdir(makeProject({ electron: '37.2.0' })); // detected would be 37 → 138
    const bin = makeApp('43.1.0'); // the app actually being driven → 150
    await expect(resolveElectronChromeDriverInfo({ appBinaryPath: bin }))
      .rejects.toThrow(/Chromium 150/); // the app bundle wins, not the stray install
  });

  it.skipIf(!isMac)('unmapped app-bundle version does not fall through to local electron', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    process.env.CRAFTDRIVER_OFFLINE = '1';
    process.chdir(makeProject({ electron: '37.2.0' }));
    const bin = makeApp('999.0.0');
    await expect(resolveElectronChromeDriverInfo({ appBinaryPath: bin }))
      .rejects.toThrow(/Could not map Electron version "999\.0\.0"/);
  });

  it.skipIf(!isMac)('an explicit version still wins over the app bundle', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    process.env.CRAFTDRIVER_OFFLINE = '1';
    const bin = makeApp('43.1.0'); // 150
    await expect(resolveElectronChromeDriverInfo({ version: '37.2.0', appBinaryPath: bin }))
      .rejects.toThrow(/Chromium 138/); // explicit 37 → 138 wins
  });

  it.skipIf(!isMac)('an installed electron-chromedriver still wins over the app bundle', async () => {
    delete process.env.CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH;
    process.chdir(makeProject({ electronChromedriver: true }));
    const bin = makeApp('43.1.0');
    await expect(resolveElectronChromeDriverInfo({ appBinaryPath: bin }))
      .resolves.toMatchObject({ source: 'package' });
  });
});

describe('ElectronService spawn env', () => {
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = saved;
  });

  it('strips ELECTRON_RUN_AS_NODE so the app spawns as Electron, not Node', () => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    const electronEnv = (new ElectronService() as unknown as {
      computeSpawnEnv(): NodeJS.ProcessEnv;
    }).computeSpawnEnv();
    const chromeEnv = (new ChromeService() as unknown as {
      computeSpawnEnv(): NodeJS.ProcessEnv;
    }).computeSpawnEnv();
    // Electron renderer automation can't run against a Node process; browser
    // automation is unaffected (chromedriver launches Chrome, which ignores it).
    expect(electronEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(chromeEnv.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
