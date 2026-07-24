/**
 * Frame — represents a nested browsing context (iframe).
 *
 * Obtain via `browser.frame(selector)` or `browser.frames()`.
 * All element methods (click, fill, find, locator, expect, evaluate, waitForLoadState)
 * are automatically scoped to the iframe's browsing context.
 *
 * BiDi path: actions target the child browsing context directly via context id.
 * Classic fallback: switchToFrame → action → switchToFrame(null).
 */

import { By } from './by.js';
import { Driver } from './driver.js';
import { ElementHandle, type ContextSwitcher } from './elementHandle.js';
import { Locator } from './locator.js';
import { expectSelector } from './expect.js';
import type { LocatorExpectApi } from './expect.js';
import { until } from './wait.js';
import type { WebElement } from './webelement.js';
import type { BiDiConnection } from './bidi/connection.js';
import type { ScriptEvaluateResult, RemoteValue } from './bidi/types.js';
import { DEFAULT_NAVIGATION_TIMEOUT_MS, STATE_POLL_INTERVAL_MS } from './timing.js';
import { clickWithFastPath } from './clickFastPath.js';
import { fillWithFastPath } from './fillFastPath.js';
import { withRealmRetry } from './bidi/evaluate.js';

type LoadState = 'load' | 'domcontentloaded';

/** Shape of a BiDi `browsingContext.getTree` entry. */
interface BidiContextInfo {
  context: string;
  url: string;
  children?: BidiContextInfo[];
}

export class Frame {
  private driver: Driver;
  private getDefaultTimeout: () => number;
  private contextSwitcher: ContextSwitcher;

  /**
   * BiDi context id of the iframe (only set in BiDi mode).
   * Used for evaluate / waitForLoadState.
   */
  private bidiContextId?: string;
  private conn?: BiDiConnection;

  constructor(
    driver: Driver,
    private frameElementId: string,
    getDefaultTimeout: () => number,
    opts?: { bidiContextId?: string; conn?: BiDiConnection }
  ) {
    this.driver = driver;
    this.getDefaultTimeout = getDefaultTimeout;
    this.bidiContextId = opts?.bidiContextId;
    this.conn = opts?.conn;

    this.contextSwitcher = {
      in: async () => {
        await this.driver.switchToFrame({ elementId: this.frameElementId });
      },
      out: async () => {
        await this.driver.switchToFrame(null);
      },
    };
  }

  // ── Element methods ──────────────────────────────────────────────────────

  find(selector: string | By): ElementHandle {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return new ElementHandle(this.driver, by, this.getDefaultTimeout)
      .withContext(this.contextSwitcher)
      .withBiDi(() =>
        this.conn?.isConnected() && this.bidiContextId
          ? { connection: this.conn, contextId: this.bidiContextId }
          : undefined
      );
  }

  locator(selector: string | By): Locator {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return new Locator(this.driver, by, this.getDefaultTimeout)
      .withContext(this.contextSwitcher)
      .withBiDi(() =>
        this.conn?.isConnected() && this.bidiContextId
          ? { connection: this.conn, contextId: this.bidiContextId }
          : undefined
      );
  }

  expect(selector: string | By): LocatorExpectApi {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return expectSelector(this.driver, by, this.getDefaultTimeout, this.contextSwitcher);
  }

