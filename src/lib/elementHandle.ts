import { By } from './by.js';
import type { Driver } from './driver.js';
import { until } from './wait.js';
import fs from 'fs/promises';
import { expectSelector } from './expect.js';
import { getKeyValue, type KeyValue } from './keys.js';

export class ElementHandle {
  constructor(
    private driver: Driver,
    private by: By
  ) {}

  async click(): Promise<void> {
    const el = await this.driver.wait(until.elementIsVisible(this.by), { timeout: 5000 });
    await el.click();
  }

  async type(text: string, options?: { timeout?: number }): Promise<void> {
    const el = await this.driver.wait(until.elementIsVisible(this.by), {
      timeout: options?.timeout ?? 5000,
    });
    await el.click();
    await el.sendKeys(text);
  }

  async press(key: KeyValue): Promise<void> {
    // assumes element is focused after click/type; ensure focus by clicking first
    const el = await this.driver.wait(until.elementIsVisible(this.by), { timeout: 5000 });
    await el.click();
    const code = getKeyValue(key);
    await this.driver.keyPressCode(code, 1);
  }

  async screenshot(path?: string): Promise<Buffer> {
    const el = await this.driver.wait(until.elementIsVisible(this.by), { timeout: 5000 });
    const b64 = await el.screenshotBase64();
    const buf = Buffer.from(b64, 'base64');
    if (path) await fs.writeFile(path, buf);
    return buf;
  }

  async text(): Promise<string> {
    const el = await this.driver.findElement(this.by);
    return await el.getText();
  }

  expect() {
    return expectSelector(this.driver, this.by);
  }
}
