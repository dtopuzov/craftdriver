/**
 * Operation-specific restore policy + hardening (BiDi):
 *  - context/launch APIs reject non-empty sessionStorage before any mutation;
 *  - active-page APIs restore a single matching origin's sessionStorage and
 *    fail before mutation on mismatch / multi-origin;
 *  - an empty sessionStorage section is a no-op;
 *  - a failed newContext restore leaves no orphaned user context;
 *  - the internal hydration intercept is strict: zero hydration requests reach
 *    the server, even when provideResponse is made to fail.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import http from 'node:http';
import { Browser, CraftdriverError, ErrorCode } from '../src';
import { BROWSER_NAME } from './utils';

const APP_HTML = '<!doctype html><html><head></head><body>app</body></html>';

let hydrateHits = 0;

function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if ((req.url || '').includes('__craftdriver_hydrate__')) hydrateHits += 1;
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

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe('auth-state restore policy (BiDi)', () => {
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

  // ── context/launch APIs reject sessionStorage ──────────────────────────────

  it('loadStorageState rejects non-empty sessionStorage before applying cookies', async () => {
    const ctx = await browser.newContext();
    try {
      const err = await caught(
        ctx.loadStorageState({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cookies: [{ name: 'sid', value: 'x', domain: '127.0.0.1', path: '/' } as any],
          sessionStorage: { [s1.origin]: { tok: 'v' } },
        })
      );
      expect(CraftdriverError.is(err, ErrorCode.UNSUPPORTED)).toBe(true);
      // Rejected before mutation: the cookie was never applied.
      const cookies = await ctx.cookies();
      expect(cookies.find((c) => c.name === 'sid')).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it('newContext({storageState}) with sessionStorage throws and leaves no orphaned context', async () => {
    const before = (await browser.contexts()).length;
    const err = await caught(
      browser.newContext({ storageState: { sessionStorage: { [s1.origin]: { tok: 'v' } } } })
    );
    expect(CraftdriverError.is(err, ErrorCode.UNSUPPORTED)).toBe(true);
    expect((await browser.contexts()).length).toBe(before);
  });

  it('an empty sessionStorage section is a no-op, not an error', async () => {
    const ctx = await browser.newContext({
      storageState: { localStorage: { [s1.origin]: { token: 'seeded' } }, sessionStorage: {} },
    });
    try {
      const page = await ctx.newPage();
      await page.navigateTo(`${s1.origin}/app.html`);
      expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('seeded');
    } finally {
      await ctx.close();
    }
  });

  // ── active-page APIs preserve sessionStorage, with origin constraints ───────

  it('browser.loadState restores sessionStorage for the single active matching origin', async () => {
    await browser.navigateTo(`${s1.origin}/app.html`);
    await browser.evaluate(() => sessionStorage.clear());
    await browser.loadState({
      sessionStorage: { [s1.origin]: { stok: 'sess' } },
      localStorage: { [s1.origin]: { ltok: 'loc' } },
    });
    expect(await browser.evaluate(() => sessionStorage.getItem('stok'))).toBe('sess');
    expect(await browser.evaluate(() => localStorage.getItem('ltok'))).toBe('loc');
  });

  it('browser.loadState rejects sessionStorage for a non-active origin before mutation', async () => {
    await browser.navigateTo(`${s1.origin}/app.html`);
    await browser.evaluate(() => sessionStorage.clear());
    const err = await caught(
      browser.loadState({ sessionStorage: { [s2.origin]: { stok: 'sess' } } })
    );
    expect(CraftdriverError.is(err, ErrorCode.STATE_INVALID)).toBe(true);
    expect(await browser.evaluate(() => sessionStorage.getItem('stok'))).toBeNull();
  });

  it('browser.loadState rejects multi-origin sessionStorage', async () => {
    await browser.navigateTo(`${s1.origin}/app.html`);
    const err = await caught(
      browser.loadState({
        sessionStorage: { [s1.origin]: { a: '1' }, [s2.origin]: { b: '2' } },
      })
    );
    expect(CraftdriverError.is(err, ErrorCode.INVALID_ARGUMENT)).toBe(true);
  });

  // ── strict internal intercept: zero hydration requests reach the server ─────

  it('hydration never sends the hydrate request to the origin server', async () => {
    const before = hydrateHits;
    const ctx = await browser.newContext({
      storageState: { localStorage: { [s1.origin]: { token: 'x' } } },
    });
    await ctx.close();
    expect(hydrateHits).toBe(before);
  });

  it('an injected provideResponse failure fails hydration and still reaches the server zero times', async () => {
    // browser.network is the same interceptor the hydrator uses (via the
    // context's getNetwork hook), so patching provideResponse exercises the
    // strict path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const net = browser.network as any;
    const original = net.provideResponse.bind(net);
    net.provideResponse = () => {
      throw new Error('injected provideResponse failure');
    };
    try {
      const before = hydrateHits;
      const err = await caught(
        browser.defaultContext.loadStorageState({ localStorage: { [s1.origin]: { token: 'x' } } })
      );
      expect(CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)).toBe(true);
      expect((err as CraftdriverError).detail).toMatchObject({
        feature: 'storageState',
        protocol: 'bidi',
        phase: 'localStorage',
        partialApplied: false,
      });
      expect(hydrateHits).toBe(before); // strict → failRequest → nothing reached the server
    } finally {
      net.provideResponse = original;
    }
  });

  it('serializes concurrent restores within one context', async () => {
    const ctx = await browser.newContext();
    // Instrument the private seam so the assertion covers ordering rather than
    // relying on final-value timing, which could pass accidentally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = ctx as any;
    const original = internal._hydrateLocalStorage.bind(ctx);
    let active = 0;
    let maxActive = 0;
    internal._hydrateLocalStorage = async (...args: unknown[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 40));
      try {
        return await original(...args);
      } finally {
        active -= 1;
      }
    };
    try {
      await Promise.all([
        ctx.loadStorageState({ localStorage: { [s1.origin]: { token: 'one' } } }),
        ctx.loadStorageState({ localStorage: { [s1.origin]: { token: 'two' } } }),
      ]);
      expect(maxActive).toBe(1);
    } finally {
      internal._hydrateLocalStorage = original;
      await ctx.close();
    }
  });

  it('allows different contexts to restore concurrently', async () => {
    const one = await browser.newContext();
    const two = await browser.newContext();
    let active = 0;
    let maxActive = 0;
    const restorePatches: Array<{ target: any; original: (...args: unknown[]) => Promise<void> }> = [];
    for (const ctx of [one, two]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const target = ctx as any;
      const original = target._hydrateLocalStorage.bind(ctx);
      restorePatches.push({ target, original });
      target._hydrateLocalStorage = async (...args: unknown[]) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 40));
        try {
          return await original(...args);
        } finally {
          active -= 1;
        }
      };
    }
    try {
      await Promise.all([
        one.loadStorageState({ localStorage: { [s1.origin]: { token: 'one' } } }),
        two.loadStorageState({ localStorage: { [s2.origin]: { token: 'two' } } }),
      ]);
      expect(maxActive).toBe(2);
    } finally {
      for (const { target, original } of restorePatches) target._hydrateLocalStorage = original;
      await one.close();
      await two.close();
    }
  });

  it('reports a runtime cookie failure after localStorage as possibly partial', async () => {
    const ctx = await browser.newContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = ctx as any;
    const original = internal.addCookies.bind(ctx);
    internal.addCookies = async () => { throw new Error('injected cookie failure'); };
    try {
      const err = await caught(ctx.loadStorageState({
        localStorage: { [s1.origin]: { partial: 'yes' } },
        cookies: [{ name: 'sid', value: 'x', domain: '127.0.0.1', path: '/' } as any],
      }));
      expect(CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)).toBe(true);
      expect((err as CraftdriverError).detail).toMatchObject({
        feature: 'storageState',
        protocol: 'bidi',
        phase: 'cookies',
        partialApplied: true,
      });
      const page = await ctx.newPage({ url: `${s1.origin}/app.html` });
      expect(await page.evaluate(() => localStorage.getItem('partial'))).toBe('yes');
    } finally {
      internal.addCookies = original;
      await ctx.close();
    }
  });

  it('wraps an existing driver error in structured restore metadata', async () => {
    const ctx = await browser.newContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = ctx as any;
    const original = internal._hydrateLocalStorage.bind(ctx);
    internal._hydrateLocalStorage = async () => {
      throw new CraftdriverError(ErrorCode.DRIVER_ERROR, 'injected protocol failure');
    };
    try {
      const err = await caught(ctx.loadStorageState({
        localStorage: { [s1.origin]: { token: 'x' } },
      }));
      expect(CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)).toBe(true);
      expect((err as CraftdriverError).detail).toMatchObject({
        feature: 'storageState',
        protocol: 'bidi',
        phase: 'localStorage',
        partialApplied: false,
      });
    } finally {
      internal._hydrateLocalStorage = original;
      await ctx.close();
    }
  });

  it('browser.storage.setState uses the shared validator', async () => {
    const err = await caught(browser.storage.setState({ bogus: true } as never));
    expect(CraftdriverError.is(err, ErrorCode.UNSUPPORTED)).toBe(true);
  });
});
