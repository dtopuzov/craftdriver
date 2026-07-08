/**
 * Regression coverage for the `timeoutMs` option on HttpClient.send() (see
 * Driver.create(), the one call site that sets it for POST /session).
 *
 * Reproduces the CI failure mode that motivated this: a driver process that
 * accepts the connection but never responds (e.g. because the browser it
 * spawned hung or crashed mid-handshake) used to leave Browser.launch()
 * pending forever, with nothing in craftdriver to detect or report it — only
 * an external timeout (a test framework's hook timeout) ever unblocked it,
 * and that produced a bare "Hook timed out" with no indication craftdriver
 * was even involved.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { HttpClient } from '../src/lib/http.js';
import { CraftdriverError, ErrorCode } from '../src/lib/errors.js';
import type { WebDriverEndpoint } from '../src/lib/types.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

function endpointFor(port: number): WebDriverEndpoint {
  return { protocol: 'http', hostname: '127.0.0.1', port, path: '' };
}

describe('HttpClient timeoutMs', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (!server) return;
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it('rejects with a clear DRIVER_ERROR instead of hanging when the server never responds', async () => {
    server = http.createServer(() => {
      // Deliberately never call res.end() — simulates a driver whose browser
      // hung mid-session-creation: the connection is accepted, nothing comes back.
    });
    const port = await listen(server);
    const client = new HttpClient(endpointFor(port));

    const start = Date.now();
    const err = await client
      .send({ method: 'POST', path: '/session', body: {}, timeoutMs: 200 })
      .catch((e: unknown) => e);
    const elapsed = Date.now() - start;

    expect(CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)).toBe(true);
    expect((err as CraftdriverError).message).toMatch(/timed out after 200ms/);
    // Bounded by timeoutMs, not left hanging until some outer caller gives up.
    expect(elapsed).toBeLessThan(1000);
  });

  it('does not fire when the response arrives before the timeout (happy path unaffected)', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: { sessionId: 'abc-123' } }));
    });
    const port = await listen(server);
    const client = new HttpClient(endpointFor(port));

    const result = await client.send<{ sessionId: string }>({
      method: 'POST',
      path: '/session',
      body: {},
      timeoutMs: 5000,
    });

    expect(result.value).toMatchObject({ sessionId: 'abc-123' });
  });

  it('never times out when timeoutMs is omitted, even for a response that takes a while', async () => {
    server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ value: 'ok' }));
      }, 150);
    });
    const port = await listen(server);
    const client = new HttpClient(endpointFor(port));

    const result = await client.send({ method: 'GET', path: '/status' });
    expect(result.value).toBe('ok');
  });
});
