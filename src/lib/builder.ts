import { ChromeService } from './chrome.js';
import { FirefoxService } from './firefox.js';
import { DriverService } from './service.js';
import { Driver } from './driver.js';
import { Capabilities } from './types.js';
import {
  FIREFOX_SESSION_MAX_ATTEMPTS,
  CHROME_SESSION_MAX_ATTEMPTS,
  SESSION_CREATE_BACKOFF_STEP_MS,
} from './timing.js';

export class Builder {
  private browserName: string | undefined;
  private chromeService: ChromeService | undefined;
  private firefoxService: FirefoxService | undefined;
  private caps: Capabilities = {};

  forBrowser(name: 'chrome' | 'chromium' | 'firefox' | string): this {
    this.browserName = name;
    return this;
  }

  setChromeService(service: ChromeService): this {
    this.chromeService = service;
    return this;
  }

  setFirefoxService(service: FirefoxService): this {
    this.firefoxService = service;
    return this;
  }

  withCapabilities(caps: Capabilities): this {
    this.caps = { ...this.caps, ...caps };
    return this;
  }

  async build(): Promise<Driver> {
    const name = this.browserName ?? 'chrome';
    let service: DriverService;
    if (name === 'chrome' || name === 'chromium') {
      service = this.chromeService ?? new ChromeService();
    } else if (name === 'firefox') {
      service = this.firefoxService ?? new FirefoxService();
    } else {
      throw new Error(
        `Unsupported browser "${name}". Supported: chrome, chromium, firefox.`,
      );
    }
    await service.start();
    const endpoint = service.getEndpoint();
    const caps = { browserName: name, ...this.caps };

    // Firefox's Marionette interface may not be ready immediately after geckodriver
    // reports healthy. Retry session creation with back-off before giving up.
    const maxAttempts = name === 'firefox' ? FIREFOX_SESSION_MAX_ATTEMPTS : CHROME_SESSION_MAX_ATTEMPTS;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await Driver.create(endpoint, caps);
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, SESSION_CREATE_BACKOFF_STEP_MS * attempt));
        }
      }
    }
    throw lastErr;
  }
}
