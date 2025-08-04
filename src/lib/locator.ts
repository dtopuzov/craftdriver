import { By } from './by.js';
import type { Driver } from './driver.js';
import { until } from './wait.js';

export interface ActionOptions {
  timeout?: number;
}

export class Locator {
  constructor(
    private driver: Driver,
    private by: By
  ) {}

  locator(selector: string | By): Locator {
    const next = typeof selector === 'string' ? By.css(selector) : selector;
    return new Locator(this.driver, next);
  }

  async click(options: ActionOptions = {}): Promise<void> {
    const el = await this.driver.wait(until.elementIsVisible(this.by), {
      timeout: options.timeout ?? 5000,
    });
    await el.click();
  }

  async fill(text: string, options: ActionOptions = {}): Promise<void> {
    const el = await this.driver.wait(until.elementIsVisible(this.by), {
      timeout: options.timeout ?? 5000,
    });
    await el.click();
    await el.sendKeys(text);
  }

  async textContent(options: ActionOptions = {}): Promise<string> {
    const el = await this.driver.wait(until.elementExists(this.by), {
      timeout: options.timeout ?? 5000,
    });
    return (await el.getText()) ?? '';
  }

  async isVisible(options: ActionOptions = {}): Promise<boolean> {
    try {
      const el = await this.driver.wait(until.elementExists(this.by), {
        timeout: options.timeout ?? 5000,
      });
      return await el.isDisplayed();
    } catch {
      return false;
    }
  }

  waitFor(options: {
    state: 'attached' | 'detached' | 'visible' | 'hidden';
    timeout?: number;
  }): Promise<any> {
    const { state, timeout } = options;
    if (state === 'attached') return this.driver.wait(until.elementExists(this.by), { timeout });
    if (state === 'detached') return this.driver.wait(until.elementNotExists(this.by), { timeout });
    if (state === 'visible') return this.driver.wait(until.elementIsVisible(this.by), { timeout });
    if (state === 'hidden')
      return this.driver.wait(until.elementIsNotVisible(this.by), { timeout });
    return Promise.reject(new Error(`Unknown state: ${state}`));
  }
}
