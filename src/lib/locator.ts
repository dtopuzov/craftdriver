import { By } from './by.js';
import type { Driver } from './driver.js';
import type { WebElement } from './webelement.js';
import { ElementHandle } from './elementHandle.js';
import { expectResolved } from './expect.js';
import type { ExpectApi } from './expect.js';
import { A11y } from './a11y.js';
import { CraftdriverError, ErrorCode } from './errors.js';
import { DEFAULT_POLL_INTERVAL_MS } from './timing.js';
import { clickWithFastPath } from './clickFastPath.js';
import { fillWithFastPath } from './fillFastPath.js';
import {
  QueryEnvironment,
  cloneLocatorPlan,
  createLocatorPlan,
  describeLocatorPlan,
  isDetachedShadowError,
  isTerminalQueryError,
  withShadowRetryAttempts,
  type ContextSwitcher,
  type ElementTargetPlan,
  type LocatorPlan,
  type QueryBiDiProvider,
} from './query.js';
import { ShadowRootLocator } from './shadowRootLocator.js';

export interface ActionOptions {
  timeout?: number;
}

export class Locator {
  private plan: LocatorPlan;
  private environment: QueryEnvironment;

  constructor(
    private driver: Driver,
    by: By,
    private getDefaultTimeout: () => number = () => 5000,
    environment?: QueryEnvironment,
    plan?: LocatorPlan
  ) {
    this.environment = environment ?? new QueryEnvironment(driver);
    this.plan = plan ?? createLocatorPlan(by);
  }

  /** Internal factory used by root-aware search contexts. */
  static fromPlan(
    driver: Driver,
    plan: LocatorPlan,
    getDefaultTimeout: () => number,
    environment: QueryEnvironment
  ): Locator {
    return new Locator(driver, plan.by, getDefaultTimeout, environment, plan);
  }

  /** Internal immutable snapshot for child/root/filter composition. */
  _queryPlan(): LocatorPlan {
    return cloneLocatorPlan(this.plan);
  }

  /** Internal shared query environment for child/root composition. */
  _queryEnvironment(): QueryEnvironment {
    return this.environment;
  }

  /** Bind this locator to a browsing context (iframe/tab). */
  withContext(switcher: ContextSwitcher): this {
    this.environment.setContextSwitcher(switcher);
    return this;
  }

  /** Bind this locator to a live BiDi context provider. */
  withBiDi(provider: QueryBiDiProvider): this {
    this.environment.setBiDiProvider(provider);
    return this;
  }

  private _withContext<T>(fn: () => Promise<T>): Promise<T> {
    return this.environment.withContext(fn);
  }

  /** Return a new child Locator scoped within this locator's first match. */
  locator(selector: string | By): Locator {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const plan = createLocatorPlan(by, {
      kind: 'element',
      target: { kind: 'locator', plan: this._queryPlan() },
    });
    return Locator.fromPlan(this.driver, plan, this.getDefaultTimeout, this.environment);
  }

  /** Cross the explicit open Shadow DOM boundary exposed by the current host. */
  shadowRoot(): ShadowRootLocator {
    return new ShadowRootLocator(
      this.driver,
      { kind: 'shadow', host: { kind: 'locator', plan: this._queryPlan() } },
      this.getDefaultTimeout,
      this.environment
    );
  }

  getByRole(
    role: string,
    opts?: { name?: string; exact?: boolean; includeHidden?: boolean }
  ): Locator {
    return this.locator(By.role(role, opts));
  }

  getByText(text: string, opts?: { exact?: boolean }): Locator {
    return this.locator(By.text(text, opts));
  }

  getByLabel(text: string, opts?: { exact?: boolean }): Locator {
    return this.locator(By.labelText(text, opts));
  }

  getByPlaceholder(text: string, opts?: { exact?: boolean }): Locator {
    return this.locator(By.placeholder(text, opts));
  }

  getByAltText(text: string, opts?: { exact?: boolean }): Locator {
    return this.locator(By.altText(text, opts));
  }

  getByTitle(text: string, opts?: { exact?: boolean }): Locator {
    return this.locator(By.title(text, opts));
  }

  getByTestId(id: string): Locator {
    return this.locator(By.testId(id));
  }

  nth(index: number): Locator {
    const locator = this._clone();
    locator.plan.index = index;
    return locator;
  }

  first(): Locator {
    return this.nth(0);
  }

  last(): Locator {
    const locator = this._clone();
    locator.plan.index = 'last';
    return locator;
  }

  filter(opts: { hasText?: string | RegExp; has?: Locator }): Locator {
    const locator = this._clone();
    if (opts.hasText !== undefined) locator.plan.filterText = opts.hasText;
    if (opts.has !== undefined) locator.plan.filterHas = opts.has._queryPlan();
    return locator;
  }

  private _clone(): Locator {
    return Locator.fromPlan(
      this.driver,
      cloneLocatorPlan(this.plan),
      this.getDefaultTimeout,
      this.environment
    );
  }

  private _target(): ElementTargetPlan {
    return { kind: 'locator', plan: this._queryPlan() };
  }

  private _findFinal(): Promise<WebElement[]> {
    return this.environment.resolveAll(this.plan);
  }

  private _selectorDetail(): Record<string, unknown> {
    const by = this.plan.by;
    return {
      selector: describeLocatorPlan(this.plan),
      queryPath: describeLocatorPlan(this.plan),
      using: by.using,
      value: by.value,
    };
  }

