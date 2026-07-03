import type { Driver } from './driver.js';
import { By } from './by.js';
import { WebElement } from './webelement.js';
import { CraftdriverError, ErrorCode } from './errors.js';

export type Condition<T = any> = (driver: Driver) => Promise<T>;

/**
 * Default interval between auto-wait poll attempts, in ms. Kept low so waits
 * on dynamically-appearing/visible elements resolve with little quantization
 * lag (an element ready mid-interval is otherwise noticed up to a full
 * interval late). The first attempt runs immediately, so already-present
 * elements never pay this — it only affects genuine waits. Shared with the
 * hand-rolled poll loops in `locator.ts` so the two stay in lockstep.
 */
export const DEFAULT_POLL_INTERVAL_MS = 25;

export interface WaitOptions {
  timeout?: number;
  interval?: number;
  timeoutMsg?: string;
}

export class WebDriverWait {
  private timeoutMs: number;
  private intervalMs: number;
  private timeoutMsg?: string;

  constructor(
    private driver: Driver,
    timeoutOrOptions?: number | WaitOptions,
    intervalMs?: number
  ) {
    if (typeof timeoutOrOptions === 'object') {
      this.timeoutMs = timeoutOrOptions?.timeout ?? 5000;
      this.intervalMs = timeoutOrOptions?.interval ?? DEFAULT_POLL_INTERVAL_MS;
      this.timeoutMsg = timeoutOrOptions?.timeoutMsg;
    } else {
      this.timeoutMs = timeoutOrOptions ?? 5000;
      this.intervalMs = intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    }
  }

  async until<T>(condition: Condition<T>, message?: string): Promise<T> {
    const deadline = Date.now() + this.timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const result = await condition(this.driver);
        // Resolve on truthy or non-null/undefined result
        if (result || (result as any) === 0 || (result as any) === false) {
          return result;
        }
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, this.intervalMs));
    }
    const errMsg = message ?? this.timeoutMsg ?? `Wait timed out after ${this.timeoutMs}ms`;
    const full = lastErr ? `${errMsg}: ${String((lastErr as any)?.message ?? lastErr)}` : errMsg;
    // Preserve a more specific code when the inner condition already raised one.
    if (CraftdriverError.is(lastErr)) {
      throw new CraftdriverError(lastErr.code, full, {
        detail: { ...(lastErr.detail ?? {}), timeout: this.timeoutMs },
        cause: lastErr,
        hint: lastErr.hint,
      });
    }
    throw new CraftdriverError(ErrorCode.TIMEOUT, full, {
      detail: { timeout: this.timeoutMs },
      cause: lastErr,
    });
  }
}

async function resolveElement(driver: Driver, target: By | WebElement): Promise<WebElement> {
  if (target instanceof WebElement) return target;
  return await driver.findElement(target);
}

export const until = {
  elementLocated: (locator: By) => async (driver: Driver) => {
    return await driver.findElement(locator);
  },

  elementExists: (locator: By) => async (driver: Driver) => {
    try {
      await driver.findElement(locator);
      return true;
    } catch {
      return false as any; // keep waiting
    }
  },

  elementNotExists: (locator: By) => async (driver: Driver) => {
    try {
      await driver.findElement(locator);
      return false as any; // still exists, keep waiting
    } catch {
      return true;
    }
  },

  elementIsVisible: (target: By | WebElement) => async (driver: Driver) => {
    const el = await resolveElement(driver, target);
    try {
      const visible = await el.isDisplayed();
      return visible ? el : (undefined as any);
    } catch {
      return undefined as any; // stale/not found -> not visible yet
    }
  },

  elementIsNotVisible: (target: By | WebElement) => async (driver: Driver) => {
    try {
      const el = await resolveElement(driver, target);
      try {
        const visible = await el.isDisplayed();
        return visible ? (false as any) : true;
      } catch {
        return true; // stale/not found counts as not visible
      }
    } catch {
      return true; // not found
    }
  },
};
