import { DriverService, type DriverServiceOptions } from './service.js';
import fs from 'fs';
import path from 'path';

export type ChromeServiceOptions = Omit<DriverServiceOptions, 'command'> & {
  /**
   * Absolute path to a `chromedriver` binary.
   * Falls back (in order) to:
   *   1. `$CHROMEDRIVER_PATH` env var
   *   2. `node_modules/.bin/chromedriver` if the `chromedriver` npm package is installed
   *   3. `chromedriver` on `$PATH`
   */
  binaryPath?: string;
};

export class ChromeService extends DriverService {
  constructor(options: ChromeServiceOptions = {}) {
    const resolved = (() => {
      if ((options as any).binaryPath && fs.existsSync((options as any).binaryPath)) {
        return (options as any).binaryPath as string;
      }
      const envPath = process.env.CHROMEDRIVER_PATH;
      if (envPath && envPath.length > 0) {
        try {
          if (fs.existsSync(envPath)) {
            return envPath; // Points to file
          }
        } catch {
          // fall through to default
        }
      }
      // Prefer the locally-installed chromedriver (matches the project's Chrome version)
      // over whatever happens to be on PATH.
      const localBin = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '../..',
        'node_modules/.bin/chromedriver',
      );
      if (fs.existsSync(localBin)) {
        return localBin;
      }
      return 'chromedriver';
    })();
    const { binaryPath: _ignore, ...rest } = options as ChromeServiceOptions & { binaryPath?: string };
    void _ignore;
    super({
      command: resolved,
      pathBase: '',
      readinessPath: '/status',
      ...rest,
    });
  }
}
