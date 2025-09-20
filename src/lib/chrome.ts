import { DriverService, type DriverServiceOptions } from './service.js';
import fs from 'fs';
import path from 'path';

export type ChromeServiceOptions = Omit<DriverServiceOptions, 'command'>;

export class ChromeService extends DriverService {
  constructor(options: ChromeServiceOptions = {}) {
    const resolved = (() => {
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
      return 'chromedriver';
    })();
    super({
      command: resolved,
      pathBase: '',
      readinessPath: '/status',
      ...options,
    });
  }
}
