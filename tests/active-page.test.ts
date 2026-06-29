import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, Page } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('browser.activePage() — the contract for browser-level shortcuts', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${baseUrl}/popup.html`);
  });

  it('returns a Page bound to the focused top-level context', async () => {
    const page = await browser.activePage();
    expect(page).toBeInstanceOf(Page);
    expect(typeof page.id()).toBe('string');
    expect(await page.title()).toBe('Craftdriver Popup');
  });

  it('matches the page that browser.* shortcuts implicitly target', async () => {
    // browser.find() and (await browser.activePage()).find() must agree.
    const fromBrowser = await browser.find('h1').text();
    const fromActive = await (await browser.activePage()).find('h1').text();
    expect(fromBrowser).toBe(fromActive);
  });

  it('does not request the full BiDi context tree on the hot path', async () => {
    const session = (browser as any).bidiSession;
    if (!session?.getConnection) return;

    const conn = session.getConnection();
    const originalSend = conn.send;
    const getTreeParams: Record<string, unknown>[] = [];

    conn.send = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'browsingContext.getTree') {
        getTreeParams.push(params);
      }
      return originalSend.call(conn, method, params);
    };

    try {
      const page = await browser.activePage();
      expect(await page.title()).toBe('Craftdriver Popup');
    } finally {
      conn.send = originalSend;
    }

    expect(getTreeParams).not.toContainEqual({});
  });

  it('does not follow openPage() into the new tab', async () => {
    const original = await browser.activePage();
    const newTab = await browser.openPage({
      url: `${baseUrl}/popup-target.html`,
      type: 'tab',
    });
    await newTab.waitForLoadState('load');

    // openPage does not steal focus: activePage() is still the original.
    const stillActive = await browser.activePage();
    expect(stillActive.id()).toBe(original.id());
    expect(await stillActive.title()).toBe('Craftdriver Popup');

    // And the new tab is a different page.
    expect(newTab.id()).not.toBe(original.id());
    expect(await newTab.title()).toBe('Popup Target');
  });

  it('never crosses into a non-default BrowserContext', async () => {
    const alice = await browser.newContext();
    try {
      const alicePage = await alice.newPage({ url: `${baseUrl}/popup-target.html` });
      await alicePage.waitForLoadState('load');

      const active = await browser.activePage();
      // The active page belongs to defaultContext, not Alice.
      expect(active.id()).not.toBe(alicePage.id());
      expect(await active.title()).toBe('Craftdriver Popup');
    } finally {
      await alice.close();
    }
  });
});
