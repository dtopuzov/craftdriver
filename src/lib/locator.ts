import { By } from './by.js';
import type { Driver } from './driver.js';
import type { WebElement } from './webelement.js';
import { ElementHandle, type ContextSwitcher } from './elementHandle.js';
import { expectSelector } from './expect.js';
import type { ExpectApi } from './expect.js';
import { A11y } from './a11y.js';
import { CraftdriverError, ErrorCode } from './errors.js';
import { DEFAULT_POLL_INTERVAL_MS } from './timing.js';
import { clickWithFastPath } from './clickFastPath.js';
import { fillWithFastPath } from './fillFastPath.js';

export interface ActionOptions {
  timeout?: number;
}

export class Locator {
  private _index: number | null = null;        // null=first, -1=last, >=0 = nth(index)
  private _filterText: string | RegExp | null = null;
  private _filterHas: Locator | null = null;
  private _parent: Locator | null = null;
  private _contextSwitcher?: ContextSwitcher;

  constructor(
    private driver: Driver,
    private by: By,
    private getDefaultTimeout: () => number = () => 5000
  ) { }

  /** Bind this locator to a browsing context (iframe/tab) for frame-scoped element resolution. */
  withContext(switcher: ContextSwitcher): this {
    this._contextSwitcher = switcher;
    return this;
  }

  private async _withContext<T>(fn: () => Promise<T>): Promise<T> {
    if (this._contextSwitcher) {
      await this._contextSwitcher.in();
      try {
        return await fn();
      } finally {
        await this._contextSwitcher.out();
      }
    }
    return fn();
  }

  /** Return a new child Locator whose search is scoped within this locator's first match. */
  locator(selector: string | By): Locator {
    const childBy = typeof selector === 'string' ? By.css(selector) : selector;
    const child = new Locator(this.driver, childBy, this.getDefaultTimeout);
    child._parent = this;
    child._contextSwitcher = this._contextSwitcher;
    return child;
  }

  /** Return a new Locator targeting the element at position `index` (0-based). */
  nth(index: number): Locator {
    const l = this._clone();
    l._index = index;
    return l;
  }

  /** Return a new Locator targeting the first match. */
  first(): Locator {
    return this.nth(0);
  }

  /** Return a new Locator targeting the last match. */
  last(): Locator {
    const l = this._clone();
    l._index = -1;
    return l;
  }

  /** Return a new Locator that narrows matches by text or child-locator presence. */
  filter(opts: { hasText?: string | RegExp; has?: Locator }): Locator {
    const l = this._clone();
    if (opts.hasText !== undefined) l._filterText = opts.hasText;
    if (opts.has !== undefined) l._filterHas = opts.has;
    return l;
  }

  private _clone(): Locator {
    const l = new Locator(this.driver, this.by, this.getDefaultTimeout);
    l._index = this._index;
    l._filterText = this._filterText;
    l._filterHas = this._filterHas;
    l._parent = this._parent;
    l._contextSwitcher = this._contextSwitcher;
    return l;
  }

  /** Resolve all raw WebElements for this.by, scoped to the parent if set. */
  private async _findRaw(): Promise<WebElement[]> {
    if (this._parent) {
      const parentEls = await this._parent._findFinal();
      if (parentEls.length === 0) return [];
      return parentEls[0].findElements(this.by);
    }
    return this.driver.findElements(this.by);
  }

  /** Apply text / has filters to the raw result set. */
  private async _findFiltered(): Promise<WebElement[]> {
    let elements = await this._findRaw();

    if (this._filterText !== null) {
      const pattern = this._filterText;
      const texts = await Promise.all(elements.map((el) => el.getText()));
      elements = elements.filter((_, i) => {
        const t = texts[i];
        return pattern instanceof RegExp ? pattern.test(t) : t.includes(String(pattern));
      });
    }

    if (this._filterHas !== null) {
      const hasBy = this._filterHas.by;
      const kept: WebElement[] = [];
      for (const el of elements) {
        const children = await el.findElements(hasBy);
        if (children.length > 0) kept.push(el);
      }
      elements = kept;
    }

    return elements;
  }

