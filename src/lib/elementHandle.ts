import { By } from './by.js';
import type { Driver } from './driver.js';
import type { WebElement } from './webelement.js';
import fs from 'fs/promises';
import path from 'path';
import yazl from 'yazl';
import { expectElementResolved } from './expect.js';
import type { ElementExpectApi } from './expect.js';
import { getKeyValue, type KeyValue } from './keys.js';
import { A11y } from './a11y.js';
import { clickWithFastPath } from './clickFastPath.js';
import { fillWithFastPath } from './fillFastPath.js';
import { clearWithFastPath } from './clearFastPath.js';
import { CraftdriverError, ErrorCode, withApiCallStack } from './errors.js';
import { DEFAULT_POLL_INTERVAL_MS } from './timing.js';
import {
  QueryEnvironment,
  createLocatorPlan,
  describeTarget,
  isDetachedShadowError,
  isTerminalQueryError,
  withShadowRetryAttempts,
  type ContextSwitcher,
  type ElementTargetPlan,
  type QueryBiDiProvider,
} from './query.js';
import { ShadowRootLocator } from './shadowRootLocator.js';

export interface ElementOptions {
  timeout?: number;
}

/**
 * Zip a single local file in memory (as Selenium's `se/file` upload
 * extension expects: one file, at the zip root, named by its own basename)
 * and return it base64-encoded, ready for `Driver.uploadFile()`. Reuses
 * `yazl` (already a runtime dependency for `vibiumTrace.ts`) rather than
 * adding a second zip approach.
 */
function zipFileToBase64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addFile(filePath, path.basename(filePath));
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    zip.end();
  });
}

export class ElementHandle {
  private target: ElementTargetPlan;
  private environment: QueryEnvironment;

  constructor(
    private driver: Driver,
    by: By,
    /** Returns the browser-level default timeout so per-call opts can fall back to it. */
    private getDefaultTimeout: () => number = () => 5000,
    environment?: QueryEnvironment,
    target?: ElementTargetPlan
  ) {
    this.environment = environment ?? new QueryEnvironment(driver);
    this.target = target ?? { kind: 'locator', plan: createLocatorPlan(by) };
  }

  /**
   * Bind this handle to a browsing context (iframe or tab).
   * Element resolution will switch into the context before finding and switch out after.
   */
  withContext(switcher: ContextSwitcher): this {
    this.environment.setContextSwitcher(switcher);
    return this;
  }

  /** Bind this handle to a live BiDi context provider. */
  withBiDi(provider: QueryBiDiProvider): this {
    this.environment.setBiDiProvider(provider);
    return this;
  }

  private async _withContext<T>(fn: () => Promise<T>, callerFn?: Function): Promise<T> {
    const run = async () => {
      return this.environment.withContext(fn);
    };
    return callerFn ? withApiCallStack(callerFn, run) : run();
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
    return ElementHandle.fromTarget(
      driver,
      { kind: 'fixed', element: webElement },
      getDefaultTimeout,
      new QueryEnvironment(driver)
    );
  }

  /** Internal factory used by locators and shadow-root search contexts. */
  static fromTarget(
    driver: Driver,
    target: ElementTargetPlan,
    getDefaultTimeout: () => number,
    environment: QueryEnvironment
  ): ElementHandle {
    return new ElementHandle(driver, By.css('*'), getDefaultTimeout, environment, target);
  }

