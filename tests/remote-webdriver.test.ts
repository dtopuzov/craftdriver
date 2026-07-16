/**
 * End-to-end coverage for `remote` launches against an in-process fake W3C
 * grid — `npm test` must never contact a real network service. Exercises
 * the full remote plumbing: `Browser.launch({ remote })` /
 * `Builder.usingServer()` / `Driver.create()` / `HttpClient` together,
 * something the narrower per-module tests (launchTarget-remote,
 * remote-endpoint, remote-capabilities, builder-remote,
 * http-client-remote-pool) don't cover in combination.
 *
 * Scope note: this suite stays at the Classic-WebDriver / Driver-level surface
 * for navigate/title/evaluate/screenshot — it does not stand up a real BiDi
 * WebSocket server, so it does not drive `Browser`'s Page/BrowserContext layer
 * over a live socket. The BiDi *fallback* path (no webSocketUrl → BiDi never
 * attempted) is covered here, and the webSocketUrl-redaction guarantee is
 * unit-tested via `redactUrlForLog` in remote-endpoint.test.ts. A full
 * BiDi-over-remote wire test (a fake BiDi WebSocket server) remains a
 * follow-up.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import fs from 'fs/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import { Browser } from '../src/lib/browser.js';
import { Builder } from '../src/lib/builder.js';
import { CraftdriverError, ErrorCode } from '../src/lib/errors.js';

interface CapturedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

interface FakeGridOptions {
  requireAuth?: { username: string; password: string };
  /** Extra capabilities merged into the session-create response's `capabilities`. */
  responseCapabilities?: Record<string, unknown>;
  /** Return >0 ms to delay the response for a matching request (simulates a slow hub). */
  delay?: (method: string, url: string) => number;
  /** Advertised as `capabilities.webSocketUrl` so the client negotiates BiDi. */
  webSocketUrl?: string;
}

/**
 * A minimal WebDriver-BiDi WebSocket server — just enough of the protocol for
 * a remote session to negotiate BiDi and round-trip one command. On connect
 * the client sends `browsingContext.getTree` + `session.subscribe`; answering
 * those makes `isBiDiEnabled()` true. Any other command gets a generic success
 * (safe because `initBiDi`'s post-connect context tracking is best-effort),
 * and `script.callFunction` returns a number so `evaluate()` resolves over the
 * live socket. Envelope per src/lib/bidi/connection.ts: `{ id, type, result }`.
 */
class FakeBidiServer {
  private wss?: WebSocketServer;

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
        const addr = this.wss!.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
      this.wss.on('connection', (ws: WebSocket) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString()) as { id: number; method: string };
          let result: unknown = {};
          if (msg.method === 'browsingContext.getTree') {
            result = {
              contexts: [{ context: 'ctx-1', url: 'about:blank', userContext: 'default', children: [] }],
            };
          } else if (msg.method === 'script.callFunction' || msg.method === 'script.evaluate') {
            result = { type: 'success', realm: 'realm-1', result: { type: 'number', value: 42 } };
          }
          ws.send(JSON.stringify({ id: msg.id, type: 'success', result }));
        });
      });
    });
  }

  async close(): Promise<void> {
    if (!this.wss) return;
    await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
    this.wss = undefined;
  }
}

class FakeGrid {
  server: http.Server;
  requests: CapturedRequest[] = [];
  private sessions = new Set<string>();
  private nextSessionId = 1;

