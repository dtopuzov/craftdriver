import { ChromeService } from './chrome.js';
import { FirefoxService } from './firefox.js';
import { SafariService, augmentSafariSessionError } from './safari.js';
import { DriverService } from './service.js';
import { Driver } from './driver.js';
import type { Capabilities, WebDriverEndpoint } from './types.js';
import {
  invalidateChromeDriverAutoResolutionCache,
  readChromeDriverVersion,
} from './driverManager.js';
import { CraftdriverError, ErrorCode } from './errors.js';
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
  return (
    /session not created/i.test(message) &&
    /chromedriver.*only supports chrome version/i.test(message)
  );
}

function isLocalSessionCreationTimeout(err: unknown): boolean {
  return (
    CraftdriverError.is(err, ErrorCode.DRIVER_ERROR) &&
    err.detail?.method === 'POST' &&
    err.detail?.path === '/session' &&
    typeof err.detail?.timeoutMs === 'number'
  );
}

interface LocalSessionAttemptDiagnostic {
  attempt: number;
  driverPath: string;
  driverVersion?: string;
  endpoint: string;
  error: string;
  driverOutputTail?: string;
}

function localEndpointLabel(endpoint: WebDriverEndpoint): string {
  const basePath = endpoint.path ?? '';
  return `${endpoint.protocol}://${endpoint.hostname}:${endpoint.port}${basePath}`;
}

function captureLocalSessionAttempt(
  attempt: number,
  service: DriverService,
  endpoint: WebDriverEndpoint,
  err: unknown
): LocalSessionAttemptDiagnostic {
  const driverPath = service.getCommand();
  const driverVersion = service.allowsFreshSessionRetry()
    ? readChromeDriverVersion(driverPath)
    : undefined;
  const driverOutputTail = service.getOutputTail().trim();
  return {
    attempt,
    driverPath,
    ...(driverVersion ? { driverVersion } : {}),
    endpoint: localEndpointLabel(endpoint),
    error: err instanceof Error ? err.message : String(err),
    ...(driverOutputTail ? { driverOutputTail } : {}),
  };
}

function augmentLocalSessionError(
  err: unknown,
  attempts: LocalSessionAttemptDiagnostic[]
): CraftdriverError {
  const summary = attempts
    .map((attempt) => {
      const lines = [
        `Attempt ${attempt.attempt}: driver=${attempt.driverPath}`,
        `  driverVersion=${attempt.driverVersion ?? 'unavailable'}`,
        `  endpoint=${attempt.endpoint}`,
        `  error=${attempt.error}`,
      ];
      if (attempt.driverOutputTail) {
        lines.push(`  driver output (tail):\n${attempt.driverOutputTail}`);
      }
      return lines.join('\n');
    })
    .join('\n');
  const message = err instanceof Error ? err.message : String(err);
  const detail = CraftdriverError.is(err) ? err.detail : undefined;
  const attemptLabel = attempts.length === 1 ? 'attempt' : 'attempts';

  return new CraftdriverError(
    ErrorCode.DRIVER_ERROR,
    `${message}\nLocal Chrome session diagnostics (${attempts.length} ${attemptLabel}):\n${summary}`,
    {
      detail: { ...detail, sessionAttempts: attempts },
      cause: err,
      ...(CraftdriverError.is(err) && err.hint ? { hint: err.hint } : {}),
    }
  );
}

export class Builder {
  private browserName: string | undefined;
  private chromeService: ChromeService | undefined;
  private firefoxService: FirefoxService | undefined;
  private safariService: SafariService | undefined;
  private caps: Capabilities = {};
  private remoteEndpoint: WebDriverEndpoint | undefined;
  private remoteSessionTimeoutMs: number | undefined;

  /**
   * Target a remote W3C WebDriver endpoint instead of a local driver
   * process. When set, `build()` skips `service.start()`/the local
   * driver-process lifecycle entirely and creates the session directly
   * against `endpoint`.
   */
  usingServer(endpoint: WebDriverEndpoint, options?: { sessionTimeoutMs?: number }): this {
    this.remoteEndpoint = endpoint;
    this.remoteSessionTimeoutMs = options?.sessionTimeoutMs;
    return this;
  }

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
    if (this.remoteEndpoint) {
      // Deliberately not routed through createSessionWithRetries(): that
      // retry loop exists for local-driver-process lag (Firefox Marionette
      // readiness, Chrome driver-cache mismatches). A remote POST /session
      // that times out client-side may have already succeeded server-side —
      // blind retry risks creating a second, paid, orphaned session on a
      // metered provider. Create once; if it fails, fail.
      const name = this.browserName ?? 'chrome';
      const caps = { browserName: name, ...this.caps };
      return await Driver.create(this.remoteEndpoint, caps, {
        timeoutMs: this.remoteSessionTimeoutMs,
      });
    }

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
        `Unsupported browser "${name}". Supported: chrome, chromium, firefox, safari.`
      );
    }
    const caps = { browserName: name, ...this.caps };
    let retriedAfterChromeDriverCacheInvalidation = false;
    let retriedAfterLocalSessionTimeout = false;
    let localSessionAttempt = 0;
    const localSessionAttempts: LocalSessionAttemptDiagnostic[] = [];

    while (true) {
      await service.start();
      const endpoint = service.getEndpoint();
      localSessionAttempt++;

      try {
        return await this.createSessionWithRetries(name, endpoint, caps);
      } catch (err) {
        const attemptDiagnostic = captureLocalSessionAttempt(
          localSessionAttempt,
          service,
          endpoint,
          err
        );
        localSessionAttempts.push(attemptDiagnostic);

        if (
          isChromeFamily(name) &&
          !retriedAfterChromeDriverCacheInvalidation &&
          isChromeDriverVersionMismatch(err) &&
          invalidateChromeDriverAutoResolutionCache(service.getCommand())
        ) {
          retriedAfterChromeDriverCacheInvalidation = true;
          await service.stop().catch(() => {});
          continue;
        }

        if (
          isChromeFamily(name) &&
          service.allowsFreshSessionRetry() &&
          !retriedAfterLocalSessionTimeout &&
          isLocalSessionCreationTimeout(err)
        ) {
          retriedAfterLocalSessionTimeout = true;
          await service.stop().catch(() => {});
          continue;
        }

        await service.stop().catch(() => {});
        // Turn safaridriver's "Allow Remote Automation" refusal into an
        // actionable remedy instead of an opaque session-creation failure.
        // No-op for every other error shape (see augmentSafariSessionError).
        if (name === 'safari') throw augmentSafariSessionError(err);
        if (
          service.allowsFreshSessionRetry() &&
          (retriedAfterLocalSessionTimeout || isLocalSessionCreationTimeout(err))
        ) {
          throw augmentLocalSessionError(err, localSessionAttempts);
        }
        throw err;
      }
    }
  }

  private async createSessionWithRetries(
    name: string,
    endpoint: WebDriverEndpoint,
    caps: Capabilities
  ): Promise<Driver> {
    // Firefox's Marionette interface may not be ready immediately after geckodriver
    // reports healthy. Retry session creation with back-off before giving up.
    // Safari has no measured evidence of needing different session-creation
    // timing than Chrome (safaridriver's readiness poll already covers the
    // driver-process-up case; there's no known equivalent lag), so it reuses
    // CHROME_SESSION_MAX_ATTEMPTS rather than introducing an unmeasured new
    // constant. Revisit with real numbers if Safari session creation proves
    // flaky in practice.
    const maxAttempts =
      name === 'firefox' ? FIREFOX_SESSION_MAX_ATTEMPTS : CHROME_SESSION_MAX_ATTEMPTS;
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
