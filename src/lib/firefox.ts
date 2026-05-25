import { DriverService, type DriverServiceOptions } from './service.js';
import { resolveFirefoxDriver } from './driverManager.js';

export type FirefoxServiceOptions = Omit<DriverServiceOptions, 'command'> & {
  /**
   * Absolute path to a `geckodriver` binary.
   * When omitted, craftdriver resolves the driver automatically:
   *   1. CRAFTDRIVER_DRIVER_PATH / GECKODRIVER_PATH / GECKODRIVER_FILEPATH / SE_GECKODRIVER env vars
   *   2. node_modules/.bin/geckodriver (if geckodriver npm package is installed)
   *   3. geckodriver on PATH
   *   4. Download latest geckodriver from GitHub releases
   */
  binaryPath?: string;
};

export class FirefoxService extends DriverService {
  private readonly binaryPath: string | undefined;

  constructor(options: FirefoxServiceOptions = {}) {
    const { binaryPath, ...rest } = options;

    // Default the BiDi WebSocket port to 0 (ephemeral) so multiple Firefox
    // sessions don't fight over geckodriver's hard-coded default of 9222.
    // A leftover Firefox process holding 9222 otherwise causes the next
    // session's BiDi connect to land on the stale server and return 404.
    const userArgs = rest.args ?? [];
    const hasWsPort = userArgs.some(
      (a) => a === '--websocket-port' || a.startsWith('--websocket-port='),
    );
    const args = hasWsPort ? userArgs : ['--websocket-port=0', ...userArgs];

    // Pass a placeholder command; the real path is resolved asynchronously in start().
    super({
      command: binaryPath ?? 'geckodriver',
      pathBase: '',
      readinessPath: '/status',
      // geckodriver can take a moment to spin up Marionette + start listening.
      readinessTimeoutMs: rest.readinessTimeoutMs ?? 15000,
      ...rest,
      args,
    });
    this.binaryPath = binaryPath;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    this.opts.command = await resolveFirefoxDriver({ binaryPath: this.binaryPath });
    await super.start();
  }
}
