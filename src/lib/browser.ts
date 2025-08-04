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

export interface LaunchOptions {
  browserName?: 'chrome' | 'chromium';
  chromeService?: ChromeService;
}

export class Browser {
  private constructor(private driver: Driver) {
    this.keyboard = new KeyboardController(this.driver);
    this.mouse = new MouseController(this.driver);
  }

  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const name = options.browserName ?? 'chrome';
    const service = options.chromeService ?? new ChromeService();
    const driver = await new Builder().forBrowser(name).setChromeService(service).build();
    return new Browser(driver);
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
    await this.driver.quit();
  }

  // New simplified API surface

  async click(selector: string | By): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementIsVisible(by), { timeout: 5000 });
    await el.click();
  }

  async type(
    selector: string | By,
    text: string,
    opts?: { mask?: boolean; timeout?: number }
  ): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementIsVisible(by), {
      timeout: opts?.timeout ?? 5000,
    });
    await el.click();
    // Optionally mask logs; no-op here, but could integrate with logger later
    await el.sendKeys(text);
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

  async screenshot(pathOrSelector: string, maybePath?: string): Promise<Buffer> {
    if (maybePath) {
      // element screenshot
      const by = By.css(pathOrSelector);
      const el = await this.driver.wait(until.elementIsVisible(by), { timeout: 5000 });
      const b64 = await el.screenshotBase64();
      const buf = Buffer.from(b64, 'base64');
      await fs.writeFile(maybePath, buf);
      return buf;
    }
    // full page screenshot
    const b64 = await this.driver.screenshotBase64();
    const buf = Buffer.from(b64, 'base64');
    await fs.writeFile(pathOrSelector, buf);
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

  actions() {
    return new ActionsBuilder(this.driver);
  }

  // Utility: pause execution for a given number of milliseconds
  async pause(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
  }
}
