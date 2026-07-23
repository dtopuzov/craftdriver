import type { By } from './by.js';
import type { Driver } from './driver.js';
import type { WebElement } from './webelement.js';

/** W3C WebDriver shadow-root reference key. */
export const W3C_SHADOW_ROOT_KEY = 'shadow-6066-11e4-a52e-4f735466cecf';

/**
 * A WebDriver Classic shadow-root search context.
 *
 * This is intentionally internal. The public API exposes the lazy
 * `ShadowRootLocator`, not a cacheable wire reference that can detach.
 */
export class ClassicShadowRoot {
  constructor(
    private driver: Driver,
    private shadowRootId: string
  ) {}

  getId(): string {
    return this.shadowRootId;
  }

  findElement(locator: By): Promise<WebElement> {
    return this.driver.findElementFromShadowRoot(this.shadowRootId, locator);
  }

  findElements(locator: By): Promise<WebElement[]> {
    return this.driver.findElementsFromShadowRoot(this.shadowRootId, locator);
  }

  toJSON(): Record<string, string> {
    return { [W3C_SHADOW_ROOT_KEY]: this.shadowRootId };
  }
}
