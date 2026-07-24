import type { By } from './by.js';
import type { Driver } from './driver.js';
import type { WebElement } from './webelement.js';
import { CraftdriverError, ErrorCode } from './errors.js';
import {
  isDetachedShadowError,
  isTerminalQueryError,
  withShadowRetryAttempts,
} from './query.js';
import {
  ASSERTION_POLL_INTERVAL_MS,
  DEFAULT_ELEMENT_TIMEOUT_MS,
} from './timing.js';

/** Context switcher for frame/window scoping — used by Frame and Page. */
export type ContextSwitcher = { in: () => Promise<void>; out: () => Promise<void> };

export interface ResolvedExpectSource {
  description: string;
  detail?: Record<string, unknown>;
  resolveAll: () => Promise<WebElement[]>;
  getDefaultTimeout?: () => number;
  withContext?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Per-assertion timeout override. */
export interface AssertionOptions {
  timeout?: number;
}

export interface ResolvedDocumentExpectSource {
  description: string;
  readUrl: () => Promise<string>;
  readTitle: () => Promise<string>;
  getDefaultTimeout?: () => number;
}

/** Auto-waiting assertions for the current browser page or an explicit Page. */
export interface DocumentExpectApi {
  toHaveURL(url: string | RegExp, opts?: AssertionOptions): Promise<void>;
  toHaveTitle(title: string | RegExp, opts?: AssertionOptions): Promise<void>;
  not: {
    toHaveURL(url: string | RegExp, opts?: AssertionOptions): Promise<void>;
    toHaveTitle(title: string | RegExp, opts?: AssertionOptions): Promise<void>;
  };
}

/** Auto-waiting assertions for a single resolved element. */
export interface ElementExpectApi {
  toHaveText(text: string | RegExp, opts?: AssertionOptions): Promise<void>;
  toContainText(text: string | RegExp, opts?: AssertionOptions): Promise<void>;
  toHaveValue(value: string | RegExp, opts?: AssertionOptions): Promise<void>;
  toHaveAttribute(name: string, value?: string | RegExp, opts?: AssertionOptions): Promise<void>;
  toHaveClass(className: string, opts?: AssertionOptions): Promise<void>;
  toHaveCSS(property: string, value: string, opts?: AssertionOptions): Promise<void>;
  toBeVisible(opts?: AssertionOptions): Promise<void>;
  toBeEnabled(opts?: AssertionOptions): Promise<void>;
  toBeDisabled(opts?: AssertionOptions): Promise<void>;
  toBeChecked(opts?: AssertionOptions): Promise<void>;
  toBeFocused(opts?: AssertionOptions): Promise<void>;
  toBeInViewport(opts?: AssertionOptions): Promise<void>;
  not: {
    toBeVisible(opts?: AssertionOptions): Promise<void>;
    toBeEnabled(opts?: AssertionOptions): Promise<void>;
    toBeDisabled(opts?: AssertionOptions): Promise<void>;
    toBeChecked(opts?: AssertionOptions): Promise<void>;
    toBeFocused(opts?: AssertionOptions): Promise<void>;
    toBeInViewport(opts?: AssertionOptions): Promise<void>;
    toHaveText(text: string | RegExp, opts?: AssertionOptions): Promise<void>;
    toContainText(text: string | RegExp, opts?: AssertionOptions): Promise<void>;
    toHaveValue(value: string | RegExp, opts?: AssertionOptions): Promise<void>;
    toHaveAttribute(name: string, value?: string | RegExp, opts?: AssertionOptions): Promise<void>;
    toHaveClass(className: string, opts?: AssertionOptions): Promise<void>;
    toHaveCSS(property: string, value: string, opts?: AssertionOptions): Promise<void>;
  };
}

/** Auto-waiting assertions for a locator collection and its first element. */
export interface LocatorExpectApi extends Omit<ElementExpectApi, 'not'> {
  toHaveCount(count: number, opts?: AssertionOptions): Promise<void>;
  not: ElementExpectApi['not'] & {
    toHaveCount(count: number, opts?: AssertionOptions): Promise<void>;
  };
}

function matchValue(actual: string, expected: string | RegExp): boolean {
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    const matched = expected.test(actual);
    expected.lastIndex = 0;
    return matched;
  }
  return actual === expected;
}

