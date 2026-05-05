import { describe, it, beforeAll, afterAll } from 'vitest';
import { expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('BiDi-first navigation and load states', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('BiDi is enabled by default', async () => {
    expect(browser.isBiDiEnabled()).toBe(true);
  });

  it('navigateTo resolves on a static page', async () => {
    await expect(browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`)).resolves.toBeUndefined();
  });

  it('waitForLoadState("load") resolves when page is already loaded', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    // Page is already in "complete" state — must resolve immediately
    await expect(browser.waitForLoadState('load')).resolves.toBeUndefined();
  });

  it('waitForLoadState("domcontentloaded") resolves on a static page', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    await expect(browser.waitForLoadState('domcontentloaded')).resolves.toBeUndefined();
  });

  it('waitForLoadState("networkidle") resolves when no requests are in-flight', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    // login.html is static — network is already idle after navigation
    await expect(
      browser.waitForLoadState('networkidle', { timeout: 5000 })
    ).resolves.toBeUndefined();
  });

  it('navigateTo with waitUntil: "domcontentloaded" resolves', async () => {
    await expect(
      browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`, { waitUntil: 'domcontentloaded' })
    ).resolves.toBeUndefined();
  });

  it('navigateTo with waitUntil: "networkidle" resolves on a quiet page', async () => {
    await expect(
      browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`, { waitUntil: 'networkidle' })
    ).resolves.toBeUndefined();
  });

  it('navigateTo with waitUntil: "none" resolves immediately without waiting for load', async () => {
    await expect(
      browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`, { waitUntil: 'none' })
    ).resolves.toBeUndefined();
  });

  it('waitForLoadState times out when page does not reach the state within the deadline', async () => {
    // Navigate with waitUntil:'none' so we get control immediately while the page may still be loading.
    // Use dynamic.html which has a delayed DOM update but starts loading normally.
    // We register waitForLoadState BEFORE the navigation completes, with a 1ms timeout.
    // Since dynamic.html fetches nothing extra, it loads quickly — but we're testing that
    // the error message is correct when a timeout does fire.
    // Approach: wait for 'networkidle' with a tiny timeout on a fresh navigateTo('none') invocation.
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/dynamic.html`, { waitUntil: 'none' });
    // networkidle on a page that just started loading will almost certainly time out at 1ms
    await expect(
      browser.waitForLoadState('networkidle', { timeout: 1 })
    ).rejects.toThrow(/timed out/);
  });
});
