/**
 * Page — a top-level browsing context (a tab or a popup window).
 *
 * Maps 1-to-1 onto a WebDriver BiDi top-level `browsingContext`. Obtain via
 * `browser.openPage()`, `browser.pages()`, or `browser.waitForPage()`.
 * All element methods are automatically scoped to this page.
 *
 * BiDi path: actions target the page's browsing-context id directly.
 * Classic fallback: switchToWindow → action (window switch is permanent until switched back).
 */

import { By } from './by.js';
import { Driver } from './driver.js';
import { ElementHandle } from './elementHandle.js';
import { Locator } from './locator.js';
import { expectSelector } from './expect.js';
import type { ExpectApi } from './expect.js';
import { until } from './wait.js';
import type { WebElement } from './webelement.js';
import type { BiDiConnection } from './bidi/connection.js';
import type { ScriptEvaluateResult, RemoteValue } from './bidi/types.js';
import { DEFAULT_NAVIGATION_TIMEOUT_MS, STATE_POLL_INTERVAL_MS } from './timing.js';
import type { BrowserContext } from './browserContext.js';
import { CraftdriverError, ErrorCode } from './errors.js';

type LoadState = 'load' | 'domcontentloaded' | 'networkidle' | 'none';

export class Page {
  private driver: Driver;
  private getDefaultTimeout: () => number;

  /**
   * BiDi browsing-context id (in BiDi mode) **or** window handle (Classic mode).
   */
  private contextId: string;
  private conn?: BiDiConnection;
  /** Owning user context. Set when the page was created via a BrowserContext. */
  private _owner?: BrowserContext;

  constructor(
    driver: Driver,
    contextId: string,
    getDefaultTimeout: () => number,
    conn?: BiDiConnection,
    owner?: BrowserContext
  ) {
    this.driver = driver;
    this.contextId = contextId;
    this.getDefaultTimeout = getDefaultTimeout;
    this.conn = conn;
    this._owner = owner;
  }

  /**
   * The {@link BrowserContext} this page belongs to.
   *
   * Always defined in BiDi mode — pages created via `browser.openPage()`,
   * `browser.waitForPage()`, `browser.pages()`, and `browser.activePage()`
   * report `browser.defaultContext`; pages created via a non-default
   * context report that context. Only `undefined` for pages obtained from
   * the Classic-mode fallbacks where user contexts don't exist.
   */
  context(): BrowserContext | undefined {
    return this._owner;
  }

  /** Switch the Classic driver to this window for element operations. */
  private async _activate(): Promise<string> {
    const prev = await this.driver.getCurrentWindowHandle();
    if (prev !== this.contextId) {
      await this.driver.switchToWindow(this.contextId);
    }
    return prev;
  }

  /** Switch back to the previous window after a Classic action. */
  private async _restoreTo(handle: string): Promise<void> {
    if (handle !== this.contextId) {
      await this.driver.switchToWindow(handle);
    }
  }

  private async _withWindow<T>(fn: () => Promise<T>): Promise<T> {
    const prev = await this._activate();
    try {
      return await fn();
    } finally {
      await this._restoreTo(prev);
    }
  }

  private hasInitScriptsForNavigation(): boolean {
    return this._owner?._hasInitScriptsForNavigation() ?? false;
  }

  // ── URL / title / navigation ──────────────────────────────────────────────

  async url(): Promise<string> {
    if (this.conn) {
      const tree = await this.conn.send<{ contexts: Array<{ context: string; url: string }> }>(
        'browsingContext.getTree',
        { root: this.contextId }
      );
      return tree.contexts?.[0]?.url ?? '';
    }
    return this._withWindow(() => this.driver.getCurrentUrl());
  }

  async title(): Promise<string> {
    if (this.conn) {
      return this.evaluate<string>('return document.title');
    }
    return this._withWindow(() => this.driver.getTitle());
  }

