import { ChromeService, type ChromeServiceOptions } from './chrome.js';
import {
  detectElectronVersion,
  detectElectronVersionFromApp,
  readChromeDriverVersion,
  resolveElectronChromeDriverInfo,
} from './driverManager.js';
import {
  assertDriverArchCompatible,
  assertDriverChromiumMajorCompatible,
} from './electronDiagnostics.js';
import os from 'os';

export function electronDebugEnabled(): boolean {
  return process.env.CRAFTDRIVER_DEBUG === '1' || process.env.CRAFTDRIVER_DEBUG === 'true';
}

export function writeElectronDebug(fields: Record<string, string | undefined>): void {
  if (!electronDebugEnabled()) return;
  const details = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
  process.stderr.write(`[craftdriver:electron] ${details}\n`);
}

/** Driver-process configuration for {@link ElectronService}. */
export type ElectronServiceOptions = Omit<ChromeServiceOptions, 'binaryPath' | 'browserPath'> & {
  /**
   * Absolute path to a `chromedriver` binary that matches your Electron app's
   * bundled Chromium — normally the one shipped by the `electron-chromedriver`
   * package (its version tracks your Electron major). When omitted, craftdriver
   * falls back to {@link ElectronServiceOptions.version} (if set), then to an
   * `electron-chromedriver` package in your project's `node_modules`.
   *
   * Unlike {@link ChromeService}, this is **never** resolved from a system
   * Chrome install: Electron embeds its own Chromium, so a system-Chrome driver
   * would be the wrong version. See `resolveElectronChromeDriver`.
   */
  chromedriverPath?: string;
  /**
   * The app's Electron version (e.g. `'37.2.0'`). When set — and no explicit
   * `chromedriverPath`/env overrides it — craftdriver maps it to the bundled
   * Chromium major and downloads a matching **Chrome-for-Testing** chromedriver,
   * removing the need for a project-local `electron-chromedriver`.
   *
   * Only Electron majors in craftdriver's vendored map resolve, and only if
   * Chrome for Testing publishes that Chromium major (>= 115). Otherwise pin
   * `chromedriverPath` or `electron-chromedriver`.
   */
  version?: string;
  /**
   * Path to the app executable being launched (the `appBinaryPath` from
   * `Browser.launch`). With no explicit `version`/`chromedriverPath`, craftdriver
   * reads the Electron version straight from a packaged app's bundle to resolve a
   * matching driver — so a production app "just works" from the executable alone.
   * macOS only for now; set automatically by `Browser.launch`.
   */
  appBinaryPath?: string;
};

/**
 * Driver service for automating an Electron application renderer. It uses the
 * chromedriver protocol like ChromeService, but resolves the driver only from
 * Electron-specific configuration, never from system Chrome.
 *
 * The Electron **app executable** itself is not set here; pass it as
 * `LaunchOptions.electron.appBinaryPath` (→ `goog:chromeOptions.binary`).
 */
export class ElectronService extends ChromeService {
  private readonly electronVersion: string | undefined;
  private readonly appBinaryPath: string | undefined;

  constructor(options: ElectronServiceOptions = {}) {
    const { chromedriverPath, version, appBinaryPath, ...rest } = options;
    // Reuse ChromeService's binaryPath slot to carry the Electron driver path;
    // resolveDriverCommand() below routes it through the Electron resolver.
    super({ ...rest, binaryPath: chromedriverPath });
    this.electronVersion = version;
    this.appBinaryPath = appBinaryPath;
  }

  /**
   * chromedriver spawns the Electron app inheriting this env, so scrub
   * `ELECTRON_RUN_AS_NODE`: when it's set the app runs as plain Node.js instead
   * of Electron — it rejects Chromium flags and exits, which chromedriver reports
   * only as "Chrome instance exited". Renderer automation never wants it, and the
   * main-process inspector bridge uses `--inspect`, not this var.
   */
  protected computeSpawnEnv(): NodeJS.ProcessEnv {
    const env = super.computeSpawnEnv();
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  protected async resolveDriverCommand(): Promise<string> {
    const resolution = await resolveElectronChromeDriverInfo({
      chromedriverPath: this.binaryPath,
      version: this.electronVersion,
      appBinaryPath: this.appBinaryPath,
    });

    // Fail fast, before spawning, on a driver that cannot drive this app.
    // Arch is a cheap header read — always checked. A version/detected driver was
    // just downloaded to match, so only a user-supplied driver (explicit path /
    // env / installed package) can be the wrong major — and only when we can
    // learn the app's Electron version to compare against (explicit, from the app
    // bundle, or from an installed `electron`).
    assertDriverArchCompatible(resolution.path);
    const resolvedByMatch =
      resolution.source === 'version' ||
      resolution.source === 'detected-version' ||
      resolution.source === 'app-bundle-version';
    if (!resolvedByMatch) {
      const knownVersion =
        this.electronVersion ??
        detectElectronVersionFromApp(this.appBinaryPath) ??
        detectElectronVersion();
      if (knownVersion) assertDriverChromiumMajorCompatible(resolution.path, knownVersion);
    }

    writeElectronDebug({
      // The version that actually drove resolution — the explicit one, or the
      // auto-detected one when `source` is 'detected-version'.
      electronVersion: resolution.version,
      driverPath: resolution.path,
      driverSource: resolution.source,
      driverVersion: electronDebugEnabled()
        ? (readChromeDriverVersion(resolution.path) ?? 'unavailable')
        : undefined,
      platform: `${os.platform()}-${os.arch()}`,
    });
    return resolution.path;
  }
}