  async findAll(selector: string | By): Promise<ElementHandle[]> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.contextSwitcher.in();
    let webElements: WebElement[];
    try {
      webElements = await this.driver.findElements(by);
    } finally {
      await this.contextSwitcher.out();
    }
    return webElements.map((we) =>
      ElementHandle.fromWebElement(this.driver, we, this.getDefaultTimeout)
        .withContext(this.contextSwitcher)
        .withBiDi(() =>
          this.conn?.isConnected() && this.bidiContextId
            ? { connection: this.conn, contextId: this.bidiContextId }
            : undefined
        )
    );
  }

  async click(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const timeout = opts?.timeout ?? this.getDefaultTimeout();
    await this.contextSwitcher.in();
    try {
      await clickWithFastPath(
        () => this.driver.findElement(by),
        (remaining) => this.driver.wait(until.elementIsVisible(by), { timeout: remaining }),
        timeout
      );
    } finally {
      await this.contextSwitcher.out();
    }
  }

  async fill(selector: string | By, text: string, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const timeout = opts?.timeout ?? this.getDefaultTimeout();
    await this.contextSwitcher.in();
    try {
      await fillWithFastPath(
        () => this.driver.findElement(by),
        (remaining) => this.driver.wait(until.elementIsVisible(by), { timeout: remaining }),
        text,
        timeout
      );
    } finally {
      await this.contextSwitcher.out();
    }
  }

  async getValue(selector: string | By, opts?: { timeout?: number }): Promise<string> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.contextSwitcher.in();
    try {
      const el = await this.driver.wait(until.elementLocated(by), {
        timeout: opts?.timeout ?? this.getDefaultTimeout(),
      });
      const val = await el.getProperty('value');
      return String(val ?? '');
    } finally {
      await this.contextSwitcher.out();
    }
  }

  async getAttribute(selector: string | By, name: string, opts?: { timeout?: number }): Promise<string | null> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.contextSwitcher.in();
    try {
      const el = await this.driver.wait(until.elementLocated(by), {
        timeout: opts?.timeout ?? this.getDefaultTimeout(),
      });
      return await el.getAttribute(name);
    } finally {
      await this.contextSwitcher.out();
    }
  }

  // ── Evaluate ─────────────────────────────────────────────────────────────

  async evaluate<T = unknown>(
    fn: ((...args: unknown[]) => T) | string,
    ...args: unknown[]
  ): Promise<T> {
    const fnSrc = typeof fn === 'function' ? fn.toString() : fn;

    const conn = this.conn;
    const bidiContextId = this.bidiContextId;
    if (conn && bidiContextId) {
      const target: Record<string, unknown> = { context: bidiContextId };
      const result = await withRealmRetry(() => {
        if (typeof fn === 'function') {
          return conn.send<ScriptEvaluateResult>('script.callFunction', {
            functionDeclaration: fnSrc,
            target,
            arguments: args.map(serializeLocalValue),
            awaitPromise: true,
          });
        }
        return conn.send<ScriptEvaluateResult>('script.callFunction', {
          functionDeclaration: `function() { ${fnSrc} }`,
          target,
          arguments: [],
          awaitPromise: true,
        });
      });
      if (result.type === 'exception') {
        throw new Error(
          `evaluate() threw an exception in the frame: ${result.exceptionDetails?.text ?? 'unknown error'}`
        );
      }
      if (!result.result) return undefined as T;
      return unwrapRemoteValue(result.result) as T;
    }

    // Classic fallback: switch to frame, execute, switch back
    await this.contextSwitcher.in();
    try {
      if (typeof fn === 'function') {
        return await this.driver.executeScript<T>(
          `return (${fnSrc}).apply(null, Array.from(arguments))`,
          args
        );
      }
      return await this.driver.executeScript<T>(fn, args);
    } finally {
      await this.contextSwitcher.out();
    }
  }

  // ── waitForLoadState ──────────────────────────────────────────────────────

  async waitForLoadState(
    state: LoadState = 'load',
    opts?: { timeout?: number }
  ): Promise<void> {
    const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;

    if (this.conn && this.bidiContextId) {
      const ctxId = this.bidiContextId;
      const readyState = await this.evaluate<string>('return document.readyState');
      const satisfied = state === 'load'
        ? readyState === 'complete'
        : readyState === 'interactive' || readyState === 'complete';
      if (satisfied) return;

      const eventName = state === 'load' ? 'browsingContext.load' : 'browsingContext.domContentLoaded';
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`frame.waitForLoadState('${state}') timed out after ${timeout}ms`));
        }, timeout);
        const off = this.conn!.on(eventName, (params: Record<string, unknown>) => {
          if (params.context === ctxId) {
            clearTimeout(timer);
            off();
            resolve();
          }
        });
      });
    }

    // Classic fallback: poll readyState inside the frame
    await this.contextSwitcher.in();
    const deadline = Date.now() + timeout;
    try {
      while (Date.now() < deadline) {
        const readyState = await this.driver.executeScript<string>('return document.readyState', []);
        if (readyState === 'complete' || (state === 'domcontentloaded' && readyState === 'interactive')) {
          return;
        }
        await new Promise(r => setTimeout(r, STATE_POLL_INTERVAL_MS));
      }
      throw new Error(`frame.waitForLoadState('${state}') timed out after ${timeout}ms`);
    } finally {
      await this.contextSwitcher.out();
    }
  }

  // ── URL / title ───────────────────────────────────────────────────────────

  async url(): Promise<string> {
    return this.evaluate<string>('return location.href');
  }

  async title(): Promise<string> {
    return this.evaluate<string>('return document.title');
  }
}

// ── BiDi serialization helpers (copied from browser.ts to avoid circular imports) ──

function serializeLocalValue(v: unknown): Record<string, unknown> {
  if (v === undefined) return { type: 'undefined' };
  if (v === null) return { type: 'null' };
  if (typeof v === 'string') return { type: 'string', value: v };
  if (typeof v === 'boolean') return { type: 'boolean', value: v };
  if (typeof v === 'bigint') return { type: 'bigint', value: String(v) };
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { type: 'number', value: 'NaN' };
    if (v === Infinity) return { type: 'number', value: 'Infinity' };
    if (v === -Infinity) return { type: 'number', value: '-Infinity' };
    if (Object.is(v, -0)) return { type: 'number', value: '-0' };
    return { type: 'number', value: v };
  }
  if (Array.isArray(v)) return { type: 'array', value: v.map(serializeLocalValue) };
  if (typeof v === 'object') {
    return {
      type: 'object',
      value: Object.entries(v as Record<string, unknown>).map(
        ([k, val]) => [k, serializeLocalValue(val)]
      ),
    };
  }
  throw new Error(`evaluate() argument of type "${typeof v}" is not JSON-serializable.`);
}

function unwrapRemoteValue(v: RemoteValue): unknown {
  switch (v.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': return v.value;
    case 'boolean': return v.value;
    case 'bigint': return BigInt(v.value);
    case 'number': {
      if (v.value === 'NaN') return NaN;
      if (v.value === 'Infinity') return Infinity;
      if (v.value === '-Infinity') return -Infinity;
      if (v.value === '-0') return -0;
      return v.value;
    }
    case 'array': return (v.value ?? []).map(unwrapRemoteValue);
    case 'object':
      return Object.fromEntries(
        (v.value ?? []).map(([k, val]) => [
          typeof k === 'string' ? k : String(unwrapRemoteValue(k as RemoteValue)),
          unwrapRemoteValue(val),
        ])
      );
    case 'date': return new Date(v.value);
    default: return null;
  }
}
