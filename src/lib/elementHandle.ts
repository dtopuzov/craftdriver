import { By } from './by.js';
import type { Driver } from './driver.js';
import type { WebElement } from './webelement.js';
import { until } from './wait.js';
import fs from 'fs/promises';
import { expectSelector } from './expect.js';
import { getKeyValue, type KeyValue } from './keys.js';
import { A11y } from './a11y.js';
import { clickWithFastPath } from './clickFastPath.js';
import { fillWithFastPath } from './fillFastPath.js';
import { clearWithFastPath } from './clearFastPath.js';

export interface ElementOptions {
  timeout?: number;
}

export type ContextSwitcher = { in: () => Promise<void>; out: () => Promise<void> };

export class ElementHandle {
  /** Set only for snapshot handles created via `ElementHandle.fromWebElement()`. */
  private _webElement?: WebElement;

  /** Optional context switcher for frame/window scoping. */
  private _contextSwitcher?: ContextSwitcher;

  constructor(
    private driver: Driver,
    private by: By,
    /** Returns the browser-level default timeout so per-call opts can fall back to it. */
    private getDefaultTimeout: () => number = () => 5000
  ) { }

  /**
   * Bind this handle to a browsing context (iframe or tab).
   * Element resolution will switch into the context before finding and switch out after.
   */
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

  /**
   * Create a snapshot `ElementHandle` backed by an already-resolved WebElement.
   * Used by `Locator.all()` and `Browser.findAll()`.
   */
  static fromWebElement(
    driver: Driver,
    webElement: WebElement,
    getDefaultTimeout: () => number
  ): ElementHandle {
    const handle = new ElementHandle(driver, By.css('*'), getDefaultTimeout);
    handle._webElement = webElement;
    return handle;
  }

  /** Resolve to a located (not necessarily visible) WebElement. */
  private async _resolveLocated(options?: ElementOptions): Promise<WebElement> {
    if (this._webElement) return this._webElement;
    return this.driver.wait(until.elementLocated(this.by), {
      timeout: options?.timeout ?? this.getDefaultTimeout(),
    });
  }

  /** Resolve to a visible WebElement. */
  private async _resolveVisible(options?: ElementOptions): Promise<WebElement> {
    if (this._webElement) return this._webElement;
    return this.driver.wait(until.elementIsVisible(this.by), {
      timeout: options?.timeout ?? this.getDefaultTimeout(),
    });
  }

