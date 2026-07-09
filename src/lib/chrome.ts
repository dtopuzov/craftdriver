import { DriverService, type DriverServiceOptions } from './service.js';
import { resolveChromeDriver } from './driverManager.js';

export type ChromeServiceOptions = Omit<DriverServiceOptions, 'command'> & {
  /**
   * Absolute path to a `chromedriver` binary.
   * When omitted, craftdriver resolves the driver automatically:
   *   1. CRAFTDRIVER_DRIVER_PATH / CHROMEDRIVER_PATH / SE_CHROMEDRIVER env vars
   *   2. Known CI-provided driver directories (e.g. GitHub Actions' CHROMEWEBDRIVER)
   *   3. node_modules/.bin/chromedriver (if chromedriver npm package is installed)
   *   4. chromedriver on PATH
   *   5. Detect system Chrome version → download matching chromedriver from CfT
   */
  binaryPath?: string;
  /**
   * A custom **browser** binary — Chrome or Chromium — distinct from
   * `binaryPath` above (which names the *driver*). Not sent to the driver
   * directly; used only so that if `binaryPath` is omitted and chromedriver
   * has to be auto-downloaded, its version is detected from this binary
   * instead of probing for system Chrome. To actually launch this binary,
   * also set `LaunchOptions.browserPath` (or the `CRAFTDRIVER_CHROME_PATH`
   * / `CHROME_BIN` env vars) — see docs/driver-configuration.md.
   */
  browserPath?: string;
};

export class ChromeService extends DriverService {
  private readonly binaryPath: string | undefined;
  private readonly browserPath: string | undefined;

  constructor(options: ChromeServiceOptions = {}) {
    const { binaryPath, browserPath, ...rest } = options;
    // Pass a placeholder command; the real path is resolved asynchronously in start().
    super({
      command: binaryPath ?? 'chromedriver',
      pathBase: '',
      readinessPath: '/status',
      ...rest,
    });
    this.binaryPath = binaryPath;
    this.browserPath = browserPath;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.opts.command = await resolveChromeDriver({ binaryPath: this.binaryPath, browserPath: this.browserPath });
    await super.start();
  }
}
