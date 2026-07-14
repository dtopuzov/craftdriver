import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Browser } from '../src/lib/browser.js';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils.js';

describe('configurable timeouts', () => {
  let browser: Browser;

  beforeEach(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
  });

  afterEach(async () => {
    await browser.quit();
  });

  it('factory default is ~5000 ms', async () => {
    const start = Date.now();
    await expect(browser.waitForVisible('#missing')).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThan(3500);
    expect(elapsed).toBeLessThan(8000);
  });

  it('setDefaultTimeout() shortens subsequent waits', async () => {
    browser.setDefaultTimeout(600);
    const start = Date.now();
    await expect(browser.waitForVisible('#missing')).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('per-call { timeout } overrides the default', async () => {
    browser.setDefaultTimeout(5000);
    const start = Date.now();
    await expect(browser.waitForVisible('#missing', { timeout: 400 })).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2500);
  });

  it('expect() reads the same default', async () => {
    browser.setDefaultTimeout(600);
    const start = Date.now();
    await expect(browser.expect('#missing').toBeVisible()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('default change is live for handles created earlier', async () => {
    const handle = browser.find('#missing');
    browser.setDefaultTimeout(600);
    const start = Date.now();
    await expect(handle.click()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('does not bite when the element is already there', async () => {
    browser.setDefaultTimeout(2000);
    // #by-id exists on selectors.html; this should resolve quickly.
    const start = Date.now();
    await browser.waitForVisible('#by-id');
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('setDefaultNavigationTimeout() is accepted', () => {
    // Smoke test — behaviour exercised once navigateTo() uses it.
    expect(() => browser.setDefaultNavigationTimeout(15000)).not.toThrow();
  });
});
