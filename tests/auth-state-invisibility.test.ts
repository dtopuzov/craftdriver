/**
 * The private hydration context must stay invisible even when a context already
 * has page tracking armed (a `'page'` listener or a route) at the moment
 * loadStorageState runs — it must not emit a phantom `'page'` event, enter
 * `pages()`, or receive user routes.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import http from 'node:http';
import { Browser } from '../src';
import { BROWSER_NAME } from './utils';

const APP_HTML = '<!doctype html><html><head></head><body>app</body></html>';

function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(APP_HTML);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 75));

describe('hydration private-context invisibility (BiDi)', () => {
  let browser: Browser;
  let s1: { origin: string; close: () => Promise<void> };

  beforeAll(async () => {
    s1 = await startServer();
    browser = await Browser.launch({ browserName: BROWSER_NAME, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.quit();
    await s1?.close();
  });

  it('emits no phantom page event when hydrating an active context with a page listener', async () => {
    const ctx = await browser.newContext();
    try {
      const seen: unknown[] = [];
      ctx.on('page', (p) => seen.push(p)); // arms page tracking
      const page = await ctx.newPage();
      await page.navigateTo(`${s1.origin}/app.html`);
      await settle();

      const before = seen.length; // the one real page
      await ctx.loadStorageState({ localStorage: { [s1.origin]: { token: 'x' } } });
      await settle();

      // The private hydration tab must not have surfaced as a page.
      expect(seen.length).toBe(before);
      const pages = await ctx.pages();
      expect(pages.length).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it('does not register user routes on the private hydration context', async () => {
    const ctx = await browser.newContext();
    try {
      let userRouteHits = 0;
      await ctx.route('**/__craftdriver_hydrate__*', () => {
        userRouteHits += 1; // undefined return continues the request
      });
      await ctx.loadStorageState({ localStorage: { [s1.origin]: { token: 'x' } } });
      // The user's route (armed on real pages) must never see the internal
      // hydration navigation, which is owned by the strict internal intercept.
      expect(userRouteHits).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});
