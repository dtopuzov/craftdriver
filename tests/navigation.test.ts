import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Navigation, content and viewport', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
  });

  it('goBack() / goForward() walk the session history', async () => {
    await browser.navigateTo(`${baseUrl}/dynamic.html`);

    await browser.goBack();
    await expect.poll(() => browser.url(), { timeout: 5000 }).toContain('login.html');

    await browser.goForward();
    await expect.poll(() => browser.url(), { timeout: 5000 }).toContain('dynamic.html');
  });

  it('reload() reloads the active page', async () => {
    await browser.evaluate('window.__marker = 42');
    const before = await browser.evaluate<number | undefined>('return window.__marker');
    expect(before).toBe(42);

    await browser.reload();

    const after = await browser.evaluate<number | undefined>('return window.__marker');
    expect(after).toBeUndefined();
  });

  it('content() returns the serialized document', async () => {
    const html = await browser.content();
    expect(html).toContain('<html');
    expect(html.toLowerCase()).toContain('</html>');
  });

  it('setContent() replaces the document and waits for load', async () => {
    await browser.setContent('<!doctype html><title>Synthetic</title><h1 id="x">hello</h1>');
    expect(await browser.title()).toBe('Synthetic');
    expect(await browser.find('#x').text()).toBe('hello');
  });

  it('setViewportSize() resizes the layout viewport', async () => {
    await browser.setViewportSize({ width: 800, height: 600 });

    // Allow a few pixels of slack — Classic-mode fallback resizes the OS
    // window, so chrome (toolbars) eats some height.
    const inner = await browser.evaluate<{ w: number; h: number }>(
      'return { w: window.innerWidth, h: window.innerHeight }'
    );
    expect(inner.w).toBeGreaterThanOrEqual(700);
    expect(inner.w).toBeLessThanOrEqual(820);
    expect(inner.h).toBeGreaterThanOrEqual(400);
    expect(inner.h).toBeLessThanOrEqual(620);
  });
});
