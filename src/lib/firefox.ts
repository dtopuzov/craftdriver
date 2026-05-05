import { DriverService, type DriverServiceOptions } from './service.js';
import fs from 'fs';
import path from 'path';

export type FirefoxServiceOptions = Omit<DriverServiceOptions, 'command'> & {
  /**
   * Absolute path to a `geckodriver` binary.
   * Falls back (in order) to:
   *   1. `$GECKODRIVER_PATH` env var (current standard)
   *   2. `$GECKODRIVER_FILEPATH` env var (deprecated, still honoured by the npm package)
   *   3. `node_modules/.bin/geckodriver` if the `geckodriver` npm package is installed
   *   4. `geckodriver` on `$PATH`
   */
  binaryPath?: string;
};

export class FirefoxService extends DriverService {
  constructor(options: FirefoxServiceOptions = {}) {
    const resolved = (() => {
      // 1. Explicit binaryPath option takes highest precedence.
      if (options.binaryPath && fs.existsSync(options.binaryPath)) {
        return options.binaryPath;
      }
      // 2. Standard env vars (same names used by the `geckodriver` npm package).
      //    GECKODRIVER_PATH  – current standard
      //    GECKODRIVER_FILEPATH – deprecated alias still honoured by the npm pkg
      for (const envVar of ['GECKODRIVER_PATH', 'GECKODRIVER_FILEPATH']) {
        const envPath = process.env[envVar];
        if (envPath && envPath.length > 0) {
          try {
            if (fs.existsSync(envPath)) return envPath;
          } catch {
            // fall through
          }
        }
      }
      // 3. Prefer a project-local install (`npm i geckodriver --save-dev`).
      //    node_modules/.bin/geckodriver is a shell wrapper that locates the
      //    cached binary downloaded by the `geckodriver` npm package.
      const localBin = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '../..',
        'node_modules/.bin/geckodriver',
      );
      if (fs.existsSync(localBin)) return localBin;
      // 4. Fall back to whatever is on PATH.
      return 'geckodriver';
    })();

    const { binaryPath: _ignore, ...rest } = options;
    void _ignore;

    // Default the BiDi WebSocket port to 0 (ephemeral) so multiple Firefox
    // sessions don't fight over geckodriver's hard-coded default of 9222.
    // A leftover Firefox process holding 9222 otherwise causes the next
    // session's BiDi connect to land on the stale server and return 404.
    const userArgs = rest.args ?? [];
    const hasWsPort = userArgs.some((a) => a === '--websocket-port' || a.startsWith('--websocket-port='));
    const args = hasWsPort ? userArgs : ['--websocket-port=0', ...userArgs];

    super({
      command: resolved,
      pathBase: '',
      readinessPath: '/status',
      // geckodriver can take a moment to spin up Marionette + start listening.
      readinessTimeoutMs: rest.readinessTimeoutMs ?? 15000,
      ...rest,
      args,
    });
  }
}