/** Format an expected string/RegExp for failure messages. */
function fmt(expected: string | RegExp): string {
  return expected instanceof RegExp ? expected.toString() : `"${expected}"`;
}

export function expectDocument(source: ResolvedDocumentExpectSource): DocumentExpectApi {
  const getDefaultTimeout = source.getDefaultTimeout ?? (() => DEFAULT_ELEMENT_TIMEOUT_MS);

  function fail(message: string, callerFn: Function, detail: Record<string, unknown>): never {
    const error = new CraftdriverError(ErrorCode.EXPECT_MISMATCH, message, { detail });
    if (Error.captureStackTrace) Error.captureStackTrace(error, callerFn);
    throw error;
  }

  async function pollValue(
    read: () => Promise<string>,
    predicate: (value: string) => boolean,
    timeout: number
  ): Promise<{ matched: boolean; last: string }> {
    const deadline = Date.now() + timeout;
    let last = '';
    for (;;) {
      try {
        last = await read();
        if (predicate(last)) return { matched: true, last };
      } catch {
        // Navigation can make URL/title reads transiently unavailable. Retry.
      }
      if (Date.now() >= deadline) return { matched: false, last };
      await new Promise<void>((resolve) => setTimeout(resolve, ASSERTION_POLL_INTERVAL_MS));
    }
  }

  function matcher(
    name: 'URL' | 'title',
    matcherName: 'toHaveURL' | 'toHaveTitle',
    read: () => Promise<string>,
    negate: boolean
  ) {
    return async function documentMatcher(expected: string | RegExp, opts?: AssertionOptions) {
      const timeout = opts?.timeout ?? getDefaultTimeout();
      const { matched, last } = await pollValue(
        read,
        (actual) => negate !== matchValue(actual, expected),
        timeout
      );
      if (matched) return;
      const negation = negate ? 'not ' : '';
      fail(
        `Expected ${source.description} ${name} ${negation}to be ${fmt(expected)} but got "${last}" within ${timeout}ms`,
        documentMatcher,
        { target: source.description, matcher: `${negate ? 'not.' : ''}${matcherName}`, expected, actual: last, timeout }
      );
    };
  }

  return {
    toHaveURL: matcher('URL', 'toHaveURL', source.readUrl, false),
    toHaveTitle: matcher('title', 'toHaveTitle', source.readTitle, false),
    not: {
      toHaveURL: matcher('URL', 'toHaveURL', source.readUrl, true),
      toHaveTitle: matcher('title', 'toHaveTitle', source.readTitle, true),
    },
  };
}

export function expectSelector(
  driver: Driver,
  by: By,
  getDefaultTimeout: () => number = () => DEFAULT_ELEMENT_TIMEOUT_MS,
  contextSwitcher?: ContextSwitcher
): LocatorExpectApi {
  return expectResolved({
    description: `${by.using}(${by.value})`,
    detail: { selector: `${by.using}=${by.value}`, using: by.using, value: by.value },
    resolveAll: () => driver.findElements(by),
    getDefaultTimeout,
    withContext: contextSwitcher
      ? async <T>(operation: () => Promise<T>): Promise<T> => {
          await contextSwitcher.in();
          try {
            return await operation();
          } finally {
            await contextSwitcher.out();
          }
        }
      : undefined,
  });
}

