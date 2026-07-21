/**
 * The private hydration context must stay invisible even when a context already
 * has page tracking armed (a `'page'` listener or a route) at the moment
 * loadStorageState runs — it must not emit a phantom `'page'` event, enter
 * `pages()`, or receive user routes.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

  it('does not invoke browser-global mocks for the private hydration request', async () => {
    let hits = 0;
    const id = await browser.network.intercept('**/__craftdriver_hydrate__*', () => {
      hits += 1;
      return { status: 418, body: 'user mock' };
    });
    try {
      await browser.defaultContext.loadStorageState({
        localStorage: { [s1.origin]: { token: 'x' } },
      });
      expect(hits).toBe(0);
    } finally {
      await browser.network.removeIntercept(id);
    }
  });

  it('does not satisfy context.waitForPage() with the private hydration page', async () => {
    const ctx = await browser.newContext();
    try {
      let realPageId = '';
      let actionFinished!: () => void;
      const finished = new Promise<void>((resolve) => { actionFinished = resolve; });
      const page = await ctx.waitForPage(async () => {
        try {
          await ctx.loadStorageState({ localStorage: { [s1.origin]: { token: 'x' } } });
          realPageId = (await ctx.newPage()).id();
        } finally {
          actionFinished();
        }
      });
      await finished;
      expect(page.id()).toBe(realPageId);
    } finally {
      await ctx.close();
    }
  });

  it('does not satisfy browser.waitForPage() with the private hydration page', async () => {
    let realPageId = '';
    let actionFinished!: () => void;
    const finished = new Promise<void>((resolve) => { actionFinished = resolve; });
    const page = await browser.waitForPage(async () => {
      try {
        await browser.defaultContext.loadStorageState({
          localStorage: { [s1.origin]: { token: 'x' } },
        });
        realPageId = (await browser.openPage()).id();
      } finally {
        actionFinished();
      }
    });
    await finished;
    expect(page.id()).toBe(realPageId);
    await page.close();
  });

  it('does not expose hydration traffic to public network observers', async () => {
    const seen: string[] = [];
    const off = browser.network.on('request', (req) => seen.push(req.url));
    try {
      await browser.defaultContext.loadStorageState({
        localStorage: { [s1.origin]: { token: 'x' } },
      });
      expect(seen.some((url) => url.includes('__craftdriver_hydrate__'))).toBe(false);
    } finally {
      off();
    }
  });

  it('does not expose the private page through pages() while hydration is active', async () => {
    const ctx = await browser.newContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const net = browser.network as any;
    const original = net.provideResponse.bind(net);
    let entered!: () => void;
    const atResponse = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    net.provideResponse = async (...args: unknown[]) => {
      entered();
      await gate;
      return original(...args);
    };
    try {
      const beforeBrowser = (await browser.pages()).length;
      const restore = ctx.loadStorageState({ localStorage: { [s1.origin]: { token: 'x' } } });
      await atResponse;
      expect(await ctx.pages()).toHaveLength(0);
      expect(await browser.pages()).toHaveLength(beforeBrowser);
      release();
      await restore;
    } finally {
      release();
      net.provideResponse = original;
      await ctx.close();
    }
  });

  it('keeps browser shortcuts and screenshots on the public page during hydration', async () => {
    await browser.navigateTo(`${s1.origin}/public.html`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const net = browser.network as any;
    const original = net.provideResponse.bind(net);
    let entered!: () => void;
    const atResponse = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    net.provideResponse = async (...args: unknown[]) => {
      entered();
      await gate;
      return original(...args);
    };
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cd-auth-shot-'));
    try {
      const restore = browser.defaultContext.loadStorageState({
        localStorage: { [s1.origin]: { token: 'x' } },
      });
      await atResponse;

      expect(await browser.evaluate(() => location.pathname)).toBe('/public.html');
      expect(await browser.evaluate(() => document.body.textContent)).toContain('app');
      const shot = path.join(outDir, 'public.png');
      await browser.screenshot({ path: shot });
      expect((await fs.stat(shot)).size).toBeGreaterThan(0);

      release();
      await restore;
    } finally {
      release();
      net.provideResponse = original;
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('does not write private hydration events into traces', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cd-auth-trace-'));
    try {
      await browser.startTrace({ outDir, screenshots: 'off', console: false });
      await browser.defaultContext.loadStorageState({
        localStorage: { [s1.origin]: { token: 'x' } },
      });
      await browser.stopTrace();
      const trace = await fs.readFile(path.join(outDir, 'trace.ndjson'), 'utf8');
      expect(trace).not.toContain('__craftdriver_hydrate__');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });

  it('does not run CraftDriver context init scripts in the hydration document', async () => {
    const ctx = await browser.newContext();
    try {
      await ctx.addInitScript(() => {
        try {
          const count = Number(localStorage.getItem('initCount') || '0');
          localStorage.setItem('initCount', String(count + 1));
        } catch { /* opaque about:blank document */ }
      });
      await ctx.loadStorageState({ localStorage: { [s1.origin]: { token: 'x' } } });
      const page = await ctx.newPage({ url: `${s1.origin}/app.html` });
      expect(await page.evaluate(() => localStorage.getItem('initCount'))).toBe('1');
    } finally {
      await ctx.close();
    }
  });
});
