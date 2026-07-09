import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, By } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

// Regression coverage for the XPath scope-escape bug: By.text, By.partialText,
// By.role, By.labelText, By.placeholder, By.altText, and By.title all generate
// `//...` XPath, which is document-root-anchored regardless of the context
// element passed to the "Find Element(s) From Element" WebDriver endpoint.
// Nested under a parent Locator, they used to silently search the whole
// document instead of the parent's subtree. Fixture: tests/../examples/selectors.html
// #area-scope has two lookalike cards (#scope-card-1 / #scope-card-2), each with
// a "Submit" button, plus a #scope-card-3 with an unrelated "Cancel" button.
describe('Locator scoping — semantic locators as children', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
  });

  it('By.text nested under a Locator only matches within that Locator', async () => {
    const scoped = browser.locator('#scope-card-2').locator(By.text('Submit'));
    expect(await scoped.count()).toBe(1);
    expect(await scoped.all().then((hs) => hs[0].getAttribute('id'))).toBe('scope-card-2-btn');
  });

  it('By.role nested under a Locator only matches within that Locator', async () => {
    const scoped = browser.locator('#scope-card-1').locator(By.role('button', { name: 'Submit' }));
    expect(await scoped.count()).toBe(1);
    expect(await scoped.all().then((hs) => hs[0].getAttribute('id'))).toBe('scope-card-1-btn');
  });

  it('filter({ has }) with a semantic locator correctly excludes non-matching siblings', async () => {
    const cardsWithSubmit = await browser
      .locator('.product-card')
      .filter({ has: browser.locator(By.text('Submit')) })
      .all();
    const ids = (await Promise.all(cardsWithSubmit.map((h) => h.getAttribute('id')))).sort();
    expect(ids).toEqual(['scope-card-1', 'scope-card-2']);
  });

  it('By.text exact match prefers the innermost element (no wrapper+child double match)', async () => {
    // Each product-card div's own normalize-space(.) also equals "Submit" or
    // "Cancel" (single child), so an un-guarded exact match would double-count.
    const count = await browser.locator(By.text('Submit')).count();
    expect(count).toBe(2);
  });
});
