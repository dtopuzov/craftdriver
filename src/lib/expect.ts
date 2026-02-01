import type { By } from './by.js';
import type { Driver } from './driver.js';
import { until } from './wait.js';

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

export function expectSelector(driver: Driver, by: By): ExpectApi {
  function fail(message: string, callerFn?: Function): never {
    const error = new Error(message);
    // Remove internal expect.ts frames from stack trace so test file line shows first
    if (callerFn && Error.captureStackTrace) {
      Error.captureStackTrace(error, callerFn);
    }
    throw error;
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
        if (matchValue(text, expected)) return;
      } catch {
        // retry
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const exp = expected instanceof RegExp ? `/${expected.source}/` : `"${expected}"`;
    fail(`Expected element ${by.using}(${by.value}) to have text ${exp} but got "${last}"`, toHaveText);
  };

  const toContainText = async function toContainText(
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
        if (expected instanceof RegExp ? expected.test(text) : text.includes(expected)) return;
      } catch {
        // retry
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const exp = expected instanceof RegExp ? `/${expected.source}/` : `"${expected}"`;
    fail(`Expected element ${by.using}(${by.value}) to contain text ${exp} but got "${last}"`, toContainText);
  };

  const toHaveValue = async function toHaveValue(
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
        const val = await found.getProperty('value');
        last = String(val ?? '');
        if (matchValue(last, expected)) return;
      } catch {
        // retry
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const exp = expected instanceof RegExp ? `/${expected.source}/` : `"${expected}"`;
    fail(`Expected element ${by.using}(${by.value}) to have value ${exp} but got "${last}"`, toHaveValue);
  };

  const toHaveAttribute = async function toHaveAttribute(
    name: string,
    value?: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    let last: string | null = null;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        last = await found.getAttribute(name);
        if (value === undefined) {
          // Just check attribute exists
          if (last !== null) return;
        } else {
          if (last !== null && matchValue(last, value)) return;
        }
      } catch {
        // retry
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (value === undefined) {
      fail(`Expected element ${by.using}(${by.value}) to have attribute "${name}" but it was not found`, toHaveAttribute);
    }
    const exp = value instanceof RegExp ? `/${value.source}/` : `"${value}"`;
    fail(`Expected element ${by.using}(${by.value}) to have attribute "${name}" = ${exp} but got "${last}"`, toHaveAttribute);
  };

  const toHaveClass = async function toHaveClass(
    className: string,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    let last = '';
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        const cls = await found.getAttribute('class');
        last = cls ?? '';
        const classes = last.split(/\s+/);
        if (classes.includes(className)) return;
      } catch {
        // retry
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    fail(`Expected element ${by.using}(${by.value}) to have class "${className}" but got "${last}"`, toHaveClass);
  };

  const toBeVisible = async function toBeVisible(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? 5000;
    try {
      await driver.wait(until.elementIsVisible(by), { timeout });
    } catch {
      fail(`Expected element ${by.using}(${by.value}) to be visible within ${timeout}ms`, toBeVisible);
    }
  };

  const toBeNotVisible = async function toBeNotVisible(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? 5000;
    try {
      await driver.wait(until.elementIsNotVisible(by), { timeout });
    } catch {
      fail(`Expected element ${by.using}(${by.value}) to become hidden within ${timeout}ms`, toBeNotVisible);
    }
  };

  const toBeEnabled = async function toBeEnabled(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        if (await found.isEnabled()) return;
      } catch {
        // retry
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    fail(`Expected element ${by.using}(${by.value}) to be enabled within ${timeout}ms`, toBeEnabled);
  };

  const toBeDisabled = async function toBeDisabled(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        if (!(await found.isEnabled())) return;
      } catch {
        // retry
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    fail(`Expected element ${by.using}(${by.value}) to be disabled within ${timeout}ms`, toBeDisabled);
  };

  const toBeChecked = async function toBeChecked(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        if (await found.isSelected()) return;
      } catch {
        // retry
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    fail(`Expected element ${by.using}(${by.value}) to be checked within ${timeout}ms`, toBeChecked);
  };

  const toBeNotChecked = async function toBeNotChecked(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        if (!(await found.isSelected())) return;
      } catch {
        // retry
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    fail(`Expected element ${by.using}(${by.value}) to not be checked within ${timeout}ms`, toBeNotChecked);
  };

  const notToHaveText = async function notToHaveText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        const text = (await found.getText())?.trim?.() ?? '';
        if (!matchValue(text, expected)) return;
      } catch {
        return; // element not found = text doesn't match
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const exp = expected instanceof RegExp ? `/${expected.source}/` : `"${expected}"`;
    fail(`Expected element ${by.using}(${by.value}) to NOT have text ${exp}`, notToHaveText);
  };

  const notToContainText = async function notToContainText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        const text = (await found.getText())?.trim?.() ?? '';
        if (expected instanceof RegExp ? !expected.test(text) : !text.includes(expected)) return;
      } catch {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const exp = expected instanceof RegExp ? `/${expected.source}/` : `"${expected}"`;
    fail(`Expected element ${by.using}(${by.value}) to NOT contain text ${exp}`, notToContainText);
  };

  const notToHaveValue = async function notToHaveValue(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        const val = String(await found.getProperty('value') ?? '');
        if (!matchValue(val, expected)) return;
      } catch {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const exp = expected instanceof RegExp ? `/${expected.source}/` : `"${expected}"`;
    fail(`Expected element ${by.using}(${by.value}) to NOT have value ${exp}`, notToHaveValue);
  };

  const notToHaveAttribute = async function notToHaveAttribute(
    name: string,
    value?: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        const attr = await found.getAttribute(name);
        if (value === undefined) {
          if (attr === null) return;
        } else {
          if (attr === null || !matchValue(attr, value)) return;
        }
      } catch {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (value === undefined) {
      fail(`Expected element ${by.using}(${by.value}) to NOT have attribute "${name}"`, notToHaveAttribute);
    }
    const exp = value instanceof RegExp ? `/${value.source}/` : `"${value}"`;
    fail(`Expected element ${by.using}(${by.value}) to NOT have attribute "${name}" = ${exp}`, notToHaveAttribute);
  };

  const notToHaveClass = async function notToHaveClass(
    className: string,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? 5000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        await driver.wait(until.elementExists(by), { timeout: Math.min(250, timeout) });
        const found = await driver.findElement(by);
        const cls = await found.getAttribute('class') ?? '';
        const classes = cls.split(/\s+/);
        if (!classes.includes(className)) return;
      } catch {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    fail(`Expected element ${by.using}(${by.value}) to NOT have class "${className}"`, notToHaveClass);
  };

  return {
    toHaveText,
    toContainText,
    toHaveValue,
    toHaveAttribute,
    toHaveClass,
    toBeVisible,
    toBeEnabled,
    toBeDisabled,
    toBeChecked,
    not: {
      toBeVisible: toBeNotVisible,
      toBeEnabled: toBeDisabled, // not enabled = disabled
      toBeDisabled: toBeEnabled, // not disabled = enabled
      toBeChecked: toBeNotChecked,
      toHaveText: notToHaveText,
      toContainText: notToContainText,
      toHaveValue: notToHaveValue,
      toHaveAttribute: notToHaveAttribute,
      toHaveClass: notToHaveClass,
    },
  };
}
