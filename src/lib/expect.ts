import type { By } from './by.js';
import type { Driver } from './driver.js';
import { until } from './wait.js';

export interface ExpectApi {
  toHaveText(text: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  toBeVisible(opts?: { timeout?: number }): Promise<void>;
  not: {
    toBeVisible(opts?: { timeout?: number }): Promise<void>;
  };
}

export function expectSelector(driver: Driver, by: By): ExpectApi {
  function fail(message: string): never {
    throw new Error(message);
  }

  const toHaveText = async function toHaveText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    let last = '';
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        const text = (await found.getText())?.trim?.() ?? '';
        last = text;
        if (expected instanceof RegExp) {
          if (expected.test(text)) return;
        } else if (text === expected) {
          return;
        }
      } catch {
        // retry
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const exp = expected instanceof RegExp ? `/${expected.source}/` : `"${expected}"`;
    fail(`Expected element ${by.using}(${by.value}) to have text ${exp} but got "${last}"`);
  };

  const toBeVisible = async function toBeVisible(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? 5000;
    try {
      await driver.wait(until.elementIsVisible(by), { timeout });
    } catch {
      fail(`Expected element ${by.using}(${by.value}) to be visible within ${timeout}ms`);
    }
  };

  const toBeNotVisible = async function toBeNotVisible(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? 5000;
    try {
      await driver.wait(until.elementIsNotVisible(by), { timeout });
    } catch {
      fail(`Expected element ${by.using}(${by.value}) to become hidden within ${timeout}ms`);
    }
  };

  return {
    toHaveText,
    toBeVisible,
    not: { toBeVisible: toBeNotVisible },
  };
}
