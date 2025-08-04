import type { Driver } from './driver.js';
import { getKeyValue, type KeyValue } from './keys.js';

export class KeyboardController {
  constructor(private driver: Driver) {}

  async type(text: string): Promise<void> {
    await this.driver.typeText(text);
  }

  async press(key: KeyValue, opts?: { repeat?: number }): Promise<void> {
    const value = getKeyValue(key);
    await this.driver.keyPressCode(value, Math.max(1, opts?.repeat ?? 1));
  }

  async down(key: KeyValue): Promise<void> {
    const value = getKeyValue(key);
    await this.driver.keyDownCode(value);
  }

  async up(key: KeyValue): Promise<void> {
    const value = getKeyValue(key);
    await this.driver.keyUpCode(value);
  }

  // Press multiple keys together (e.g., Ctrl + A): downs in order, ups in reverse.
  async chord(...keys: KeyValue[]): Promise<void> {
    const codes = keys.map((k) => getKeyValue(k));
    for (const c of codes) await this.driver.keyDownCode(c);
    for (const c of codes.slice().reverse()) await this.driver.keyUpCode(c);
  }
}
