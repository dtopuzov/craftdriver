import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, By } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Locator', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/locator.html`);
  });

  it('count() returns the number of matching elements', async () => {
    const count = await browser.locator('.product').count();
    expect(count).toBe(5);
  });

  it('first() clicks the first matching element', async () => {
    await browser.locator('.buy-btn').first().click();
    const status = await browser.find('#status').text();
    expect(status).toBe('clicked:buy-1');
  });

  it('last() clicks the last matching element', async () => {
    await browser.locator('.buy-btn').last().click();
    const status = await browser.find('#status').text();
    expect(status).toBe('clicked:buy-5');
  });

  it('nth(i) clicks the element at the given index', async () => {
    await browser.locator('.buy-btn').nth(2).click();
    const status = await browser.find('#status').text();
    expect(status).toBe('clicked:buy-3');
  });

  it('filter({ hasText }) narrows to elements containing the text', async () => {
    const count = await browser.locator('.product').filter({ hasText: 'Widget' }).count();
    expect(count).toBe(3);
  });

  it('filter({ hasText }) click acts on the matching element', async () => {
    await browser.locator('.product').filter({ hasText: 'Widget Pro' }).locator('.buy-btn').click();
    const status = await browser.find('#status').text();
    expect(status).toBe('clicked:buy-2');
  });

  it('chained child locator: card.locator(button).click()', async () => {
    // Find the third product card, then click its buy button
    await browser.locator('.product').nth(2).locator('.buy-btn').click();
    const status = await browser.find('#status').text();
    expect(status).toBe('clicked:buy-3');
  });

  it('re-resolves on each action after DOM mutation', async () => {
    // Show the dynamic item
    await browser.click('#toggle-btn');
    await browser.locator('#buy-dynamic').click();
    const status = await browser.find('#status').text();
    expect(status).toBe('clicked:buy-dynamic');

    // Hide and re-show, then click again — must re-resolve
    await browser.click('#toggle-btn');
    await browser.click('#toggle-btn');
    await browser.locator('#buy-dynamic').click();
    const status2 = await browser.find('#status').text();
    expect(status2).toBe('clicked:buy-dynamic');
  });

  it('findAll() returns handles for all matching elements', async () => {
    const handles = await browser.findAll('.product-name');
    expect(handles.length).toBe(5);
    const texts = await Promise.all(handles.map((h) => h.text()));
    expect(texts).toContain('Widget Lite');
    expect(texts).toContain('Gadget Plus');
  });

  it('all() returns snapshot handles for currently matching elements', async () => {
    const handles = await browser.locator('.product').filter({ hasText: 'Gadget' }).all();
    expect(handles.length).toBe(2);
    const texts = await Promise.all(handles.map((h) => h.text()));
    expect(texts).toEqual([expect.stringContaining('Gadget'), expect.stringContaining('Gadget')]);
  });

  describe('scoped getBy* convenience methods', () => {
    it('getByRole() scopes to the locator', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
      const scoped = browser.locator('#scope-card-1').getByRole('button', { name: 'Submit' });
      expect(await scoped.count()).toBe(1);
    });

    it('getByText() scopes to the locator', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
      const scoped = browser.locator('#scope-card-2').getByText('Submit');
      expect(await scoped.count()).toBe(1);
    });

    it('getByLabel() scopes to the locator', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
      const scoped = browser.locator('#area-label').getByLabel('Email Address');
      expect(await scoped.count()).toBe(1);
    });

    it('getByPlaceholder() scopes to the locator', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
      const scoped = browser.locator('#area-label').getByPlaceholder('Enter email');
      expect(await scoped.count()).toBe(1);
    });

    it('getByTestId() scopes to the locator', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
      const scoped = browser.locator('#area-attrs').getByTestId('by-testid');
      expect(await scoped.count()).toBe(1);
    });

    it('getByAltText() scopes to the locator', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
      const scoped = browser.locator('#area-attrs').getByAltText('Logo ALT');
      expect(await scoped.count()).toBe(1);
    });

    it('getByTitle() scopes to the locator', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
      const scoped = browser.locator('#area-attrs').getByTitle('Hint title');
      expect(await scoped.count()).toBe(1);
    });
  });

  // Regression coverage for the XPath scope-escape bug: By.text, By.partialText,
  // By.role, By.labelText, By.placeholder, By.altText, and By.title all generate
  // `//...` XPath, which is document-root-anchored regardless of the context
  // element passed to the "Find Element(s) From Element" WebDriver endpoint.
  // Nested under a parent Locator, they used to silently search the whole
  // document instead of the parent's subtree. Fixture: examples/selectors.html
  // #area-scope has two lookalike cards (#scope-card-1 / #scope-card-2), each with
  // a "Submit" button, plus a #scope-card-3 with an unrelated "Cancel" button.
  describe('semantic locators as children (scope escape)', () => {
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
});
