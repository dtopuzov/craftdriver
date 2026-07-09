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
};

export class ChromeService extends DriverService {
  private readonly binaryPath: string | undefined;

  constructor(options: ChromeServiceOptions = {}) {
    const { binaryPath, ...rest } = options;
    // Pass a placeholder command; the real path is resolved asynchronously in start().
    super({
      command: binaryPath ?? 'chromedriver',
      pathBase: '',
      readinessPath: '/status',
      ...rest,
    });
    this.binaryPath = binaryPath;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.opts.command = await resolveChromeDriver({ binaryPath: this.binaryPath });
    await super.start();
  }
}
