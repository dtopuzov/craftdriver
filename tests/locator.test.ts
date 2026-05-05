import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { expect } from 'vitest';
import { Browser } from '../src';
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
    expect(texts.every((t) => t.includes('Gadget'))).toBe(true);
  });
});
