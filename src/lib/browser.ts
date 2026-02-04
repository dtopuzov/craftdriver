import { Builder } from './builder.js';
import { ChromeService } from './chrome.js';
import { Driver } from './driver.js';
import { By } from './by.js';
import { Condition, WaitOptions, until } from './wait.js';
import { ElementHandle } from './elementHandle.js';
import { expectSelector } from './expect.js';
import fs from 'fs/promises';
import { KeyboardController } from './keyboard.js';
import { Key } from './keys.js';
import { MouseController } from './mouse.js';
import { ActionsBuilder } from './actions.js';
import { Capabilities } from './types.js';
import {
  BiDiSession,
  NetworkInterceptor,
  LogMonitor,
  SessionStateManager,
  type SessionState,
  type StorageStateOptions,
} from './bidi/index.js';

export interface LaunchOptions {
  browserName?: 'chrome' | 'chromium' | 'firefox' | 'edge' | 'safari';
  chromeService?: ChromeService;
  /** Enable BiDi features (network interception, logs, etc.) */
  enableBiDi?: boolean;
  /** Load session state from file on launch */
  storageState?: string;
}

export class Browser {
  private bidiSession?: BiDiSession;
  private _network?: NetworkInterceptor;
  private _logs?: LogMonitor;
  private _storage?: SessionStateManager;

  private constructor(private driver: Driver) {
    this.keyboard = new KeyboardController(this.driver);
    this.mouse = new MouseController(this.driver);
  }

  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const name = options.browserName ?? 'chrome';
    let chromeService: ChromeService;
    if (options.chromeService) {
      chromeService = options.chromeService;
    } else {
      chromeService = new ChromeService();
    }

    // Handle headless mode via env var
    const headlessEnv = process.env.HEADLESS;
    const isHeadless = headlessEnv === 'true' || headlessEnv === '1';

    // Base capabilities
    const chromeOptions: Record<string, unknown> = {
      args: isHeadless ? ['--headless=new'] : [],
    };

    // Request webSocketUrl for BiDi if enabled
    let caps: Capabilities = {
      'goog:chromeOptions': chromeOptions,
    };

    if (options.enableBiDi !== false) {
      // Request BiDi WebSocket URL
      caps.webSocketUrl = true;
    }

    const builder = new Builder().forBrowser(name).setChromeService(chromeService);
    builder.withCapabilities(caps);
    const driver = await builder.build();
    const browser = new Browser(driver);

    // Initialize BiDi session if WebSocket URL available
    const wsUrl = (driver as any).__wsUrl;
    if (wsUrl && options.enableBiDi !== false) {
      await browser.initBiDi(wsUrl);
    }

    // Load session state if provided
    if (options.storageState) {
      await browser.loadState(options.storageState);
    }

