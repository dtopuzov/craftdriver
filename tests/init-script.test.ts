import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('addInitScript()', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('init script runs before page scripts on first navigation', async () => {
    await browser.addInitScript(() => {
      (window as any).__hello = 'world';
    });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/evaluate.html`);
    const val = await browser.evaluate(() => (window as any).__hello);
    expect(val).toBe('world');
  });

  it('init script survives subsequent navigations', async () => {
    // Script was registered in the previous test; navigate again
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/evaluate.html`);
    const val = await browser.evaluate(() => (window as any).__hello);
    expect(val).toBe('world');
  });

  it('remove() stops the script from running on next navigation', async () => {
    // Register a fresh, distinct script so we can remove it cleanly
    const handle = await browser.addInitScript(() => {
      (window as any).__removable = 'yes';
    });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/evaluate.html`);
    expect(await browser.evaluate(() => (window as any).__removable)).toBe('yes');

    await handle.remove();
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/evaluate.html`);
    const after = await browser.evaluate(() => (window as any).__removable);
    expect(after).toBeUndefined();
  });

  it('string form is also accepted', async () => {
    const handle = await browser.addInitScript(`(window).__strScript = 'ok';`);
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/evaluate.html`);
    expect(await browser.evaluate(() => (window as any).__strScript)).toBe('ok');
    await handle.remove();
  });

  it('throws a clear error when BiDi is unavailable', async () => {
    const noBidi = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
    try {
      await expect(noBidi.addInitScript(() => { })).rejects.toThrow(/addInitScript\(\) requires BiDi/);
    } finally {
      await noBidi.quit();
    }
  });
});
