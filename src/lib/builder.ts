import { ChromeService } from './chrome.js';
import { FirefoxService } from './firefox.js';
import { SafariService, augmentSafariSessionError } from './safari.js';
import { DriverService } from './service.js';
import { Driver } from './driver.js';
import type { Capabilities, WebDriverEndpoint } from './types.js';
import { invalidateChromeDriverAutoResolutionCache } from './driverManager.js';
import {
  FIREFOX_SESSION_MAX_ATTEMPTS,
  CHROME_SESSION_MAX_ATTEMPTS,
  SESSION_CREATE_BACKOFF_STEP_MS,
} from './timing.js';

function isChromeFamily(name: string): boolean {
  return name === 'chrome' || name === 'chromium';
}

function isChromeDriverVersionMismatch(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /session not created/i.test(message) &&
    /chromedriver.*only supports chrome version/i.test(message);
}

export class Builder {
  private browserName: string | undefined;
  private chromeService: ChromeService | undefined;
  private firefoxService: FirefoxService | undefined;
  private safariService: SafariService | undefined;
  private caps: Capabilities = {};

  forBrowser(name: 'chrome' | 'chromium' | 'firefox' | 'safari' | string): this {
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

  setSafariService(service: SafariService): this {
    this.safariService = service;
    return this;
  }

  withCapabilities(caps: Capabilities): this {
    this.caps = { ...this.caps, ...caps };
    return this;
  }

  async build(): Promise<Driver> {
    const name = this.browserName ?? 'chrome';
    let service: DriverService;
    if (isChromeFamily(name)) {
      service = this.chromeService ?? new ChromeService();
    } else if (name === 'firefox') {
      service = this.firefoxService ?? new FirefoxService();
    } else if (name === 'safari') {
      service = this.safariService ?? new SafariService();
    } else {
      throw new Error(
        `Unsupported browser "${name}". Supported: chrome, chromium, firefox, safari.`,
      );
    }
    const caps = { browserName: name, ...this.caps };
    let retriedAfterChromeDriverCacheInvalidation = false;

    while (true) {
      await service.start();
      const endpoint = service.getEndpoint();

      try {
        return await this.createSessionWithRetries(name, endpoint, caps);
      } catch (err) {
        if (
          isChromeFamily(name) &&
          !retriedAfterChromeDriverCacheInvalidation &&
          isChromeDriverVersionMismatch(err) &&
          invalidateChromeDriverAutoResolutionCache(service.getCommand())
        ) {
          retriedAfterChromeDriverCacheInvalidation = true;
          await service.stop().catch(() => { });
          continue;
        }

        await service.stop().catch(() => { });
        // Turn safaridriver's "Allow Remote Automation" refusal into an
        // actionable remedy instead of an opaque session-creation failure.
        // No-op for every other error shape (see augmentSafariSessionError).
        throw name === 'safari' ? augmentSafariSessionError(err) : err;
      }
    }
  }

  private async createSessionWithRetries(
    name: string,
    endpoint: WebDriverEndpoint,
    caps: Capabilities,
  ): Promise<Driver> {
    // Firefox's Marionette interface may not be ready immediately after geckodriver
    // reports healthy. Retry session creation with back-off before giving up.
    // Safari has no measured evidence of needing different session-creation
    // timing than Chrome (safaridriver's readiness poll already covers the
    // driver-process-up case; there's no known equivalent lag), so it reuses
    // CHROME_SESSION_MAX_ATTEMPTS rather than introducing an unmeasured new
    // constant. Revisit with real numbers if Safari session creation proves
    // flaky in practice.
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
