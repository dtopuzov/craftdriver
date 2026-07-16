/**
 * Regression coverage for remote connection-pool isolation: keep-alive agents
 * used to be keyed by
 * `protocol//host:port` only, so `HttpClient.close()` (called by
 * `Driver.quit()`) would destroy every session's sockets sharing that
 * host:port — harmless locally (every local DriverService picks its own
 * free port) but wrong for a remote grid/hub, where many concurrent
 * sessions legitimately share one host:port. `parseRemoteEndpoint()` now
 * stamps a unique `poolKey` per remote session; this file locks in that
 * "quit A must not break B" property against a fake grid.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { HttpClient } from '../src/lib/http.js';
import { parseRemoteEndpoint } from '../src/lib/remote.js';
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

describe('HttpClient — remote per-session pool key', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (!server) return;
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it('gives two remote endpoints on the same host:port different poolKeys and different agents', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: 'ok' }));
    });
    const port = await listen(server);

    const a = parseRemoteEndpoint({ url: `http://127.0.0.1:${port}` }).endpoint;
    const b = parseRemoteEndpoint({ url: `http://127.0.0.1:${port}` }).endpoint;
    expect(a.poolKey).not.toBe(b.poolKey);
  });

  it('quitting session A does not break an in-flight command on session B sharing one hub host:port', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: 'ok' }));
    });
    const port = await listen(server);

    const endpointA = parseRemoteEndpoint({ url: `http://127.0.0.1:${port}` }).endpoint;
    const endpointB = parseRemoteEndpoint({ url: `http://127.0.0.1:${port}` }).endpoint;
    const clientA = new HttpClient(endpointA);
    const clientB = new HttpClient(endpointB);

    await clientA.send({ method: 'GET', path: '/status' });
    await clientB.send({ method: 'GET', path: '/status' });

    clientA.close();

    // B's agent must still be usable after A's is destroyed.
    const result = await clientB.send({ method: 'GET', path: '/status' });
    expect(result.value).toBe('ok');
  });

  it('two local endpoints on different ports still get independent agents keyed by host:port (unchanged)', async () => {
    const serverA = http.createServer((_req, res) => res.end(JSON.stringify({ value: 'a' })));
    const serverB = http.createServer((_req, res) => res.end(JSON.stringify({ value: 'b' })));
    const portA = await listen(serverA);
    const portB = await listen(serverB);
    try {
      const endpointA: WebDriverEndpoint = { protocol: 'http', hostname: '127.0.0.1', port: portA };
      const endpointB: WebDriverEndpoint = { protocol: 'http', hostname: '127.0.0.1', port: portB };
      const clientA = new HttpClient(endpointA);
      const clientB = new HttpClient(endpointB);

      const resA = await clientA.send({ method: 'GET', path: '/status' });
      const resB = await clientB.send({ method: 'GET', path: '/status' });
      expect(resA.value).toBe('a');
      expect(resB.value).toBe('b');

      clientA.close();
      const resB2 = await clientB.send({ method: 'GET', path: '/status' });
      expect(resB2.value).toBe('b');
    } finally {
      await new Promise<void>((resolve) => serverA.close(() => resolve()));
      await new Promise<void>((resolve) => serverB.close(() => resolve()));
    }
  });
});