  constructor(private opts: FakeGridOptions = {}) {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText ? JSON.parse(bodyText) : undefined;
      const method = req.method!;
      const url = req.url!;
      this.requests.push({ method, path: url, headers: req.headers, body });

      const dispatch = (): void => {
        // The client may have aborted (e.g. a command-timeout test) while a
        // delayed response was pending — writing to a dead socket would throw.
        if (res.writableEnded) return;
        try {
          this.route(req, res, method, url, body);
        } catch {
          /* client went away before the delayed response fired */
        }
      };

      const delayMs = this.opts.delay?.(method, url) ?? 0;
      if (delayMs > 0) setTimeout(dispatch, delayMs);
      else dispatch();
    });
  }

  private route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    url: string,
    body: any
  ): void {
    if (this.opts.requireAuth) {
      const expected =
        'Basic ' +
        Buffer.from(`${this.opts.requireAuth.username}:${this.opts.requireAuth.password}`).toString(
          'base64'
        );
      if (req.headers.authorization !== expected) {
        return this.json(res, 401, { value: { error: 'unauthorized', message: 'bad credentials' } });
      }
    }

    const sessionMatch = /^\/session\/([^/]+)(\/.*)?$/.exec(url);

    if (method === 'POST' && url === '/session') {
      const sessionId = `remote-session-${this.nextSessionId++}`;
      this.sessions.add(sessionId);
      const requestedCaps = body?.capabilities?.alwaysMatch ?? {};
      return this.json(res, 200, {
        value: {
          sessionId,
          capabilities: {
            ...requestedCaps,
            ...(this.opts.responseCapabilities ?? {}),
            ...(this.opts.webSocketUrl ? { webSocketUrl: this.opts.webSocketUrl } : {}),
          },
        },
      });
    }

    if (!sessionMatch) return this.json(res, 200, { value: 'ok' });
    const [, sessionId, rest] = sessionMatch;

    if (method === 'DELETE' && rest === undefined) {
      this.sessions.delete(sessionId);
      return this.json(res, 200, { value: null });
    }
    if (method === 'POST' && rest === '/url') {
      return this.json(res, 200, { value: null });
    }
    if (method === 'GET' && rest === '/title') {
      return this.json(res, 200, { value: 'Fake Grid Page' });
    }
    if (method === 'POST' && rest === '/execute/sync') {
      return this.json(res, 200, { value: 42 });
    }
    if (method === 'GET' && rest === '/screenshot') {
      return this.json(res, 200, { value: 'ZmFrZS1wbmc=' });
    }
    if (method === 'POST' && rest === '/se/file') {
      return this.json(res, 200, { value: '/remote/tmp/uploaded-file' });
    }
    return this.json(res, 200, { value: 'ok' });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

describe('remote WebDriver — fake grid', () => {
  let grid: FakeGrid | undefined;

  afterEach(async () => {
    if (grid) await grid.close();
    grid = undefined;
  });

  it('drives session creation → navigate → title → evaluate → screenshot → quit fully through the remote path', async () => {
    grid = new FakeGrid();
    const port = await grid.listen();
    const driver = await new Builder()
      .forBrowser('chrome')
      .usingServer({ protocol: 'http', hostname: '127.0.0.1', port })
      .build();

    await driver.navigateTo('https://example.com');
    expect(await driver.getTitle()).toBe('Fake Grid Page');
    expect(await driver.executeScript<number>('return 6 * 7')).toBe(42);
    expect(await driver.screenshotBase64()).toBe('ZmFrZS1wbmc=');
    await driver.quit();

    const methods = grid.requests.map((r) => `${r.method} ${r.path}`);
    expect(methods).toContain('POST /session');
    expect(methods.some((m) => /^DELETE \/session\/remote-session-\d+$/.test(m))).toBe(true);
  });

  it('Browser.launch({ remote }) never creates a downloads directory and rejects downloadsDir at launch time', async () => {
    grid = new FakeGrid();
    const port = await grid.listen();
    const mkdirSpy = vi.spyOn(fs, 'mkdir');

    const browser = await Browser.launch({
      remote: { url: `http://127.0.0.1:${port}` },
    } as any);
    expect(mkdirSpy).not.toHaveBeenCalled();
    await browser.quit();

    await expect(
      Browser.launch({
        remote: { url: `http://127.0.0.1:${port}` },
        downloadsDir: '/tmp/whatever',
      } as any)
    ).rejects.toThrow();
    expect(mkdirSpy).not.toHaveBeenCalled();
    mkdirSpy.mockRestore();
  });

  it('waitForDownload() throws UNSUPPORTED immediately on a remote session', async () => {
    grid = new FakeGrid();
    const port = await grid.listen();
    const browser = await Browser.launch({ remote: { url: `http://127.0.0.1:${port}` } } as any);
    try {
      let thrown: unknown;
      try {
        await browser.waitForDownload(() => {});
      } catch (err) {
        thrown = err;
      }
      expect(CraftdriverError.is(thrown, ErrorCode.UNSUPPORTED)).toBe(true);
    } finally {
      await browser.quit();
    }
  });

  it('sends Basic auth and never leaks the password in a thrown error', async () => {
    grid = new FakeGrid({ requireAuth: { username: 'alice', password: 'top-secret' } });
    const port = await grid.listen();

    await expect(
      Browser.launch({
        remote: { url: `http://127.0.0.1:${port}`, auth: { username: 'alice', password: 'wrong' } },
      } as any)
    ).rejects.toBeTruthy();

    const unauthorizedAttempt = grid.requests.find((r) => r.path === '/session');
    expect(unauthorizedAttempt?.headers.authorization).toBeDefined();

    const browser = await Browser.launch({
      remote: { url: `http://127.0.0.1:${port}`, auth: { username: 'alice', password: 'top-secret' } },
    } as any);
    await browser.quit();

    const authedAttempts = grid.requests.filter((r) => r.path === '/session' && r.method === 'POST');
    expect(authedAttempts.at(-1)?.headers.authorization).toBe(
      `Basic ${Buffer.from('alice:top-secret').toString('base64')}`
    );
  });

  it('passes a BrowserStack-shaped capability object through byte-for-byte', async () => {
    grid = new FakeGrid();
    const port = await grid.listen();
    const bstackOptions = { os: 'Windows', osVersion: '11', seleniumBidi: true };

    const browser = await Browser.launch({
      browserName: 'chrome',
      remote: {
        url: `http://127.0.0.1:${port}`,
        capabilities: { browserVersion: 'latest', 'bstack:options': bstackOptions },
      },
    } as any);
    await browser.quit();

    const sessionRequest = grid.requests.find((r) => r.method === 'POST' && r.path === '/session');
    const sentCaps = (sessionRequest?.body as any)?.capabilities?.alwaysMatch;
    expect(sentCaps['bstack:options']).toEqual(bstackOptions);
    expect(sentCaps.browserVersion).toBe('latest');
  });

  it('an unrecognized remote browser name defaults to Classic (no BiDi requested)', async () => {
    grid = new FakeGrid();
    const port = await grid.listen();
    const browser = await Browser.launch({
      browserName: 'some-custom-browser',
      remote: { url: `http://127.0.0.1:${port}` },
    } as any);
    try {
      expect(browser.isBiDiEnabled()).toBe(false);
    } finally {
      await browser.quit();
    }
  });

  it('does not attempt a BiDi connection when the grid never returns webSocketUrl, even with BiDi requested', async () => {
    grid = new FakeGrid();
    const port = await grid.listen();
    const browser = await Browser.launch({
      browserName: 'chrome',
      enableBiDi: true,
      remote: { url: `http://127.0.0.1:${port}` },
    } as any);
    try {
      expect(browser.isBiDiEnabled()).toBe(false);
    } finally {
      await browser.quit();
    }
  });

  it('concurrent remote sessions against one fake hub do not interfere (quit one, drive the other)', async () => {
    grid = new FakeGrid();
    const port = await grid.listen();

    const browserA = await Browser.launch({ remote: { url: `http://127.0.0.1:${port}` } } as any);
    const browserB = await Browser.launch({ remote: { url: `http://127.0.0.1:${port}` } } as any);

    await browserA.quit();
    // browserB must still be usable after A's keep-alive agent was destroyed.
    await expect(browserB.navigateTo('https://example.com')).resolves.toBeUndefined();
    await browserB.quit();
  });

  it('sends DELETE /session when post-launch init fails, so a paid session is never orphaned', async () => {
    grid = new FakeGrid();
    const port = await grid.listen();

    // POST /session succeeds, but loadState() throws on a nonexistent file —
    // the launch must tear the session down rather than leak it.
    await expect(
      Browser.launch({
        remote: { url: `http://127.0.0.1:${port}` },
        storageState: '/does/not/exist/craftdriver-state.json',
      } as any)
    ).rejects.toBeTruthy();

    const methods = grid.requests.map((r) => `${r.method} ${r.path}`);
    expect(methods).toContain('POST /session');
    expect(methods.some((m) => /^DELETE \/session\/remote-session-\d+$/.test(m))).toBe(true);
  });

  it('does not apply the local desktop-Safari touch guard to a remote Safari session', async () => {
    grid = new FakeGrid();
    const port = await grid.listen();
    // Provider-facing capital-S "Safari", exactly as BrowserStack documents it.
    const browser = await Browser.launch({
      browserName: 'Safari',
      remote: { url: `http://127.0.0.1:${port}` },
    } as any);
    try {
      // On a *local* Safari this throws UNSUPPORTED synchronously; on a remote
      // session (possibly a real touchscreen device) it must forward instead.
      await expect(
        browser.gesture.swipe({ from: [0, 0], to: [10, 10] })
      ).resolves.toBeUndefined();
    } finally {
      await browser.quit();
    }
  });

  it('honors commandTimeoutMs for a slow Classic command', async () => {
    grid = new FakeGrid({
      // Only the navigate command is slow; session-create/quit stay fast.
      delay: (method, url) => (method === 'POST' && url.endsWith('/url') ? 400 : 0),
    });
    const port = await grid.listen();
    const browser = await Browser.launch({
      browserName: 'chrome',
      remote: { url: `http://127.0.0.1:${port}`, commandTimeoutMs: 60 },
    } as any);
    try {
      await expect(browser.navigateTo('https://example.com')).rejects.toThrow(/timed out/i);
    } finally {
      await browser.quit();
    }
  });

  it('honors sessionTimeoutMs for a slow session-create', async () => {
    grid = new FakeGrid({
      delay: (method, url) => (method === 'POST' && url === '/session' ? 400 : 0),
    });
    const port = await grid.listen();
    await expect(
      Browser.launch({
        browserName: 'chrome',
        remote: { url: `http://127.0.0.1:${port}`, sessionTimeoutMs: 60 },
      } as any)
    ).rejects.toThrow(/timed out/i);
  });

  it('negotiates BiDi over a remote webSocketUrl and round-trips a command over the socket', async () => {
    const bidi = new FakeBidiServer();
    const wsPort = await bidi.listen();
    grid = new FakeGrid({ webSocketUrl: `ws://127.0.0.1:${wsPort}/session/ws` });
    const port = await grid.listen();
    try {
      const browser = await Browser.launch({
        browserName: 'chrome',
        enableBiDi: true,
        remote: { url: `http://127.0.0.1:${port}` },
      } as any);
      try {
        // The grid advertised a webSocketUrl → the client must actually connect
        // and negotiate BiDi (not fall back to Classic)...
        expect(browser.isBiDiEnabled()).toBe(true);
        // ...and a real BiDi command must round-trip over that live socket.
        expect(await browser.evaluate<number>(() => 42)).toBe(42);
      } finally {
        await browser.quit();
      }
    } finally {
      await bidi.close();
    }
  });
});