/** Build assertions around an arbitrary root-aware element resolver. */
export function expectResolved(source: ResolvedExpectSource): LocatorExpectApi {
  const getDefaultTimeout = source.getDefaultTimeout ?? (() => DEFAULT_ELEMENT_TIMEOUT_MS);
  const description = source.description;
  function fail(message: string, callerFn?: Function, detail?: Record<string, unknown>): never {
    const error = new CraftdriverError(ErrorCode.EXPECT_MISMATCH, message, {
      detail: { ...(source.detail ?? {}), ...(detail ?? {}) },
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
   * Each iteration performs one complete resolver pass, so nested/shadow
   * locators and ordinary document locators share identical assertion scope.
   */
  async function pollElement<T>(
    read: (el: WebElement) => Promise<T>,
    predicate: (value: T) => boolean,
    timeout: number,
    onMissing: 'retry' | 'pass'
  ): Promise<{ matched: boolean; last: T | undefined }> {
    const deadline = Date.now() + timeout;
    let last: T | undefined;
    let lastError: unknown;
    let stableResolution = false;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const elements = await source.resolveAll();
        stableResolution = true;
        if (elements.length === 0) {
          if (onMissing === 'pass') return { matched: true, last };
          throw new Error('element not found');
        }
        const value = await read(elements[0]);
        last = value;
        if (predicate(value)) return { matched: true, last };
      } catch (error) {
        if (isTerminalQueryError(error)) throw error;
        lastError = error;
        if (onMissing === 'pass' && !isDetachedShadowError(error)) {
          return { matched: true, last };
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, ASSERTION_POLL_INTERVAL_MS));
    }
    if (!stableResolution && isDetachedShadowError(lastError)) {
      throw withShadowRetryAttempts(lastError, attempts);
    }
    return { matched: false, last };
  }

  const readText = async (el: WebElement): Promise<string> => (await el.getText())?.trim?.() ?? '';
  const readValue = async (el: WebElement): Promise<string> => String((await el.getProperty('value')) ?? '');
  const readClass = async (el: WebElement): Promise<string> => (await el.getAttribute('class')) ?? '';

  async function pollCount(
    predicate: (count: number) => boolean,
    timeout: number
  ): Promise<{ matched: boolean; last: number }> {
    const deadline = Date.now() + timeout;
    let last = 0;
    let lastError: unknown;
    let stableResolution = false;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        last = (await source.resolveAll()).length;
        stableResolution = true;
        if (predicate(last)) return { matched: true, last };
      } catch (error) {
        if (isTerminalQueryError(error)) throw error;
        lastError = error;
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, ASSERTION_POLL_INTERVAL_MS));
    }
    if (!stableResolution && isDetachedShadowError(lastError)) {
      throw withShadowRetryAttempts(lastError, attempts);
    }
    return { matched: false, last };
  }

  function validateCount(expected: number): void {
    if (!Number.isInteger(expected) || expected < 0) {
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `Expected count must be a non-negative integer, got ${String(expected)}`,
        { detail: { count: expected } }
      );
    }
  }

  const toHaveText = async function toHaveText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched, last } = await pollElement(readText, (t) => matchValue(t, expected), timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} to have text ${fmt(expected)} but got "${last ?? ''}"`, toHaveText);
  };

  const toContainText = async function toContainText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const contains = (t: string) => (expected instanceof RegExp ? expected.test(t) : t.includes(expected));
    const { matched, last } = await pollElement(readText, contains, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} to contain text ${fmt(expected)} but got "${last ?? ''}"`, toContainText);
  };

  const toHaveValue = async function toHaveValue(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched, last } = await pollElement(readValue, (v) => matchValue(v, expected), timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} to have value ${fmt(expected)} but got "${last ?? ''}"`, toHaveValue);
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
      fail(`Expected element ${description} to have attribute "${name}" but it was not found`, toHaveAttribute);
    }
    fail(`Expected element ${description} to have attribute "${name}" = ${fmt(value!)} but got "${last ?? null}"`, toHaveAttribute);
  };

  const toHaveClass = async function toHaveClass(
    className: string,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const hasClass = (cls: string) => cls.split(/\s+/).includes(className);
    const { matched, last } = await pollElement(readClass, hasClass, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} to have class "${className}" but got "${last ?? ''}"`, toHaveClass);
  };

  const toBeVisible = async function toBeVisible(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isDisplayed(), (visible) => visible, timeout, 'retry');
    if (!matched) fail(`Expected element ${description} to be visible within ${timeout}ms`, toBeVisible);
  };

  const toBeNotVisible = async function toBeNotVisible(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isDisplayed(), (visible) => !visible, timeout, 'pass');
    if (!matched) fail(`Expected element ${description} to become hidden within ${timeout}ms`, toBeNotVisible);
  };

  const toBeEnabled = async function toBeEnabled(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isEnabled(), (v) => v, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} to be enabled within ${timeout}ms`, toBeEnabled);
  };

  const toBeDisabled = async function toBeDisabled(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isEnabled(), (v) => !v, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} to be disabled within ${timeout}ms`, toBeDisabled);
  };

  const toBeChecked = async function toBeChecked(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isSelected(), (v) => v, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} to be checked within ${timeout}ms`, toBeChecked);
  };

  const toBeNotChecked = async function toBeNotChecked(opts?: { timeout?: number }) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isSelected(), (v) => !v, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} to not be checked within ${timeout}ms`, toBeNotChecked);
  };

  const toHaveCount = async function toHaveCount(expected: number, opts?: AssertionOptions) {
    validateCount(expected);
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched, last } = await pollCount((count) => count === expected, timeout);
    if (matched) return;
    fail(`Expected locator ${description} to have count ${expected} but got ${last}`, toHaveCount, {
      matcher: 'toHaveCount', expected, actual: last, timeout,
    });
  };

  const notToHaveCount = async function notToHaveCount(expected: number, opts?: AssertionOptions) {
    validateCount(expected);
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched, last } = await pollCount((count) => count !== expected, timeout);
    if (matched) return;
    fail(`Expected locator ${description} not to have count ${expected}`, notToHaveCount, {
      matcher: 'not.toHaveCount', expected, actual: last, timeout,
    });
  };

  const toBeFocused = async function toBeFocused(opts?: AssertionOptions) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isFocused(), (focused) => focused, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} to be focused within ${timeout}ms`, toBeFocused);
  };

  const toBeNotFocused = async function toBeNotFocused(opts?: AssertionOptions) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isFocused(), (focused) => !focused, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} not to be focused within ${timeout}ms`, toBeNotFocused);
  };

  const toHaveCSS = async function toHaveCSS(
    property: string,
    expected: string,
    opts?: AssertionOptions
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched, last } = await pollElement(
      (el) => el.getComputedCssValue(property),
      (actual) => actual === expected,
      timeout,
      'retry'
    );
    if (matched) return;
    fail(`Expected element ${description} to have computed CSS "${property}: ${expected}" but got "${last ?? ''}"`, toHaveCSS, {
      matcher: 'toHaveCSS', property, expected, actual: last, timeout,
    });
  };

  const notToHaveCSS = async function notToHaveCSS(
    property: string,
    expected: string,
    opts?: AssertionOptions
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched, last } = await pollElement(
      (el) => el.getComputedCssValue(property),
      (actual) => actual !== expected,
      timeout,
      'retry'
    );
    if (matched) return;
    fail(`Expected element ${description} not to have computed CSS "${property}: ${expected}"`, notToHaveCSS, {
      matcher: 'not.toHaveCSS', property, expected, actual: last, timeout,
    });
  };

  const toBeInViewport = async function toBeInViewport(opts?: AssertionOptions) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isInViewport(), (inViewport) => inViewport, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} to intersect the viewport within ${timeout}ms`, toBeInViewport);
  };

  const toBeNotInViewport = async function toBeNotInViewport(opts?: AssertionOptions) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement((el) => el.isInViewport(), (inViewport) => !inViewport, timeout, 'retry');
    if (matched) return;
    fail(`Expected element ${description} not to intersect the viewport within ${timeout}ms`, toBeNotInViewport);
  };

  const notToHaveText = async function notToHaveText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement(readText, (t) => !matchValue(t, expected), timeout, 'pass');
    if (matched) return;
    fail(`Expected element ${description} to NOT have text ${fmt(expected)}`, notToHaveText);
  };

  const notToContainText = async function notToContainText(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const notContains = (t: string) => (expected instanceof RegExp ? !expected.test(t) : !t.includes(expected));
    const { matched } = await pollElement(readText, notContains, timeout, 'pass');
    if (matched) return;
    fail(`Expected element ${description} to NOT contain text ${fmt(expected)}`, notToContainText);
  };

  const notToHaveValue = async function notToHaveValue(
    expected: string | RegExp,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const { matched } = await pollElement(readValue, (v) => !matchValue(v, expected), timeout, 'pass');
    if (matched) return;
    fail(`Expected element ${description} to NOT have value ${fmt(expected)}`, notToHaveValue);
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
      fail(`Expected element ${description} to NOT have attribute "${name}"`, notToHaveAttribute);
    }
    fail(`Expected element ${description} to NOT have attribute "${name}" = ${fmt(value!)}`, notToHaveAttribute);
  };

  const notToHaveClass = async function notToHaveClass(
    className: string,
    opts?: { timeout?: number }
  ) {
    const timeout = opts?.timeout ?? getDefaultTimeout();
    const lacksClass = (cls: string) => !cls.split(/\s+/).includes(className);
    const { matched } = await pollElement(readClass, lacksClass, timeout, 'pass');
    if (matched) return;
    fail(`Expected element ${description} to NOT have class "${className}"`, notToHaveClass);
  };

  // Wrap all methods with context switching if the source is context-bound.
  function wrapCtx<T extends (...args: any[]) => Promise<any>>(fn: T): T {
    if (!source.withContext) return fn;
    return (async (...args: Parameters<T>) => {
      return source.withContext!(() => (fn as any)(...args));
    }) as T;
  }

  return {
    toHaveText: wrapCtx(toHaveText),
    toContainText: wrapCtx(toContainText),
    toHaveValue: wrapCtx(toHaveValue),
    toHaveAttribute: wrapCtx(toHaveAttribute),
    toHaveClass: wrapCtx(toHaveClass),
    toHaveCount: wrapCtx(toHaveCount),
    toHaveCSS: wrapCtx(toHaveCSS),
    toBeVisible: wrapCtx(toBeVisible),
    toBeEnabled: wrapCtx(toBeEnabled),
    toBeDisabled: wrapCtx(toBeDisabled),
    toBeChecked: wrapCtx(toBeChecked),
    toBeFocused: wrapCtx(toBeFocused),
    toBeInViewport: wrapCtx(toBeInViewport),
    not: {
      toBeVisible: wrapCtx(toBeNotVisible),
      toBeEnabled: wrapCtx(toBeDisabled), // not enabled = disabled
      toBeDisabled: wrapCtx(toBeEnabled), // not disabled = enabled
      toBeChecked: wrapCtx(toBeNotChecked),
      toBeFocused: wrapCtx(toBeNotFocused),
      toBeInViewport: wrapCtx(toBeNotInViewport),
      toHaveText: wrapCtx(notToHaveText),
      toContainText: wrapCtx(notToContainText),
      toHaveValue: wrapCtx(notToHaveValue),
      toHaveAttribute: wrapCtx(notToHaveAttribute),
      toHaveClass: wrapCtx(notToHaveClass),
      toHaveCount: wrapCtx(notToHaveCount),
      toHaveCSS: wrapCtx(notToHaveCSS),
    },
  };
}

/** Build element assertions without collection-only matchers such as toHaveCount(). */
export function expectElementResolved(source: ResolvedExpectSource): ElementExpectApi {
  const api = expectResolved(source);
  const { toHaveCount: _toHaveCount, not: allNot, ...elementApi } = api;
  const { toHaveCount: _notToHaveCount, ...elementNot } = allNot;
  return { ...elementApi, not: elementNot };
}