  async click(options?: ElementOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      if (this._webElement) {
        await this._webElement.click();
        return;
      }
      await clickWithFastPath(
        () => this.driver.findElement(this.by),
        (remaining) => this._resolveVisible({ timeout: remaining }),
        timeout
      );
    });
  }

  async fill(text: string, options?: ElementOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      await fillWithFastPath(
        () => this._webElement
          ? Promise.resolve(this._webElement)
          : this.driver.findElement(this.by),
        (remaining) => this._resolveVisible({ timeout: remaining }),
        text,
        timeout
      );
    });
  }

  async clear(options?: ElementOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      await clearWithFastPath(
        () => this._webElement
          ? Promise.resolve(this._webElement)
          : this.driver.findElement(this.by),
        (remaining) => this._resolveVisible({ timeout: remaining }),
        timeout
      );
    });
  }

  async press(key: KeyValue, options?: ElementOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      if (this._webElement) {
        await this._webElement.click();
      } else {
        await clickWithFastPath(
          () => this.driver.findElement(this.by),
          (remaining) => this._resolveVisible({ timeout: remaining }),
          timeout
        );
      }
      const code = getKeyValue(key);
      await this.driver.keyPressCode(code, 1);
    });
  }

  /**
   * Capture a screenshot of just this element. Optionally writes the PNG
   * to `opts.path`. Returns the raw PNG buffer.
   *
   * @example
   * const buf = await browser.find('#chart').screenshot();
   * await browser.find('#logo').screenshot({ path: 'logo.png' });
   */
  async screenshot(opts?: ElementOptions & { path?: string }): Promise<Buffer> {
    return this._withContext(async () => {
      const el = await this._resolveVisible(opts);
      const b64 = await el.screenshotBase64();
      const buf = Buffer.from(b64, 'base64');
      if (opts?.path) await fs.writeFile(opts.path, buf);
      return buf;
    });
  }

  async text(options?: ElementOptions): Promise<string> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      return el.getText();
    });
  }

  async value(options?: ElementOptions): Promise<string> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      const val = await el.getProperty('value');
      return String(val ?? '');
    });
  }

  async tagName(options?: ElementOptions): Promise<string> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      return el.getTagName();
    });
  }

  async getAttribute(name: string, options?: ElementOptions): Promise<string | null> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      return el.getAttribute(name);
    });
  }

  async isVisible(options?: ElementOptions): Promise<boolean> {
    try {
      return await this._withContext(async () => {
        const timeout = options?.timeout ?? Math.min(this.getDefaultTimeout(), 1000);
        const el = await this._resolveLocated({ timeout });
        return el.isDisplayed();
      });
    } catch {
      return false;
    }
  }

  async isEnabled(options?: ElementOptions): Promise<boolean> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      return el.isEnabled();
    });
  }

  async isChecked(options?: ElementOptions): Promise<boolean> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      return el.isSelected();
    });
  }

  async boundingBox(options?: ElementOptions): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      return await this._withContext(async () => {
        const el = await this._resolveLocated(options);
        return el.getRect();
      });
    } catch {
      return null;
    }
  }

  async hover(options?: ElementOptions): Promise<void> {
    return this._withContext(async () => {
      const el = await this._resolveVisible(options);
      await this.driver.pointerMoveTo(el);
    });
  }

  async select(value: string, options?: ElementOptions): Promise<void> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);

      const tagName = await el.getTagName();
      if (tagName !== 'select') {
        throw new Error(
          `select() can only be used on <select> elements. Found <${tagName}> instead. ` +
          `Use browser.click('#selector option[value="..."]') for other element types.`
        );
      }

      const script = `
        const select = arguments[0];
        const value = arguments[1];
        const option = Array.from(select.options).find(opt => opt.value === value);
        if (!option) {
          throw new Error('Option with value "' + value + '" not found in <select>');
        }
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `;

      await this.driver.executeScript(script, [el, value]);
    });
  }

  expect() {
    return expectSelector(this.driver, this.by, this.getDefaultTimeout, this._contextSwitcher);
  }

  /**
   * Set the value of an `<input type="file">` element.
   * Accepts a single path or an array (for `multiple` inputs).
   * Paths must be absolute and point to existing files.
   *
   * @throws if the element is not an `<input type="file">`.
   */
  async setInputFiles(filePaths: string | string[], options?: ElementOptions): Promise<void> {
    return this._withContext(async () => {
      const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
      const el = await this._resolveLocated(options);

      const tagName = await el.getTagName();
      if (tagName.toLowerCase() !== 'input') {
        throw new Error(
          `setInputFiles() requires an <input type="file"> element. Found <${tagName}> instead.`
        );
      }
      const type = await el.getAttribute('type');
      if ((type ?? '').toLowerCase() !== 'file') {
        throw new Error(
          `setInputFiles() requires an <input type="file"> element. ` +
          `Found <input type="${type ?? ''}"> instead.`
        );
      }

      await el.sendKeys(paths.join('\n'));
    });
  }

  /**
   * Execute JavaScript in the page with this element as the first argument.
   *
   * ```ts
   * const tag = await browser.find('#btn').evaluate(el => el.tagName);
   * const text = await browser.find('#btn').evaluate((el, cls) => el.classList.contains(cls), 'active');
   * ```
   *
   * Uses Classic WebDriver `executeScript` so it works with or without BiDi.
   */
  async evaluate<T = unknown>(
    fn: (el: unknown, ...args: unknown[]) => T,
    ...args: unknown[]
  ): Promise<T> {
    return this._withContext(async () => {
      const el = await this._resolveLocated();
      const fnSrc = fn.toString();
      return this.driver.executeScript<T>(
        `return (${fnSrc}).apply(null, arguments)`,
        [el, ...args]
      );
    });
  }

  private _a11y?: A11y;
  /**
   * Element-scoped accessibility audit via axe-core.
   * The audit is restricted to this element and its descendants.
   */
  get a11y(): A11y {
    if (!this._a11y) {
      this._a11y = new A11y({
        driver: this.driver,
        resolveTarget: () => this._resolveLocated(),
        withContext: (fn) => this._withContext(fn),
      });
    }
    return this._a11y;
  }
}