  /** Apply index on top of the filtered result set. */
  private async _findFinal(): Promise<WebElement[]> {
    const els = await this._findFiltered();
    const idx = this._index;
    if (idx === -1) return els.length > 0 ? [els[els.length - 1]] : [];
    if (idx !== null) return els.length > idx ? [els[idx]] : [];
    return els;
  }

  /** Poll until a visible element is available in the final result set. */
  private async _waitForVisible(timeout: number): Promise<WebElement> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    let everMatched = false;
    while (Date.now() < deadline) {
      try {
        const els = await this._findFinal();
        if (els.length > 0) everMatched = true;
        for (const el of els) {
          if (await el.isDisplayed()) return el;
        }
      } catch (e) {
        lastError = e;
      }
      await new Promise<void>((r) => setTimeout(r, DEFAULT_POLL_INTERVAL_MS));
    }
    const selector = `${this.by.using}=${this.by.value}`;
    if (everMatched) {
      throw new CraftdriverError(
        ErrorCode.TIMEOUT_WAITING_VISIBLE,
        `Timed out after ${timeout}ms waiting for locator "${selector}" to become visible (element exists but is not displayed)`,
        {
          detail: { selector, timeout, using: this.by.using, value: this.by.value },
          cause: lastError,
          hint: 'The element matched but never became visible — wait for the containing view (modal, accordion, etc.) to open first.',
        }
      );
    }
    throw new CraftdriverError(
      ErrorCode.NO_MATCH,
      `No element matched locator "${selector}" within ${timeout}ms`,
      {
        detail: { selector, timeout, using: this.by.using, value: this.by.value },
        cause: lastError,
        hint: 'Selector matched zero elements. Verify the selector against the page; consider By.role / By.testId / By.labelText for resilience.',
      }
    );
  }

  /** Poll until any element is present in the final result set (need not be visible). */
  private async _waitForAny(timeout: number): Promise<WebElement> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const els = await this._findFinal();
        if (els.length > 0) return els[0];
      } catch (e) {
        lastError = e;
      }
      await new Promise<void>((r) => setTimeout(r, DEFAULT_POLL_INTERVAL_MS));
    }
    const selector = `${this.by.using}=${this.by.value}`;
    throw new CraftdriverError(
      ErrorCode.NO_MATCH,
      `No element matched locator "${selector}" within ${timeout}ms`,
      {
        detail: { selector, timeout, using: this.by.using, value: this.by.value },
        cause: lastError,
        hint: 'Selector matched zero elements. Verify the selector against the page; consider By.role / By.testId / By.labelText for resilience.',
      }
    );
  }

  private async _resolve(options?: ActionOptions): Promise<WebElement> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._waitForVisible(timeout);
  }

  /** Resolve the current final match once without waiting. */
  private async _resolveOnce(): Promise<WebElement | null> {
    const els = await this._findFinal();
    return els.length > 0 ? els[0] : null;
  }

  private async _resolveExisting(options?: ActionOptions): Promise<WebElement> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._waitForAny(timeout);
  }

  /**
   * Resolve to a visible element WITHOUT applying context switching (used inside _withContext blocks).
   * The caller is responsible for switching context before calling this.
   */
  private async _waitForVisibleOrSimple(options?: ActionOptions): Promise<WebElement> {
    return this._resolve(options);
  }

  /**
   * Resolve to an existing element WITHOUT applying context switching (used inside _withContext blocks).
   * The caller is responsible for switching context before calling this.
   */
  private async _waitForAnyOrSimple(options?: ActionOptions): Promise<WebElement> {
    return this._resolveExisting(options);
  }

  async click(options?: ActionOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      await clickWithFastPath(
        () => this._resolveOnce(),
        (remaining) => this._waitForVisibleOrSimple({ timeout: remaining }),
        timeout
      );
    });
  }

  async fill(text: string, options?: ActionOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      await fillWithFastPath(
        () => this._resolveOnce(),
        (remaining) => this._waitForVisibleOrSimple({ timeout: remaining }),
        text,
        timeout
      );
    });
  }

  async text(options?: ActionOptions): Promise<string> {
    return this._withContext(async () => {
      const el = await this._waitForAnyOrSimple(options);
      return (await el.getText()) ?? '';
    });
  }

  /** Alias for text(). */
  async textContent(options?: ActionOptions): Promise<string> {
    return this.text(options);
  }

  async isVisible(options?: ActionOptions): Promise<boolean> {
    try {
      return await this._withContext(async () => {
        const timeout = options?.timeout ?? Math.min(this.getDefaultTimeout(), 1000);
        const el = await this._waitForAnyOrSimple({ timeout });
        return el.isDisplayed();
      });
    } catch {
      return false;
    }
  }

  /**
   * Returns the number of currently matching elements in the DOM (no auto-wait).
   * Use `waitFor` if you need to wait for a specific count.
   */
  async count(): Promise<number> {
    return this._withContext(async () => {
      const els = await this._findFinal();
      return els.length;
    });
  }

  /**
   * Returns snapshot `ElementHandle`s for all currently matching elements.
   * Each handle is bound to the element resolved at call time.
   */
  async all(): Promise<ElementHandle[]> {
    return this._withContext(async () => {
      const els = await this._findFinal();
      return els.map((we) => {
        const handle = ElementHandle.fromWebElement(this.driver, we, this.getDefaultTimeout);
        if (this._contextSwitcher) handle.withContext(this._contextSwitcher);
        return handle;
      });
    });
  }

  waitFor(options: {
    state: 'attached' | 'detached' | 'visible' | 'hidden';
    timeout?: number;
  }): Promise<unknown> {
    return this._withContext(async () => {
      const { state } = options;
      const timeout = options.timeout ?? this.getDefaultTimeout();
      if (state === 'visible') return this._waitForVisible(timeout);
      if (state === 'attached') return this._waitForAny(timeout);
      if (state === 'detached' || state === 'hidden') {
        return this._waitForNegativeState(state, timeout);
      }
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `Unknown waitFor state: "${state}". Expected one of: attached, detached, visible, hidden.`,
        { detail: { state } }
      );
    });
  }

  /** Poll until the element is detached from DOM (`detached`) or no longer visible (`hidden`). */
  private async _waitForNegativeState(
    state: 'detached' | 'hidden',
    timeout: number
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const els = await this._findFinal();
      if (state === 'detached') {
        if (els.length === 0) return;
      } else {
        // 'hidden': pass when nothing matches or no match is displayed.
        let anyVisible = false;
        for (const el of els) {
          if (await el.isDisplayed()) { anyVisible = true; break; }
        }
        if (!anyVisible) return;
      }
      await new Promise<void>((r) => setTimeout(r, DEFAULT_POLL_INTERVAL_MS));
    }
    const selector = `${this.by.using}=${this.by.value}`;
    throw new CraftdriverError(
      ErrorCode.TIMEOUT_WAITING_STATE,
      `Timed out after ${timeout}ms waiting for locator "${selector}" to become ${state}`,
      { detail: { selector, state, timeout } }
    );
  }

  /** Returns an assertion API scoped to this locator's selector. */
  expect(): ExpectApi {
    return expectSelector(this.driver, this.by, this.getDefaultTimeout, this._contextSwitcher);
  }

  private _a11y?: A11y;
  /**
   * Accessibility audit scoped to the resolved element. Re-resolves the
   * locator on every audit/check call.
   */
  get a11y(): A11y {
    if (!this._a11y) {
      this._a11y = new A11y({
        driver: this.driver,
        resolveTarget: () => this._resolve(),
        withContext: (fn) => this._withContext(fn),
      });
    }
    return this._a11y;
  }
}