  private async _waitForVisible(timeout: number): Promise<WebElement> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    let everMatched = false;
    let stableResolution = false;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const elements = await this._findFinal();
        stableResolution = true;
        if (elements.length > 0) everMatched = true;
        for (const element of elements) {
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
    const queryPath = describeLocatorPlan(this.plan);
    const detail = { ...this._selectorDetail(), timeout };
    if (everMatched) {
      throw new CraftdriverError(
        ErrorCode.TIMEOUT_WAITING_VISIBLE,
        `Timed out after ${timeout}ms waiting for locator "${queryPath}" to become visible (element exists but is not displayed)`,
        {
          detail,
          cause: lastError,
          hint: 'The element matched but never became visible — wait for the containing view (modal, accordion, etc.) to open first.',
        }
      );
    }
    throw new CraftdriverError(
      ErrorCode.NO_MATCH,
      `No element matched locator "${queryPath}" within ${timeout}ms`,
      {
        detail,
        cause: lastError,
        hint: 'Selector matched zero elements. Verify the selector against the page; consider By.role / By.testId / By.labelText for resilience.',
      }
    );
  }

  private async _waitForAny(timeout: number): Promise<WebElement> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    let stableResolution = false;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const elements = await this._findFinal();
        stableResolution = true;
        if (elements.length > 0) return elements[0];
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
    const queryPath = describeLocatorPlan(this.plan);
    const detail = { ...this._selectorDetail(), timeout };
    throw new CraftdriverError(
      ErrorCode.NO_MATCH,
      `No element matched locator "${queryPath}" within ${timeout}ms`,
      {
        detail,
        cause: lastError,
        hint: 'Selector matched zero elements. Verify the selector against the page; consider By.role / By.testId / By.labelText for resilience.',
      }
    );
  }

  private _resolve(options?: ActionOptions): Promise<WebElement> {
    return this._waitForVisible(options?.timeout ?? this.getDefaultTimeout());
  }

  private async _resolveOnce(): Promise<WebElement | null> {
    return (await this._findFinal())[0] ?? null;
  }

  private _resolveExisting(options?: ActionOptions): Promise<WebElement> {
    return this._waitForAny(options?.timeout ?? this.getDefaultTimeout());
  }

  async click(options?: ActionOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      await clickWithFastPath(
        () => this._resolveOnce(),
        (remaining) => this._waitForVisible(remaining),
        timeout
      );
    });
  }

  async fill(text: string, options?: ActionOptions): Promise<void> {
    const timeout = options?.timeout ?? this.getDefaultTimeout();
    return this._withContext(async () => {
      await fillWithFastPath(
        () => this._resolveOnce(),
        (remaining) => this._waitForVisible(remaining),
        text,
        timeout
      );
    });
  }

  async text(options?: ActionOptions): Promise<string> {
    return this._withContext(async () => (await this._resolveExisting(options)).getText());
  }

  async textContent(options?: ActionOptions): Promise<string> {
    return this.text(options);
  }

  async isVisible(options?: ActionOptions): Promise<boolean> {
    try {
      return await this._withContext(async () => {
        const timeout = options?.timeout ?? Math.min(this.getDefaultTimeout(), 1000);
        return (await this._waitForAny(timeout)).isDisplayed();
      });
    } catch (error) {
      if (isTerminalQueryError(error) || isDetachedShadowError(error)) throw error;
      return false;
    }
  }

  async count(): Promise<number> {
    return this._withContext(async () => (await this._findFinal()).length);
  }

  async all(): Promise<ElementHandle[]> {
    return this._withContext(async () => {
      const elements = await this._findFinal();
      return elements.map((element) =>
        ElementHandle.fromTarget(
          this.driver,
          { kind: 'fixed', element },
          this.getDefaultTimeout,
          this.environment
        )
      );
    });
  }

  waitFor(options: {
    state: 'attached' | 'detached' | 'visible' | 'hidden';
    timeout?: number;
  }): Promise<unknown> {
    return this._withContext(async () => {
      const timeout = options.timeout ?? this.getDefaultTimeout();
      if (options.state === 'visible') return this._waitForVisible(timeout);
      if (options.state === 'attached') return this._waitForAny(timeout);
      if (options.state === 'detached' || options.state === 'hidden') {
        return this._waitForNegativeState(options.state, timeout);
      }
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `Unknown waitFor state: "${String(options.state)}". Expected one of: attached, detached, visible, hidden.`,
        { detail: { state: options.state } }
      );
    });
  }

  private async _waitForNegativeState(
    state: 'detached' | 'hidden',
    timeout: number
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        const elements = await this._findFinal();
        if (state === 'detached' && elements.length === 0) return;
        if (state === 'hidden') {
          let anyVisible = false;
          for (const element of elements) {
            if (await element.isDisplayed()) {
              anyVisible = true;
              break;
            }
          }
          if (!anyVisible) return;
        }
      } catch (error) {
        if (isTerminalQueryError(error)) throw error;
        if (isDetachedShadowError(error) && state === 'detached') return;
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
    }
    throw new CraftdriverError(
      ErrorCode.TIMEOUT_WAITING_STATE,
      `Timed out after ${timeout}ms waiting for locator "${describeLocatorPlan(this.plan)}" to become ${state}`,
      { detail: { ...this._selectorDetail(), state, timeout } }
    );
  }

  expect(): ExpectApi {
    return expectResolved({
      description: describeLocatorPlan(this.plan),
      detail: this._selectorDetail(),
      resolveAll: () => this._findFinal(),
      getDefaultTimeout: this.getDefaultTimeout,
      withContext: (operation) => this._withContext(operation),
    });
  }

  private _a11y?: A11y;
  get a11y(): A11y {
    if (!this._a11y) {
      this._a11y = new A11y({
        driver: this.driver,
        resolveTarget: () => this._resolve(),
        withContext: (operation) => this._withContext(operation),
      });
    }
    return this._a11y;
  }
}

export type { ContextSwitcher } from './query.js';
