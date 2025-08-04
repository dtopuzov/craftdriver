import { DriverService, type DriverServiceOptions } from './service.js';
import fs from 'fs';
import path from 'path';

export type ChromeServiceOptions = Omit<DriverServiceOptions, 'command'>;

export class ChromeService extends DriverService {
  constructor(options: ChromeServiceOptions = {}) {
    const resolved = (() => {
      const envPath = process.env.CHROMEDRIVER_PATH && process.env.CHROMEDRIVER_PATH.trim();
      if (envPath && envPath.length > 0) {
        try {
          if (fs.existsSync(envPath)) {
            const st = fs.statSync(envPath);
            if (st.isDirectory()) {
              const exeName = process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
              const candidate = path.join(envPath, exeName);
              if (fs.existsSync(candidate)) return candidate;
            } else {
              return envPath; // Points to file
            }
          }
        } catch {
          // fall through to default
        }
        // If path doesn't exist, still attempt to run it as-is
        return envPath;
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