  /** Resolve to a located (not necessarily visible) WebElement. */
  private async _resolveLocated(options?: ElementOptions): Promise<WebElement> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    let stableResolution = false;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const element = await this.environment.resolveTarget(this.target);
        stableResolution = true;
        if (element) return element;
      } catch (error) {
        if (isTerminalQueryError(error)) throw error;
        lastError = error;
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
    }
    if (!stableResolution && isDetachedShadowError(lastError)) {
      throw withShadowRetryAttempts(lastError, attempts);
    }
    throw new CraftdriverError(
      ErrorCode.NO_MATCH,
      `No element matched locator "${describeTarget(this.target)}" within ${timeout}ms`,
      {
        detail: { selector: describeTarget(this.target), queryPath: describeTarget(this.target), timeout },
        cause: lastError,
      }
    );
  }

  /** Resolve to a visible WebElement. */
  private async _resolveVisible(options?: ElementOptions): Promise<WebElement> {
    if (this.target.kind === 'fixed') return this.target.element;
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    const deadline = Date.now() + timeout;
    let everMatched = false;
    let lastError: unknown;
    let stableResolution = false;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const element = await this.environment.resolveTarget(this.target);
        stableResolution = true;
        if (element) {
          everMatched = true;
          if (await element.isDisplayed()) return element;
        }
      } catch (error) {
        if (isTerminalQueryError(error)) throw error;
        lastError = error;
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
    }
    if (!stableResolution && isDetachedShadowError(lastError)) {
      throw withShadowRetryAttempts(lastError, attempts);
    }
    const description = describeTarget(this.target);
    throw new CraftdriverError(
      everMatched ? ErrorCode.TIMEOUT_WAITING_VISIBLE : ErrorCode.NO_MATCH,
      everMatched
        ? `Timed out after ${timeout}ms waiting for locator "${description}" to become visible`
        : `No element matched locator "${description}" within ${timeout}ms`,
      { detail: { selector: description, queryPath: description, timeout }, cause: lastError }
    );
  }

  private _resolveOnce(): Promise<WebElement | null> {
    return this.environment.resolveTarget(this.target);
  }

  async click(options?: ElementOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      if (this.target.kind === 'fixed') {
        await this.target.element.click();
        return;
      }
      await clickWithFastPath(
        () => this._resolveOnce(),
        (remaining) => this._resolveVisible({ timeout: remaining }),
        timeout
      );
    }, ElementHandle.prototype.click);
  }

  async fill(text: string, options?: ElementOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      await fillWithFastPath(
        () => this._resolveOnce(),
        (remaining) => this._resolveVisible({ timeout: remaining }),
        text,
        timeout
      );
    }, ElementHandle.prototype.fill);
  }

  async clear(options?: ElementOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      await clearWithFastPath(
        () => this._resolveOnce(),
        (remaining) => this._resolveVisible({ timeout: remaining }),
        timeout
      );
    }, ElementHandle.prototype.clear);
  }

  async press(key: KeyValue, options?: ElementOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      if (this.target.kind === 'fixed') {
        await this.target.element.click();
        await this.driver.keyPressCode(getKeyValue(key), 1);
        return;
      }
      await clickWithFastPath(
        () => this._resolveOnce(),
        (remaining) => this._resolveVisible({ timeout: remaining }),
        timeout
      );
      const code = getKeyValue(key);
      await this.driver.keyPressCode(code, 1);
    }, ElementHandle.prototype.press);
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
    }, ElementHandle.prototype.screenshot);
  }

  async text(options?: ElementOptions): Promise<string> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      return el.getText();
    }, ElementHandle.prototype.text);
  }

  async value(options?: ElementOptions): Promise<string> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      const val = await el.getProperty('value');
      return String(val ?? '');
    }, ElementHandle.prototype.value);
  }

  async tagName(options?: ElementOptions): Promise<string> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      return el.getTagName();
    }, ElementHandle.prototype.tagName);
  }

  async getAttribute(name: string, options?: ElementOptions): Promise<string | null> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      return el.getAttribute(name);
    }, ElementHandle.prototype.getAttribute);
  }

  async isVisible(options?: ElementOptions): Promise<boolean> {
    try {
      return await this._withContext(async () => {
        const timeout = options?.timeout ?? Math.min(this.getDefaultTimeout(), 1000);
        const el = await this._resolveLocated({ timeout });
        return el.isDisplayed();
      }, ElementHandle.prototype.isVisible);
    } catch (error) {
      if (isTerminalQueryError(error) || isDetachedShadowError(error)) throw error;
      return false;
    }
  }

  async isEnabled(options?: ElementOptions): Promise<boolean> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      return el.isEnabled();
    }, ElementHandle.prototype.isEnabled);
  }

  async isChecked(options?: ElementOptions): Promise<boolean> {
    return this._withContext(async () => {
      const el = await this._resolveLocated(options);
      return el.isSelected();
    }, ElementHandle.prototype.isChecked);
  }

  async boundingBox(options?: ElementOptions): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      return await this._withContext(async () => {
        const el = await this._resolveLocated(options);
        return el.getRect();
      }, ElementHandle.prototype.boundingBox);
    } catch (error) {
      if (isTerminalQueryError(error) || isDetachedShadowError(error)) throw error;
      return null;
    }
  }

  async hover(options?: ElementOptions): Promise<void> {
    return this._withContext(async () => {
      const el = await this._resolveVisible(options);
      await this.driver.pointerMoveTo(el);
    }, ElementHandle.prototype.hover);
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
    }, ElementHandle.prototype.select);
  }

  expect(): ElementExpectApi {
    const description = describeTarget(this.target);
    return expectElementResolved({
      description,
      detail: { selector: description, queryPath: description },
      resolveAll: async () => {
        const element = await this.environment.resolveTarget(this.target);
        return element ? [element] : [];
      },
      getDefaultTimeout: this.getDefaultTimeout,
      withContext: (operation) => this.environment.withContext(operation),
    });
  }

  /** Cross the explicit open Shadow DOM boundary exposed by this host. */
  shadowRoot(): ShadowRootLocator {
    return new ShadowRootLocator(
      this.driver,
      { kind: 'shadow', host: this.target },
      this.getDefaultTimeout,
      this.environment
    );
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

      // Remote sessions: the caller's local path doesn't exist on the grid
      // node, so it can't be sent directly via sendKeys. Zip each file and
      // upload it through Selenium's se/file extension, then sendKeys() the
      // path(s) the remote node extracted it to. Gated on driver.isRemote()
      // so the local branch below is untouched.
      if (this.driver.isRemote()) {
        const remotePaths: string[] = [];
        for (const filePath of paths) {
          const base64Zip = await zipFileToBase64(filePath);
          remotePaths.push(await this.driver.uploadFile(base64Zip));
        }
        await el.sendKeys(remotePaths.join('\n'));
        return;
      }

      await el.sendKeys(paths.join('\n'));
    }, ElementHandle.prototype.setInputFiles);
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
    }, ElementHandle.prototype.evaluate);
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

export type { ContextSwitcher } from './query.js';
