import { By } from './by.js';
import type { Driver } from './driver.js';
import { until } from './wait.js';
import fs from 'fs/promises';
import { expectSelector } from './expect.js';
import { getKeyValue, type KeyValue } from './keys.js';

export interface ElementOptions {
  timeout?: number;
}

export class ElementHandle {
  constructor(
    private driver: Driver,
    private by: By
  ) { }

  async click(options?: ElementOptions): Promise<void> {
    const el = await this.driver.wait(until.elementIsVisible(this.by), { timeout: options?.timeout ?? 5000 });
    await el.click();
  }

  async fill(text: string, options?: ElementOptions): Promise<void> {
    const el = await this.driver.wait(until.elementIsVisible(this.by), {
      timeout: options?.timeout ?? 5000,
    });
    await el.click();
    await el.clear();
    await el.sendKeys(text);
  }

  async clear(options?: ElementOptions): Promise<void> {
    const el = await this.driver.wait(until.elementIsVisible(this.by), {
      timeout: options?.timeout ?? 5000,
    });
    await el.clear();
  }

  async press(key: KeyValue, options?: ElementOptions): Promise<void> {
    // assumes element is focused after click/type; ensure focus by clicking first
    const el = await this.driver.wait(until.elementIsVisible(this.by), { timeout: options?.timeout ?? 5000 });
    await el.click();
    const code = getKeyValue(key);
    await this.driver.keyPressCode(code, 1);
  }

  async screenshot(path?: string, options?: ElementOptions): Promise<Buffer> {
    const el = await this.driver.wait(until.elementIsVisible(this.by), { timeout: options?.timeout ?? 5000 });
    const b64 = await el.screenshotBase64();
    const buf = Buffer.from(b64, 'base64');
    if (path) await fs.writeFile(path, buf);
    return buf;
  }

  async text(options?: ElementOptions): Promise<string> {
    const el = await this.driver.wait(until.elementLocated(this.by), { timeout: options?.timeout ?? 5000 });
    return await el.getText();
  }

  async value(options?: ElementOptions): Promise<string> {
    const el = await this.driver.wait(until.elementLocated(this.by), { timeout: options?.timeout ?? 5000 });
    const val = await el.getProperty('value');
    return String(val ?? '');
  }

  async tag(options?: ElementOptions): Promise<string> {
    const el = await this.driver.wait(until.elementLocated(this.by), { timeout: options?.timeout ?? 5000 });
    return await el.getTagName();
  }

  async getAttribute(name: string, options?: ElementOptions): Promise<string | null> {
    const el = await this.driver.wait(until.elementLocated(this.by), { timeout: options?.timeout ?? 5000 });
    return await el.getAttribute(name);
  }

  async isVisible(options?: ElementOptions): Promise<boolean> {
    try {
      const el = await this.driver.wait(until.elementLocated(this.by), { timeout: options?.timeout ?? 1000 });
      return await el.isDisplayed();
    } catch {
      return false;
    }
  }

  async isEnabled(options?: ElementOptions): Promise<boolean> {
    const el = await this.driver.wait(until.elementLocated(this.by), { timeout: options?.timeout ?? 5000 });
    return await el.isEnabled();
  }

  async isChecked(options?: ElementOptions): Promise<boolean> {
    const el = await this.driver.wait(until.elementLocated(this.by), { timeout: options?.timeout ?? 5000 });
    return await el.isSelected();
  }

  async boundingBox(options?: ElementOptions): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const el = await this.driver.wait(until.elementLocated(this.by), { timeout: options?.timeout ?? 5000 });
      return await el.getRect();
    } catch {
      return null;
    }
  }

  async hover(options?: ElementOptions): Promise<void> {
    const el = await this.driver.wait(until.elementIsVisible(this.by), { timeout: options?.timeout ?? 5000 });
    const rect = await el.getRect();
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    await this.driver.pointerMoveTo(undefined, centerX, centerY);
  }

  async select(value: string, options?: ElementOptions): Promise<void> {
    const el = await this.driver.wait(until.elementLocated(this.by), { timeout: options?.timeout ?? 5000 });

    // Verify element is a <select>
    const tagName = await el.getTagName();
    if (tagName !== 'select') {
      throw new Error(
        `select() can only be used on <select> elements. Found <${tagName}> instead. ` +
        `Use browser.click('#selector option[value="..."]') for other element types.`
      );
    }

    // Use JavaScript to select the option by value
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
  }

  expect() {
    return expectSelector(this.driver, this.by);
  }
}
