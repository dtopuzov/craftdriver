import { By, type ExactLocatorOptions, type RoleLocatorOptions } from './by.js';
import type { Driver } from './driver.js';
import { ElementHandle } from './elementHandle.js';
import { Locator } from './locator.js';
import {
  QueryEnvironment,
  createLocatorPlan,
  type SearchRootPlan,
} from './query.js';

/**
 * Lazy, explicit search context for one open ShadowRoot.
 *
 * It deliberately exposes lookup methods only: a ShadowRoot is a document
 * fragment, not an actionable element.
 */
export class ShadowRootLocator {
  constructor(
    private driver: Driver,
    private root: SearchRootPlan,
    private getDefaultTimeout: () => number,
    private environment: QueryEnvironment
  ) {}

  locator(selector: string | By): Locator {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return Locator.fromPlan(
      this.driver,
      createLocatorPlan(by, this.root),
      this.getDefaultTimeout,
      this.environment
    );
  }

  find(selector: string | By): ElementHandle {
    const locator = this.locator(selector);
    return ElementHandle.fromTarget(
      this.driver,
      { kind: 'locator', plan: locator._queryPlan() },
      this.getDefaultTimeout,
      this.environment
    );
  }

  async findAll(selector: string | By): Promise<ElementHandle[]> {
    return this.locator(selector).all();
  }

  getByRole(role: string, options?: RoleLocatorOptions): Locator {
    return this.locator(By.role(role, options));
  }

  getByText(text: string, options?: { exact?: boolean }): Locator {
    return this.locator(By.text(text, options));
  }

  getByLabel(text: string, options?: ExactLocatorOptions): Locator {
    return this.locator(By.labelText(text, options));
  }

  getByPlaceholder(text: string, options?: ExactLocatorOptions): Locator {
    return this.locator(By.placeholder(text, options));
  }

  getByAltText(text: string, options?: ExactLocatorOptions): Locator {
    return this.locator(By.altText(text, options));
  }

  getByTitle(text: string, options?: ExactLocatorOptions): Locator {
    return this.locator(By.title(text, options));
  }

  getByTestId(id: string): Locator {
    return this.locator(By.testId(id));
  }
}
