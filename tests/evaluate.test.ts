import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('evaluate()', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/evaluate.html`);
  });

  it('returns document.title via function form', async () => {
    const title = await browser.evaluate(() => document.title);
    expect(title).toBe('Evaluate Playground');
  });

  it('passes arguments to the function', async () => {
    const result = await browser.evaluate((a, b) => (a as number) + (b as number), 2, 3);
    expect(result).toBe(5);
  });

  it('string form evaluates an expression', async () => {
    const title = await browser.evaluate('return document.title');
    expect(title).toBe('Evaluate Playground');
  });

  it('reads window.__state set by page script', async () => {
    const name = await browser.evaluate(() => (window as any).__state.name);
    expect(name).toBe('craftdriver');
  });

  it('mutations are reflected in subsequent calls', async () => {
    await browser.click('#action-btn');
    const count = await browser.evaluate(() => (window as any).__state.count);
    expect(count).toBe(1);
  });

  it('element.evaluate() receives the DOM element as first arg', async () => {
    const tag = await browser.find('#action-btn').evaluate((el) => (el as Element).tagName.toLowerCase());
    expect(tag).toBe('button');
  });

  it('element.evaluate() passes extra args', async () => {
    const has = await browser.find('#action-btn').evaluate(
      (el, cls) => (el as Element).classList.contains(cls as string),
      'active'
    );
    expect(has).toBe(true);
  });

  it('non-serializable result throws a clear error', async () => {
    // Returning a DOM node is not JSON-serializable via BiDi
    // (Classic executeScript silently coerces — skip that check)
    if (!browser.isBiDiEnabled()) return;
    await expect(
      browser.evaluate(() => document.body)
    ).rejects.toThrow(/not JSON-serializable|node reference/i);
  });
});