  /**
   * @param opts.waitUntil  Load state to wait for. Defaults to `'load'`.
   *   `'load'` on a default-context page is Classic-first unless a preload
   *   script is active. Classic navigateTo() already blocks until
   *   `document.readyState === 'complete'`; preload-backed pages stay on BiDi
   *   so the navigation and the next BiDi script evaluation observe the same
   *   document lifecycle. `'none'` and `'domcontentloaded'` require BiDi;
   *   `'networkidle'` isn't available at the Page level — use
   *   `browser.waitForLoadState('networkidle')`.
   */
  async navigateTo(
    url: string,
    opts?: { waitUntil?: Exclude<LoadState, 'networkidle'> }
  ): Promise<void> {
    const resolved = this._resolveUrl(url);
    const waitUntil = opts?.waitUntil ?? 'load';

    // Classic's window-handle APIs only reliably reach pages in the default
    // BiDi user context, and preload-backed pages benefit from keeping
    // navigation on the same protocol that installed/evaluates those scripts.
    // All other default-context 'load' navigations keep the Classic fast path.
    const isDefaultContext = !this._owner || this._owner.id === 'default';
    const needsBiDi =
      waitUntil !== 'load' ||
      !isDefaultContext ||
      this.hasInitScriptsForNavigation();

    if (this.conn && needsBiDi) {
      const bidiWait =
        waitUntil === 'none' ? 'none'
          : waitUntil === 'domcontentloaded' ? 'interactive'
            : 'complete'; // 'load' on non-default/preload-backed contexts
      await this.conn.send('browsingContext.navigate', {
        context: this.contextId,
        url: resolved,
        wait: bidiWait,
      });
      return;
    }

    // Classic path — default-context 'load', or no BiDi connection. BiDi
    // context ids equal Classic window handles for top-level contexts (see
    // `_makeContextSwitcher()` below), so `_withWindow` works here too.
    await this._withWindow(async () => {
      await this.driver.navigateTo(resolved);
    });
  }

  /**
   * Resolve `url` against the owning context's `baseURL`, if any.
   * Absolute URLs are returned as-is.
   */
  private _resolveUrl(url: string): string {
    const baseURL = this._owner?.baseURL;
    if (!baseURL) return url;
    try {
      // If `url` is already absolute this returns it unchanged.
      return new URL(url, baseURL).href;
    } catch {
      return url;
    }
  }

  /**
   * Navigate back one step in this page's session history.
   * BiDi: `browsingContext.traverseHistory({ delta: -1 })`.
   * Classic fallback: `POST /session/{id}/back` (per-window switch).
   */
  async goBack(): Promise<void> {
    if (this.conn) {
      await this.conn.send('browsingContext.traverseHistory', {
        context: this.contextId,
        delta: -1,
      });
      return;
    }
    await this._withWindow(() => this.driver.back());
  }

  /**
   * Navigate forward one step in this page's session history.
   * BiDi: `browsingContext.traverseHistory({ delta: +1 })`.
   * Classic fallback: `POST /session/{id}/forward`.
   */
  async goForward(): Promise<void> {
    if (this.conn) {
      await this.conn.send('browsingContext.traverseHistory', {
        context: this.contextId,
        delta: 1,
      });
      return;
    }
    await this._withWindow(() => this.driver.forward());
  }

  /**
   * Reload this page.
   * BiDi: `browsingContext.reload` waiting for `complete`.
   * Classic fallback: `POST /session/{id}/refresh`.
   */
  async reload(): Promise<void> {
    if (this.conn) {
      await this.conn.send('browsingContext.reload', {
        context: this.contextId,
        wait: 'complete',
      });
      return;
    }
    await this._withWindow(() => this.driver.refresh());
  }

