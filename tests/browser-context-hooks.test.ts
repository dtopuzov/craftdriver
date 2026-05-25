/**
 * BrowserContext — page-scoped hooks & routing (Milestone B).
 *
 * Real-world scenarios this exercises:
 *
 *   - "Mock the /api/me endpoint just for Alice's context, leave Bob's
 *     untouched." → per-context `ctx.route()` with handler-side filtering.
 *   - "Mark every page (including popups) as running under E2E so the app
 *     skips animations." → `ctx.addInitScript()` scoped via BiDi
 *     `userContexts`.
 *   - "Capture console output from every tab a user opens, present and
 *     future." → `ctx.on('page', …)` event.
 *   - "Hit staging without hardcoding the host in every test." → `baseURL`.
 *   - "Tag every request from the tenant context with `X-Tenant`." →
 *     `extraHTTPHeaders`.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser, Page } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('BrowserContext hooks & routing (Milestone B)', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  // ── page.context() back-reference ──────────────────────────────────────

  it('page.context() points back to the owning BrowserContext', async () => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
      expect(page.context()).toBe(ctx);

      const [listed] = await ctx.pages();
      expect(listed.context()).toBe(ctx);
    } finally {
      await ctx.close();
    }
  });

  it('Browser-level pages report defaultContext, and context wrappers are cached', async () => {
    // Regression: browser.openPage()/pages()/activePage() used to return Pages
    // with page.context() === undefined, even though at the BiDi layer they
    // live in the default user context. And browser.contexts() used to mint
    // a fresh wrapper every call, silently losing listeners and routes.
    const opened = await browser.openPage({ url: `${baseUrl}/login.html` });
    expect(opened.context()).toBe(browser.defaultContext);

    const listed = await browser.contexts();
    const def = listed.find((c) => c.id === 'default');
    expect(def).toBe(browser.defaultContext);
  });

  // ── baseURL ────────────────────────────────────────────────────────────

  it('baseURL resolves relative paths in page.navigateTo()', async () => {
    // QA value: point one context at staging and all relative URLs in
    // tests "just work" without the hostname pasted everywhere.
    const ctx = await browser.newContext({ baseURL: baseUrl });
    try {
      const page = await ctx.newPage();
      await page.navigateTo('/login.html');
      await page.waitForLoadState('load');
      expect(await page.title()).toContain('Login');
      expect((await page.url())?.endsWith('/login.html')).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('baseURL leaves absolute URLs untouched', async () => {
    const ctx = await browser.newContext({ baseURL: 'https://nowhere.example.com' });
    try {
      const page = await ctx.newPage();
      await page.navigateTo(`${baseUrl}/login.html`);
      await page.waitForLoadState('load');
      expect(await page.title()).toContain('Login');
    } finally {
      await ctx.close();
    }
  });

  // ── extraHTTPHeaders ───────────────────────────────────────────────────

  it('extraHTTPHeaders are sent on requests from this context only', async () => {
    // QA value: tag every request from a tenant's context with
    // `X-Tenant: acme` without modifying app code or wrapping fetch.
    const tenant = await browser.newContext({
      extraHTTPHeaders: { 'X-Tenant': 'acme' },
    });
    const seenHeaders: Record<string, string> = {};
    try {
      // Capture the headers that hit the example server by intercepting
      // the request inside the same context.
      await tenant.route('**/login.html', (req) => {
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() === 'x-tenant') seenHeaders[k.toLowerCase()] = v;
        }
        // Continue with the real response.
      });
      const page = await tenant.newPage({ url: `${baseUrl}/login.html` });
      await page.waitForLoadState('load');
      expect(seenHeaders['x-tenant']).toBe('acme');
    } finally {
      await tenant.close();
    }
  });

  it('setExtraHTTPHeaders replaces the previous map and applies live', async () => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { 'X-Tenant': 'acme' },
    });
    let captured: string | undefined;
    try {
      await ctx.route('**/login.html', (req) => {
        captured = req.headers['x-tenant'] ?? req.headers['X-Tenant'];
      });
      await ctx.setExtraHTTPHeaders({ 'X-Tenant': 'globex' });

      const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
      await page.waitForLoadState('load');
      expect(captured).toBe('globex');
    } finally {
      await ctx.close();
    }
  });

  // ── addInitScript ──────────────────────────────────────────────────────

  it('addInitScript runs in every page of the context, including popups', async () => {
    // QA value: flip a feature-flag flag on every page (present and
    // future) without wiring per-page calls.
    const ctx = await browser.newContext();
    try {
      const handle = await ctx.addInitScript(`window.__E2E__ = 'yes';`);
      expect(typeof handle.id).toBe('string');

      const a = await ctx.newPage({ url: `${baseUrl}/login.html` });
      await a.waitForLoadState('load');
      expect(await a.evaluate<string>(`return window.__E2E__;`)).toBe('yes');

      // Open a second page later — the script still applies.
      const b = await ctx.newPage({ url: `${baseUrl}/login.html` });
      await b.waitForLoadState('load');
      expect(await b.evaluate<string>(`return window.__E2E__;`)).toBe('yes');

      // remove() makes future pages no longer see the flag.
      await handle.remove();
      const c = await ctx.newPage({ url: `${baseUrl}/login.html` });
      await c.waitForLoadState('load');
      expect(await c.evaluate<unknown>(`return window.__E2E__;`)).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it('addInitScript does NOT leak into other contexts', async () => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      await a.addInitScript(`window.__MARK__ = 'A';`);
      const pa = await a.newPage({ url: `${baseUrl}/login.html` });
      const pb = await b.newPage({ url: `${baseUrl}/login.html` });
      await pa.waitForLoadState('load');
      await pb.waitForLoadState('load');

      expect(await pa.evaluate<string>(`return window.__MARK__;`)).toBe('A');
      expect(await pb.evaluate<unknown>(`return window.__MARK__;`)).toBeUndefined();
    } finally {
      await a.close();
      await b.close();
    }
  });

  // ── route / unroute ────────────────────────────────────────────────────

  it('route() mocks requests only from pages in this context', async () => {
    // QA value: stub `/api/users` for the "logged-in admin" context
    // while leaving the "guest" context to hit the real backend.
    const adminCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    try {
      await adminCtx.route('**/api/users', () => ({
        status: 200,
        body: { users: [{ id: 1, name: 'Admin Override' }] },
      }));

      // Admin: sees the mocked response.
      const adminPage = await adminCtx.newPage({
        url: `${baseUrl}/network.html?bidi=true`,
      });
      await adminPage.waitForLoadState('load');
      await adminPage.find('#fetch-users-btn').click();
      await adminPage.expect('#users-result').toContainText('Admin Override');

      // Guest: same endpoint, no mock — falls through to the example's
      // built-in server stub, which returns a different name.
      const guestPage = await guestCtx.newPage({
        url: `${baseUrl}/network.html?bidi=true`,
      });
      await guestPage.waitForLoadState('load');
      await guestPage.find('#fetch-users-btn').click();
      const guestText = await guestPage.find('#users-result').text();
      expect(guestText).not.toContain('Admin Override');
    } finally {
      await adminCtx.close();
      await guestCtx.close();
    }
  });

  it('unroute() removes a single registered route by id', async () => {
    const ctx = await browser.newContext();
    try {
      let calls = 0;
      const id = await ctx.route('**/api/users', () => {
        calls++;
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: { users: [] },
        };
      });

      const page = await ctx.newPage({ url: `${baseUrl}/network.html?bidi=true` });
      await page.waitForLoadState('load');
      await page.find('#fetch-users-btn').click();
      await page.expect('#users-result').toBeVisible();
      const after1 = calls;
      expect(after1).toBeGreaterThan(0);

      await ctx.unroute(id);
      await page.find('#fetch-users-btn').click();
      // Brief delay for the second fetch — no auto-wait here.
      await page.expect('#users-result').toBeVisible();
      // Counter must not have advanced.
      expect(calls).toBe(after1);
    } finally {
      await ctx.close();
    }
  });

  // ── on('page') / on('close') ───────────────────────────────────────────

  it("on('page') fires for new pages and popups", async () => {
    // QA value: attach a console-error listener to every tab the test
    // opens — including a window.open popup — without juggling refs.
    const ctx = await browser.newContext();
    const seen: Page[] = [];
    try {
      ctx.on('page', (page) => {
        seen.push(page);
      });

      const main = await ctx.newPage({ url: `${baseUrl}/popup.html` });
      await main.waitForLoadState('load');

      // Open a popup from this context.
      const popup = await ctx.waitForPage(() => main.find('#open-popup').click());
      await popup.waitForLoadState('load');

      // Firefox can dispatch contextCreated noticeably after the popup's
      // `load` event resolves; poll up to a short deadline so the test
      // remains stable across engines without inflating the happy path.
      const deadline = Date.now() + 5000;
      while (seen.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // We expect to have observed both the main page and the popup.
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(seen.every((p) => p.context() === ctx)).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it("on('close') fires when the context is closed", async () => {
    const ctx = await browser.newContext();
    let fired = 0;
    ctx.on('close', () => {
      fired++;
    });
    await ctx.close();
    expect(fired).toBe(1);
  });
});
