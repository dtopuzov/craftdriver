/**
 * Contract tests for one-time localStorage hydration on a BiDi session.
 *
 * The restore path seeds each captured origin once through a private,
 * intercepted document — cookies + localStorage become visible to the page's
 * first author script, and (crucially) an application's own writes survive a
 * reload, because there is no per-navigation preload re-seeding the snapshot.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Browser } from '../src';
import { BROWSER_NAME } from './utils';

// First author script records what localStorage held at first run, then leaves
// it alone — so a value the test mutates is only reverted by an (unwanted)
// re-seed, never by the app itself.
const APP_HTML =
  '<!doctype html><html><head>' +
  '<script>document.title="FIRST:"+(localStorage.getItem("token")||"none");</script>' +
  '</head><body>app</body></html>';

async function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  // Serves the app for any path. The intercept fulfils the private hydrate
  // navigation before it reaches here; that the intercept genuinely fulfils
  // (rather than the server) is proved against the real examples server in
  // tests/storage.test.ts, whose 404 for the hydrate path fails outright when
  // the intercept does not register.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(APP_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('auth-state hydration (BiDi)', () => {
  let browser: Browser;
  let s1: { origin: string; close: () => Promise<void> };
  let s2: { origin: string; close: () => Promise<void> };

  beforeAll(async () => {
    s1 = await startServer();
    s2 = await startServer();
    browser = await Browser.launch({ browserName: BROWSER_NAME, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.quit();
    await s1?.close();
    await s2?.close();
  });

  it('restores localStorage into a new context, visible to the first author script', async () => {
    const ctx = await browser.newContext({
      storageState: { localStorage: { [s1.origin]: { token: 'seeded' } } },
    });
    try {
      const page = await ctx.newPage();
      await page.navigateTo(`${s1.origin}/app.html`);
      expect(await page.evaluate(() => document.title)).toBe('FIRST:seeded');
      expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('seeded');
    } finally {
      await ctx.close();
    }
  });

  it('seeds once — an application mutation survives a reload', async () => {
    const ctx = await browser.newContext({
      storageState: { localStorage: { [s1.origin]: { token: 'seeded' } } },
    });
    try {
      const page = await ctx.newPage();
      await page.navigateTo(`${s1.origin}/app.html`);
      await page.evaluate(() => localStorage.setItem('token', 'CHANGED'));
      await page.reload();
      // A per-navigation preload would revert this to 'seeded'; the one-time
      // hydrator leaves the application's write in place.
      expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('CHANGED');
    } finally {
      await ctx.close();
    }
  });

  it('restores multiple origins in one context', async () => {
    const ctx = await browser.newContext({
      storageState: {
        localStorage: {
          [s1.origin]: { token: 'one' },
          [s2.origin]: { token: 'two' },
        },
      },
    });
    try {
      const page = await ctx.newPage();
      await page.navigateTo(`${s1.origin}/app.html`);
      expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('one');
      await page.navigateTo(`${s2.origin}/app.html`);
      expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('two');
    } finally {
      await ctx.close();
    }
  });

  it('restores localStorage at launch into the default context', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cd-auth-'));
    const file = path.join(dir, 'state.json');
    await fs.writeFile(file, JSON.stringify({ localStorage: { [s1.origin]: { token: 'launchseed' } } }));
    const b = await Browser.launch({ browserName: BROWSER_NAME, headless: true, storageState: file });
    try {
      await b.navigateTo(`${s1.origin}/app.html`);
      expect(await b.evaluate(() => localStorage.getItem('token'))).toBe('launchseed');
    } finally {
      await b.quit();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
