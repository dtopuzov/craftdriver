/**
 * Unit tests for `Builder.usingServer()` — the code path that creates a
 * WebDriver session without a `DriverService`. `spawn` is mocked so a
 * regression that accidentally falls through to the local path is caught by a
 * failing assertion, not a hung real process spawn.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { Builder } from '../src/lib/builder.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

describe('Builder.usingServer()', () => {
  let server: http.Server | undefined;
  let requests: Array<{ method: string; path: string; body: unknown }> = [];

  afterEach(async () => {
    spawnMock.mockClear();
    requests = [];
    if (!server) return;
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  async function startFakeGrid(opts?: { failSession?: boolean }): Promise<number> {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        requests.push({ method: req.method!, path: req.url!, body });

        if (req.method === 'POST' && req.url === '/session') {
          if (opts?.failSession) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ value: { error: 'session not created', message: 'boom' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ value: { sessionId: 'remote-session-1', capabilities: {} } }));
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ value: null }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: 'ok' }));
      });
    });
    return listen(server);
  }

  it('never spawns a child process', async () => {
    const port = await startFakeGrid();
    const driver = await new Builder()
      .forBrowser('chrome')
      .usingServer({ protocol: 'http', hostname: '127.0.0.1', port })
      .build();
    expect(spawnMock).not.toHaveBeenCalled();
    await driver.quit();
  });

  it('POSTs the exact W3C session-creation body', async () => {
    const port = await startFakeGrid();
    const driver = await new Builder()
      .forBrowser('chrome')
      .usingServer({ protocol: 'http', hostname: '127.0.0.1', port })
      .withCapabilities({ 'bstack:options': { os: 'Windows' } })
      .build();
    const sessionRequest = requests.find((r) => r.method === 'POST' && r.path === '/session');
    expect(sessionRequest?.body).toEqual({
      capabilities: { alwaysMatch: { browserName: 'chrome', 'bstack:options': { os: 'Windows' } } },
    });
    await driver.quit();
  });

  it('creates exactly one POST /session on failure — no retry loop', async () => {
    const port = await startFakeGrid({ failSession: true });
    await expect(
      new Builder()
        .forBrowser('chrome')
        .usingServer({ protocol: 'http', hostname: '127.0.0.1', port })
        .build()
    ).rejects.toThrow();
    const sessionRequests = requests.filter((r) => r.method === 'POST' && r.path === '/session');
    expect(sessionRequests).toHaveLength(1);
  });

  it('quit() sends exactly one DELETE /session/{id}', async () => {
    const port = await startFakeGrid();
    const driver = await new Builder()
      .forBrowser('chrome')
      .usingServer({ protocol: 'http', hostname: '127.0.0.1', port })
      .build();
    await driver.quit();
    const deletes = requests.filter((r) => r.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].path).toBe('/session/remote-session-1');
  });
});