    return browser;
  }

  /**
   * Initialize BiDi WebSocket connection
   */
  private async initBiDi(wsUrl: string): Promise<void> {
    this.bidiSession = new BiDiSession(this.driver);
    try {
      await this.bidiSession.connect(wsUrl);
    } catch (err) {
      // BiDi connection failed, continue with Classic-only mode
      console.warn('BiDi connection failed, using Classic WebDriver only:', err);
      this.bidiSession = undefined;
    }
  }

  /**
   * Check if BiDi features are available
   */
  isBiDiEnabled(): boolean {
    return this.bidiSession?.isConnected() ?? false;
  }

  // === BiDi Feature Accessors ===

  /**
   * Network interception API (BiDi)
   * Mock, intercept, and modify network requests
   */
  get network(): NetworkInterceptor {
    if (!this._network) {
      if (!this.bidiSession?.isConnected()) {
        throw new Error('Network interception requires BiDi. Launch with enableBiDi: true');
      }
      this._network = this.bidiSession.network;
    }
    return this._network;
  }

  /**
   * Console/error log monitoring (BiDi)
   */
  get logs(): LogMonitor {
    if (!this._logs) {
      if (!this.bidiSession?.isConnected()) {
        throw new Error('Log monitoring requires BiDi. Launch with enableBiDi: true');
      }
      this._logs = this.bidiSession.logs;
    }
    return this._logs;
  }

  /**
   * Session state management (cookies, localStorage)
   * Works with both BiDi and Classic WebDriver
   */
  get storage(): SessionStateManager {
    if (!this._storage) {
      this._storage = new SessionStateManager(
        this.driver,
        this.bidiSession?.isConnected() ? this.bidiSession.getConnection() : null
      );
    }
    return this._storage;
  }

  /**
   * Save current session state (cookies + localStorage) to file
   */
  async saveState(path: string, options?: StorageStateOptions): Promise<SessionState> {
    return this.storage.saveState(path, options);
  }

  /**
   * Load session state from file
   */
  async loadState(path: string): Promise<void> {
    return this.storage.loadState(path);
  }

  async navigateTo(url: string): Promise<void> {
    return this.driver.navigateTo(url);
  }

  async url(): Promise<string> {
    return this.driver.getCurrentUrl();
  }

  async title(): Promise<string> {
    return this.driver.getTitle();
  }

  wait<T>(condition: Condition<T>, options?: WaitOptions & { message?: string }): Promise<T>;
  wait<T>(
    condition: Condition<T>,
    timeoutMs?: number,
    intervalMs?: number,
    message?: string
  ): Promise<T>;
  wait<T>(condition: Condition<T>, a?: any, b?: any, c?: any): Promise<T> {
    return (this.driver as any).wait(condition, a, b, c);
  }

  async quit(): Promise<void> {
    // Close BiDi connection first
    if (this.bidiSession) {
      await this.bidiSession.close().catch(() => { });
    }
    await this.driver.quit();
  }

  async click(selector: string | By): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementIsVisible(by), { timeout: 5000 });
    await el.click();
  }

  async fill(
    selector: string | By,
    text: string,
    opts?: { timeout?: number }
  ): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementIsVisible(by), {
      timeout: opts?.timeout ?? 5000,
    });
    await el.click();
    await el.clear();
    await el.sendKeys(text);
  }

  async clear(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementIsVisible(by), {
      timeout: opts?.timeout ?? 5000,
    });
    await el.clear();
  }

  async getValue(selector: string | By, opts?: { timeout?: number }): Promise<string> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementLocated(by), {
      timeout: opts?.timeout ?? 5000,
    });
    const val = await el.getProperty('value');
    return String(val ?? '');
  }

  async getAttribute(selector: string | By, name: string, opts?: { timeout?: number }): Promise<string | null> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementLocated(by), {
      timeout: opts?.timeout ?? 5000,
    });
    return await el.getAttribute(name);
  }

  gesture = {
    swipe: async ({
      from,
      to,
      durationMs = 300,
    }: {
      from: [number, number];
      to: [number, number];
      durationMs?: number;
    }) => {
      await this.driver.performTouchSwipe(from, to, durationMs);
    },
    pinch: async ({
      center,
      scale = 0.5,
      distance = 100,
      durationMs = 250,
    }: {
      center: [number, number];
      scale?: number;
      distance?: number;
      durationMs?: number;
    }) => {
      await this.driver.performTouchPinch(center, scale, distance, durationMs);
    },
  };

  // Capture a screenshot. If selectorOrBy provided, capture element; else full page. Returns raw buffer.
  async screenshot(selectorOrBy?: string | By): Promise<Buffer> {
    if (selectorOrBy) {
      const by = typeof selectorOrBy === 'string' ? By.css(selectorOrBy) : selectorOrBy;
      const el = await this.driver.wait(until.elementIsVisible(by), { timeout: 5000 });
      const b64 = await el.screenshotBase64();
      return Buffer.from(b64, 'base64');
    }
    const b64 = await this.driver.screenshotBase64();
    return Buffer.from(b64, 'base64');
  }

  // Convenience: capture (optionally element) screenshot and save to file, returning buffer.
  async saveScreenshot(path: string, selectorOrBy?: string | By): Promise<Buffer> {
    const buf = await this.screenshot(selectorOrBy);
    await fs.writeFile(path, buf);
    return buf;
  }

  expect(selector: string | By) {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return expectSelector(this.driver, by);
  }

  find(selector: string | By): ElementHandle {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return new ElementHandle(this.driver, by);
  }

  getByRole(role: string, opts?: { name?: string; exact?: boolean; includeHidden?: boolean }): ElementHandle {
    return new ElementHandle(this.driver, By.role(role, opts));
  }

  getByText(text: string, opts?: { exact?: boolean }): ElementHandle {
    if (opts?.exact === false) {
      return new ElementHandle(this.driver, By.partialText(text));
    }
    return new ElementHandle(this.driver, By.text(text));
  }

  getByLabel(text: string, opts?: { exact?: boolean }): ElementHandle {
    return new ElementHandle(this.driver, By.labelText(text, opts));
  }

  getByPlaceholder(text: string, opts?: { exact?: boolean }): ElementHandle {
    return new ElementHandle(this.driver, By.placeholder(text, opts));
  }

  getByTestId(id: string): ElementHandle {
    return new ElementHandle(this.driver, By.testId(id));
  }

  // Keyboard controller and enum for nicer usage: browser.keyboard.press(Key.Enter)
  keyboard: KeyboardController;

  // Mouse controller: browser.mouse.click(...), move, down, up, wheel, dragAndDrop
  mouse: MouseController;

  static Key = Key;

  async waitFor(
    check: ((driver: Driver) => Promise<any> | any) | (() => Promise<any> | any),
    options?: WaitOptions & { message?: string }
  ) {
    const cond: Condition<any> = async (d: Driver) => {
      try {
        const r = await (check.length > 0
          ? (check as (d: Driver) => any)(d)
          : (check as () => any)());
        return r;
      } catch {
        return undefined as any;
      }
    };
    return this.wait(cond, options as any);
  }

  async waitForVisible(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementIsVisible(by), { timeout: opts?.timeout ?? 5000 });
  }

  async waitForHidden(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementIsNotVisible(by), { timeout: opts?.timeout ?? 5000 });
  }

  async waitForAttached(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementExists(by), { timeout: opts?.timeout ?? 5000 });
  }

  async waitForDetached(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementNotExists(by), { timeout: opts?.timeout ?? 5000 });
  }

  actions() {
    return new ActionsBuilder(this.driver);
  }

  // Utility: pause execution for a given number of milliseconds
  async pause(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
  }
}