  async waitForLoadState(
    state: Exclude<LoadState, 'none' | 'networkidle'> = 'load',
    opts?: { timeout?: number }
  ): Promise<void> {
    const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    if (this.conn) {
      const readyState = await this.evaluate<string>('return document.readyState');
      const satisfied = state === 'load'
        ? readyState === 'complete'
        : readyState === 'interactive' || readyState === 'complete';
      if (satisfied) return;

      const eventName = state === 'load' ? 'browsingContext.load' : 'browsingContext.domContentLoaded';
      const ctxId = this.contextId;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error(`waitForLoadState timed out after ${timeout}ms`)); }, timeout);
        const off = this.conn!.on(eventName, (params: Record<string, unknown>) => {
          if (params.context === ctxId) { clearTimeout(timer); off(); resolve(); }
        });
      });
    }

    // Classic
    return this._withWindow(async () => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const rs = await this.driver.executeScript<string>('return document.readyState', []);
        if (rs === 'complete' || (state === 'domcontentloaded' && rs === 'interactive')) return;
        await new Promise(r => setTimeout(r, STATE_POLL_INTERVAL_MS));
      }
      throw new CraftdriverError(
        ErrorCode.TIMEOUT_WAITING_LOAD,
        `waitForLoadState timed out after ${timeout}ms`,
        { detail: { state, timeout } }
      );
    });
  }

  // ── Evaluate ─────────────────────────────────────────────────────────────

  async evaluate<T = unknown>(
    fn: ((...args: unknown[]) => T) | string,
    ...args: unknown[]
  ): Promise<T> {
    const fnSrc = typeof fn === 'function' ? fn.toString() : fn;

    if (this.conn) {
      const target: Record<string, unknown> = { context: this.contextId };
      let result: ScriptEvaluateResult;
      if (typeof fn === 'function') {
        result = await this.conn.send<ScriptEvaluateResult>('script.callFunction', {
          functionDeclaration: fnSrc,
          target,
          arguments: args.map(serializeLocalValue),
          awaitPromise: true,
        });
      } else {
        result = await this.conn.send<ScriptEvaluateResult>('script.callFunction', {
          functionDeclaration: `function() { ${fnSrc} }`,
          target,
          arguments: [],
          awaitPromise: true,
        });
      }
      if (result.type === 'exception') {
        throw new CraftdriverError(
          ErrorCode.EVAL_THREW,
          `evaluate() threw an exception: ${result.exceptionDetails?.text ?? 'unknown error'}`,
          { detail: { exception: result.exceptionDetails?.text ?? null } }
        );
      }
      if (!result.result) return undefined as T;
      return unwrapRemoteValue(result.result) as T;
    }

    return this._withWindow(async () => {
      if (typeof fn === 'function') {
        return this.driver.executeScript<T>(`return (${fnSrc}).apply(null, Array.from(arguments))`, args);
      }
      return this.driver.executeScript<T>(fn, args);
    });
  }

  // ── Content ──────────────────────────────────────────────────────────────

  /**
   * Return the full HTML serialization of the page (`document.documentElement.outerHTML`).
   */
  async content(): Promise<string> {
    return this.evaluate<string>('return document.documentElement.outerHTML');
  }

  /**
   * Replace the page contents with the given HTML and wait until the
   * specified load state is reached.
   *
   * Implementation: navigates to a `data:text/html` URL so the new
   * document goes through a real navigation (load events fire correctly).
   *
   * @param html  The HTML document to load.
   * @param opts.waitUntil  Load state to wait for. Defaults to `'load'`.
   */
  async setContent(
    html: string,
    opts?: { waitUntil?: Exclude<LoadState, 'networkidle'> }
  ): Promise<void> {
    const waitUntil = opts?.waitUntil ?? 'load';
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    if (this.conn) {
      const bidiWait =
        waitUntil === 'none' ? 'none'
          : waitUntil === 'domcontentloaded' ? 'interactive'
            : 'complete';
      await this.conn.send('browsingContext.navigate', {
        context: this.contextId,
        url,
        wait: bidiWait,
      });
      return;
    }
    await this._withWindow(async () => {
      await this.driver.navigateTo(url);
    });
  }

  // ── Element methods ──────────────────────────────────────────────────────

  private _makeContextSwitcher() {
    // Always switch Classic window to this context for element operations.
    // In Chrome, BiDi context IDs equal Classic window handles.
    let savedHandle: string;
    return {
      in: async () => {
        savedHandle = await this._activate();
      },
      out: async () => {
        await this._restoreTo(savedHandle);
      },
    };
  }

  find(selector: string | By): ElementHandle {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const handle = new ElementHandle(this.driver, by, this.getDefaultTimeout);
    const sw = this._makeContextSwitcher();
    if (sw) handle.withContext(sw);
    return handle;
  }

  locator(selector: string | By): Locator {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const loc = new Locator(this.driver, by, this.getDefaultTimeout);
    const sw = this._makeContextSwitcher();
    if (sw) loc.withContext(sw);
    return loc;
  }

  expect(selector: string | By): ExpectApi {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return expectSelector(this.driver, by, this.getDefaultTimeout, this._makeContextSwitcher());
  }

  async findAll(selector: string | By): Promise<ElementHandle[]> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const webElements = await this._withWindow(() => this.driver.findElements(by));
    const sw = this._makeContextSwitcher();
    return webElements.map((we) => {
      const handle = ElementHandle.fromWebElement(this.driver, we, this.getDefaultTimeout);
      if (sw) handle.withContext(sw);
      return handle;
    });
  }

  async click(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return this._withWindow(async () => {
      const el = await this.driver.wait(until.elementIsVisible(by), {
        timeout: opts?.timeout ?? this.getDefaultTimeout(),
      });
      await el.click();
    });
  }

  async fill(selector: string | By, text: string, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return this._withWindow(async () => {
      const el = await this.driver.wait(until.elementIsVisible(by), {
        timeout: opts?.timeout ?? this.getDefaultTimeout(),
      });
      await el.click();
      await el.clear();
      await el.sendKeys(text);
    });
  }

  /** Return the BiDi browsing-context id (or Classic window handle) for this page. */
  id(): string {
    return this.contextId;
  }
}

// ── BiDi serialization helpers ───────────────────────────────────────────────

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
  throw new CraftdriverError(
    ErrorCode.EVAL_BAD_ARG,
    `evaluate() argument of type "${typeof v}" is not JSON-serializable.`,
    { detail: { argType: typeof v } }
  );
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
