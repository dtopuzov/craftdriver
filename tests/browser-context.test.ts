import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser, BrowserContext, Page } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('BrowserContext (BiDi user contexts)', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  async function withContext<T>(run: (ctx: BrowserContext) => Promise<T>): Promise<T> {
    const ctx = await browser.newContext();
    try {
      return await run(ctx);
    } finally {
      await ctx.close();
    }
  }

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('defaultContext is a BrowserContext with id "default"', () => {
    const ctx = browser.defaultContext;
    expect(ctx).toBeInstanceOf(BrowserContext);
    expect(ctx.id).toBe('default');
  });

  it('contexts() always includes the default context', async () => {
    const ctxs = await browser.contexts();
    expect(ctxs.length).toBeGreaterThanOrEqual(1);
    expect(ctxs.map((c) => c.id)).toContain('default');
  });

  it('newContext() creates an isolated context with a new id', async () => {
    await withContext(async (ctx) => {
      expect(ctx).toBeInstanceOf(BrowserContext);
      expect(ctx.id).not.toBe('default');
      const all = await browser.contexts();
      expect(all.map((c) => c.id)).toContain(ctx.id);
    });
  });

  it('newPage() opens a page bound to the context', async () => {
    await withContext(async (ctx) => {
      const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
      expect(page).toBeInstanceOf(Page);
      await page.waitForLoadState('load');
      expect(await page.title()).toContain('Login');

      const pages = await ctx.pages();
      expect(pages.map((p) => p.id())).toContain(page.id());
    });
  });

  it('two contexts isolate cookies (multi-user login)', async () => {
    const alice = await browser.newContext();
    const bob = await browser.newContext();
    try {
      const aPage = await alice.newPage({ url: `${baseUrl}/login.html` });
      await aPage.waitForLoadState('load');
      await aPage.find('#username').fill('alice');
      await aPage.find('#password').fill('secret');
      await aPage.find('#submit').click();
      await aPage.expect('#welcome').toContainText('alice');

      const bPage = await bob.newPage({ url: `${baseUrl}/login.html` });
      await bPage.waitForLoadState('load');
      // Bob's context must NOT see Alice's session cookie.
      const bobCookies = await bPage.evaluate<string>(() => document.cookie);
      expect(bobCookies).not.toContain('alice');

      await bPage.find('#username').fill('bob');
      await bPage.find('#password').fill('secret');
      await bPage.find('#submit').click();
      await bPage.expect('#welcome').toContainText('bob');

      // Alice's page is unaffected by Bob's login.
      const aliceWelcome = await aPage.find('#welcome').text();
      expect(aliceWelcome).toContain('alice');
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it("page.findAll() handles stay bound to a non-default context's window", async () => {
    // Regression: findAll() used to return snapshot handles with no context
    // switcher, so a later .text() call ran against whichever window
    // happened to have Classic focus by then instead of this page's own
    // window — invisible on the always-default-context happy path, real
    // once a page lives in a non-default BrowserContext.
    await withContext(async (ctx) => {
      const page = await ctx.newPage({ url: `${baseUrl}/locator.html` });
      const handles = await page.findAll('.product-name');
      expect(handles.length).toBe(5);
      const texts = await Promise.all(handles.map((h) => h.text()));
      expect(texts).toContain('Widget Lite');
    });
  });

  it("page.locator(...).all() handles stay bound to a non-default context's window", async () => {
    await withContext(async (ctx) => {
      const page = await ctx.newPage({ url: `${baseUrl}/locator.html` });
      const handles = await page.locator('.product').filter({ hasText: 'Gadget' }).all();
      expect(handles.length).toBe(2);
      const texts = await Promise.all(handles.map((h) => h.text()));
      expect(texts).toEqual([expect.stringContaining('Gadget'), expect.stringContaining('Gadget')]);
    });
  });

  it('close() removes the context and subsequent ops throw', async () => {
    const ctx = await browser.newContext();
    await ctx.close();
    expect(ctx.isClosed).toBe(true);
    await expect(ctx.newPage()).rejects.toThrow(/closed/);

    const all = await browser.contexts();
    expect(all.map((c) => c.id)).not.toContain(ctx.id);
  });

  it('defaultContext.close() throws (cannot remove default)', async () => {
    await expect(browser.defaultContext.close()).rejects.toThrow(/default/);
  });
});

describe('BrowserContext in Classic mode', () => {
  it('newContext() throws a clear error when BiDi is disabled', async () => {
    const browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
    try {
      await expect(browser.newContext()).rejects.toThrow(/newContext\(\) requires BiDi/);
      expect(() => browser.defaultContext).toThrow(/requires BiDi/);
      await expect(browser.contexts()).rejects.toThrow(/requires BiDi/);
    } finally {
      await browser.quit();
    }
  });
});
