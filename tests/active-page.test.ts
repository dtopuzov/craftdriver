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

describe('Page.activate() and Page.close() — the primitives tabs are built on', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    // Collapse back to a single page between cases, so one test's leftover
    // tab cannot make the next one pass for the wrong reason.
    const pages = await browser.pages();
    for (const page of pages.slice(1)) await page.close();
    await pages[0].activate();
    await browser.navigateTo(`${baseUrl}/login.html`);
  });

  it('activate makes a page the active target and leaves it there', async () => {
    const opened = await browser.openPage({ url: `${baseUrl}/agent-debug.html` });

    // The distinction from the other page methods, which switch back so they
    // never disturb activePage(): this one is meant to stick.
    await opened.activate();
    expect((await browser.activePage()).id()).toBe(opened.id());

    // ...and a browser-level shortcut now reads the activated page.
    expect(await browser.title()).toBe(await opened.title());
  }, 60_000);

  it('close removes the page and leaves a usable active target', async () => {
    const opened = await browser.openPage({ url: `${baseUrl}/agent-debug.html` });
    await opened.activate();
    const openedId = opened.id();

    await opened.close();

    const remaining = await browser.pages();
    expect(remaining.map((p) => p.id())).not.toContain(openedId);

    // W3C leaves no window focused after a close. Without the switch inside
    // close(), this next call fails with "no such window" instead of working.
    await expect(browser.title()).resolves.toBeTypeOf('string');
  }, 60_000);

  it('closing a background page does not steal the active target', async () => {
    const first = await browser.openPage({ url: `${baseUrl}/agent-debug.html` });
    const second = await browser.openPage({ url: `${baseUrl}/login.html` });
    await second.activate();

    await first.close();

    // Closing something else must not move the user's focus.
    expect((await browser.activePage()).id()).toBe(second.id());
  }, 60_000);

  it('activate is idempotent', async () => {
    const opened = await browser.openPage({ url: `${baseUrl}/agent-debug.html` });
    await opened.activate();
    await opened.activate();
    expect((await browser.activePage()).id()).toBe(opened.id());
  }, 60_000);

  it('reports a closed page as gone rather than acting on another one', async () => {
    const opened = await browser.openPage({ url: `${baseUrl}/agent-debug.html` });
    await opened.close();

    // The dangerous failure is silently operating on a surviving tab.
    await expect(opened.title()).rejects.toThrow();
  }, 60_000);
});
