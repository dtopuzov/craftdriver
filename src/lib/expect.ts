import type { By } from './by.js';
import type { Driver } from './driver.js';
import type { WebElement } from './webelement.js';
import { until } from './wait.js';
import { CraftdriverError, ErrorCode } from './errors.js';
import {
  ASSERTION_POLL_INTERVAL_MS,
  ASSERTION_INNER_WAIT_CAP_MS,
  DEFAULT_ELEMENT_TIMEOUT_MS,
} from './timing.js';

/** Context switcher for frame/window scoping — used by Frame and Page. */
export type ContextSwitcher = { in: () => Promise<void>; out: () => Promise<void> };

export interface ExpectApi {
  toHaveText(text: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  toContainText(text: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  toHaveValue(value: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  toHaveAttribute(name: string, value?: string | RegExp, opts?: { timeout?: number }): Promise<void>;
  toHaveClass(className: string, opts?: { timeout?: number }): Promise<void>;
  toBeVisible(opts?: { timeout?: number }): Promise<void>;
  toBeEnabled(opts?: { timeout?: number }): Promise<void>;
  toBeDisabled(opts?: { timeout?: number }): Promise<void>;
  toBeChecked(opts?: { timeout?: number }): Promise<void>;
  not: {
    toBeVisible(opts?: { timeout?: number }): Promise<void>;
    toBeEnabled(opts?: { timeout?: number }): Promise<void>;
    toBeDisabled(opts?: { timeout?: number }): Promise<void>;
    toBeChecked(opts?: { timeout?: number }): Promise<void>;
    toHaveText(text: string | RegExp, opts?: { timeout?: number }): Promise<void>;
    toContainText(text: string | RegExp, opts?: { timeout?: number }): Promise<void>;
    toHaveValue(value: string | RegExp, opts?: { timeout?: number }): Promise<void>;
    toHaveAttribute(name: string, value?: string | RegExp, opts?: { timeout?: number }): Promise<void>;
    toHaveClass(className: string, opts?: { timeout?: number }): Promise<void>;
  };
}

function matchValue(actual: string, expected: string | RegExp): boolean {
  if (expected instanceof RegExp) {
    return expected.test(actual);
  }
  return actual === expected;
}

/** Format an expected string/RegExp for failure messages. */
function fmt(expected: string | RegExp): string {
  return expected instanceof RegExp ? `/${expected.source}/` : `"${expected}"`;
}

export function expectSelector(driver: Driver, by: By, getDefaultTimeout: () => number = () => DEFAULT_ELEMENT_TIMEOUT_MS, contextSwitcher?: ContextSwitcher): ExpectApi {
  function fail(message: string, callerFn?: Function, detail?: Record<string, unknown>): never {
    const error = new CraftdriverError(ErrorCode.EXPECT_MISMATCH, message, {
      detail: { selector: `${by.using}=${by.value}`, using: by.using, value: by.value, ...(detail ?? {}) },
    });
    // Remove internal expect.ts frames from stack trace so test file line shows first
    if (callerFn && Error.captureStackTrace) {
      Error.captureStackTrace(error, callerFn);
    }
    throw error;
  }

  /**
   * Poll the located element until `predicate` holds or `timeout` elapses,
   * returning whether it matched and the last value read (for failure messages).
   *
   * `onMissing` decides what a lookup/read failure means:
   * - `'retry'` — keep polling (positive matchers: the element must appear and satisfy the predicate).
   * - `'pass'`  — treat as satisfied (negative matchers: a missing element trivially cannot match).
   *
   * The inner `elementExists` wait is capped at `ASSERTION_INNER_WAIT_CAP_MS` so
   * the outer poll stays responsive rather than blocking for the full timeout.
   */
  async function pollElement<T>(
    read: (el: WebElement) => Promise<T>,
    predicate: (value: T) => boolean,
    timeout: number,
    onMissing: 'retry' | 'pass'
  ): Promise<{ matched: boolean; last: T | undefined }> {
    const deadline = Date.now() + timeout;
    let last: T | undefined;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(ASSERTION_INNER_WAIT_CAP_MS, timeout) });
        const value = await read(await driver.findElement(by));
        last = value;
        if (predicate(value)) return { matched: true, last };
      } catch {
        if (onMissing === 'pass') return { matched: true, last };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, ASSERTION_POLL_INTERVAL_MS));
    }
    return { matched: false, last };
  }

  const readText = async (el: WebElement): Promise<string> => (await el.getText())?.trim?.() ?? '';
  const readValue = async (el: WebElement): Promise<string> => String((await el.getProperty('value')) ?? '');
  const readClass = async (el: WebElement): Promise<string> => (await el.getAttribute('class')) ?? '';

  const toHaveText = async function toHaveText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched, last } = await pollElement(readText, (t) => matchValue(t, expected), timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to have text ${fmt(expected)} but got "${last ?? ''}"`, toHaveText);
  };

  const toContainText = async function toContainText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const contains = (t: string) => (expected instanceof RegExp ? expected.test(t) : t.includes(expected));
    const { matched, last } = await pollElement(readText, contains, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to contain text ${fmt(expected)} but got "${last ?? ''}"`, toContainText);
  };

  const toHaveValue = async function toHaveValue(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched, last } = await pollElement(readValue, (v) => matchValue(v, expected), timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to have value ${fmt(expected)} but got "${last ?? ''}"`, toHaveValue);
  };

  const toHaveAttribute = async function toHaveAttribute(
    name: string,
    value?: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const predicate = (attr: string | null) =>
      value === undefined ? attr !== null : attr !== null && matchValue(attr, value);
    const { matched, last } = await pollElement((el) => el.getAttribute(name), predicate, timeout, 'retry');
    if (matched) return;
    if (value === undefined) {
      fail(`Expected element ${by.using}(${by.value}) to have attribute "${name}" but it was not found`, toHaveAttribute);
    }
    fail(`Expected element ${by.using}(${by.value}) to have attribute "${name}" = ${fmt(value!)} but got "${last ?? null}"`, toHaveAttribute);
  };

  const toHaveClass = async function toHaveClass(
    className: string,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const hasClass = (cls: string) => cls.split(/\s+/).includes(className);
    const { matched, last } = await pollElement(readClass, hasClass, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to have class "${className}" but got "${last ?? ''}"`, toHaveClass);
  };

  const toBeVisible = async function toBeVisible(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    try {
      await driver.wait(until.elementIsVisible(by), { timeout });
    } catch {
      fail(`Expected element ${by.using}(${by.value}) to be visible within ${timeout}ms`, toBeVisible);
    }
  };

  const toBeNotVisible = async function toBeNotVisible(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    try {
      await driver.wait(until.elementIsNotVisible(by), { timeout });
    } catch {
      fail(`Expected element ${by.using}(${by.value}) to become hidden within ${timeout}ms`, toBeNotVisible);
    }
  };

  const toBeEnabled = async function toBeEnabled(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isEnabled(), (v) => v, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to be enabled within ${timeout}ms`, toBeEnabled);
  };

  const toBeDisabled = async function toBeDisabled(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isEnabled(), (v) => !v, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to be disabled within ${timeout}ms`, toBeDisabled);
  };

  const toBeChecked = async function toBeChecked(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isSelected(), (v) => v, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to be checked within ${timeout}ms`, toBeChecked);
  };

  const toBeNotChecked = async function toBeNotChecked(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isSelected(), (v) => !v, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to not be checked within ${timeout}ms`, toBeNotChecked);
  };

  const notToHaveText = async function notToHaveText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement(readText, (t) => !matchValue(t, expected), timeout, 'pass');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to NOT have text ${fmt(expected)}`, notToHaveText);
  };

  const notToContainText = async function notToContainText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const notContains = (t: string) => (expected instanceof RegExp ? !expected.test(t) : !t.includes(expected));
    const { matched } = await pollElement(readText, notContains, timeout, 'pass');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to NOT contain text ${fmt(expected)}`, notToContainText);
  };

  const notToHaveValue = async function notToHaveValue(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement(readValue, (v) => !matchValue(v, expected), timeout, 'pass');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to NOT have value ${fmt(expected)}`, notToHaveValue);
  };

  const notToHaveAttribute = async function notToHaveAttribute(
    name: string,
    value?: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const predicate = (attr: string | null) =>
      value === undefined ? attr === null : attr === null || !matchValue(attr, value);
    const { matched } = await pollElement((el) => el.getAttribute(name), predicate, timeout, 'pass');
    if (matched) return;
    if (value === undefined) {
      fail(`Expected element ${by.using}(${by.value}) to NOT have attribute "${name}"`, notToHaveAttribute);
    }
    fail(`Expected element ${by.using}(${by.value}) to NOT have attribute "${name}" = ${fmt(value!)}`, notToHaveAttribute);
  };

  const notToHaveClass = async function notToHaveClass(
    className: string,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const lacksClass = (cls: string) => !cls.split(/\s+/).includes(className);
    const { matched } = await pollElement(readClass, lacksClass, timeout, 'pass');
    if (matched) return;
    fail(`Expected element ${by.using}(${by.value}) to NOT have class "${className}"`, notToHaveClass);
  };

  // Wrap all methods with context switching if a switcher is provided
  function wrapCtx<T extends (...args: any[]) => Promise<any>>(fn: T): T {
    if (!contextSwitcher) return fn;
    const sw = contextSwitcher;
    return (async (...args: Parameters<T>) => {
      await sw.in();
      try {
        return await (fn as any)(...args);
      } finally {
        await sw.out();
      }
    }) as T;
  }

  return {
    toHaveText: wrapCtx(toHaveText),
    toContainText: wrapCtx(toContainText),
    toHaveValue: wrapCtx(toHaveValue),
    toHaveAttribute: wrapCtx(toHaveAttribute),
    toHaveClass: wrapCtx(toHaveClass),
    toBeVisible: wrapCtx(toBeVisible),
    toBeEnabled: wrapCtx(toBeEnabled),
    toBeDisabled: wrapCtx(toBeDisabled),
    toBeChecked: wrapCtx(toBeChecked),
    not: {
      toBeVisible: wrapCtx(toBeNotVisible),
      toBeEnabled: wrapCtx(toBeDisabled), // not enabled = disabled
      toBeDisabled: wrapCtx(toBeEnabled), // not disabled = enabled
      toBeChecked: wrapCtx(toBeNotChecked),
      toHaveText: wrapCtx(notToHaveText),
      toContainText: wrapCtx(notToContainText),
      toHaveValue: wrapCtx(notToHaveValue),
      toHaveAttribute: wrapCtx(notToHaveAttribute),
      toHaveClass: wrapCtx(notToHaveClass),
    },
  };
}
