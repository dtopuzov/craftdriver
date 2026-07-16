/**
 * Unit + fake-server coverage for `parseRemoteEndpoint()` (URL/auth
 * validation) and the `HttpClient` fixes it depends on: the base-path join
 * bug (a Grid's `/wd/hub` base path was silently dropped) and
 * Basic-auth header generation. No real network service is contacted.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { parseRemoteEndpoint, redactUrlForLog } from '../src/lib/remote.js';
import { HttpClient } from '../src/lib/http.js';
import { CraftdriverError } from '../src/lib/errors.js';
import type { WebDriverEndpoint } from '../src/lib/types.js';

describe('parseRemoteEndpoint', () => {
  it('parses a root-path https URL with no auth', () => {
    const { endpoint, sessionTimeoutMs } = parseRemoteEndpoint({ url: 'https://hub.example.com/' });
    expect(endpoint).toMatchObject({
      protocol: 'https',
      hostname: 'hub.example.com',
      port: 443,
      path: '',
      auth: undefined,
    });
    expect(typeof endpoint.poolKey).toBe('string');
    expect(sessionTimeoutMs).toBeUndefined();
  });

  it('preserves a Grid-style /wd/hub base path and explicit port', () => {
    const { endpoint } = parseRemoteEndpoint({ url: 'http://grid.internal:4444/wd/hub' });
    expect(endpoint).toMatchObject({
      protocol: 'http',
      hostname: 'grid.internal',
      port: 4444,
      path: '/wd/hub',
    });
  });

  it('strips a trailing slash from a non-root path', () => {
    const { endpoint } = parseRemoteEndpoint({ url: 'https://hub.example.com/wd/hub/' });
    expect(endpoint.path).toBe('/wd/hub');
  });

  it('defaults port 80 for http and 443 for https when omitted', () => {
    expect(parseRemoteEndpoint({ url: 'http://hub.example.com' }).endpoint.port).toBe(80);
    expect(parseRemoteEndpoint({ url: 'https://hub.example.com' }).endpoint.port).toBe(443);
  });

  it('handles an IPv6 host (hostname keeps WHATWG bracket notation, required to rebuild a valid origin)', () => {
    const { endpoint } = parseRemoteEndpoint({ url: 'http://[::1]:4444/wd/hub' });
    expect(endpoint.hostname).toBe('[::1]');
    expect(endpoint.port).toBe(4444);
    expect(endpoint.path).toBe('/wd/hub');
  });

  it('stamps a unique poolKey on every call', () => {
    const a = parseRemoteEndpoint({ url: 'https://hub.example.com' }).endpoint;
    const b = parseRemoteEndpoint({ url: 'https://hub.example.com' }).endpoint;
    expect(a.poolKey).not.toBe(b.poolKey);
  });

  it('extracts remote.auth as a structured field', () => {
    const { endpoint } = parseRemoteEndpoint({
      url: 'https://hub.example.com',
      auth: { username: 'alice', password: 's3cret' },
    });
    expect(endpoint.auth).toEqual({ username: 'alice', password: 's3cret' });
  });

  it('extracts URL-embedded user-info as auth (Selenium-migration compatibility)', () => {
    const { endpoint } = parseRemoteEndpoint({ url: 'https://bob:hunter2@hub.example.com/wd/hub' });
    expect(endpoint.auth).toEqual({ username: 'bob', password: 'hunter2' });
    expect(endpoint.hostname).toBe('hub.example.com');
    expect(endpoint.path).toBe('/wd/hub');
  });

  it('rejects both URL-embedded user-info and remote.auth being set', () => {
    expect(() =>
      parseRemoteEndpoint({
        url: 'https://bob:hunter2@hub.example.com',
        auth: { username: 'alice', password: 's3cret' },
      })
    ).toThrow(/both/);
  });

  it('rejects an empty username or password', () => {
    expect(() =>
      parseRemoteEndpoint({ url: 'https://hub.example.com', auth: { username: '', password: 'x' } })
    ).toThrow(/non-empty/);
    expect(() =>
      parseRemoteEndpoint({ url: 'https://hub.example.com', auth: { username: 'x', password: '' } })
    ).toThrow(/non-empty/);
  });

  it('rejects an auth object with missing username/password (no undefined:undefined Basic header)', () => {
    expect(() =>
      parseRemoteEndpoint({ url: 'https://hub.example.com', auth: {} as any })
    ).toThrow(/must be strings/);
  });

  it('rejects non-string auth fields', () => {
    expect(() =>
      parseRemoteEndpoint({
        url: 'https://hub.example.com',
        auth: { username: 123, password: true } as any,
      })
    ).toThrow(/must be strings/);
  });

  it('rejects a non-http(s) protocol', () => {
    expect(() => parseRemoteEndpoint({ url: 'ftp://hub.example.com' })).toThrow(/http or https/);
  });

  it('rejects a query string', () => {
    expect(() => parseRemoteEndpoint({ url: 'https://hub.example.com/wd/hub?foo=bar' })).toThrow(
      /query string/
    );
  });

  it('rejects a fragment', () => {
    expect(() => parseRemoteEndpoint({ url: 'https://hub.example.com/wd/hub#frag' })).toThrow(
      /fragment/
    );
  });

  it('rejects a malformed URL', () => {
    expect(() => parseRemoteEndpoint({ url: 'not a url' })).toThrow();
  });

  it('never echoes a credential-bearing malformed URL in the thrown error', () => {
    let err: unknown;
    try {
      parseRemoteEndpoint({ url: 'https://alice:super-secret@' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CraftdriverError);
    const serialized = JSON.stringify(
      err instanceof Error
        ? { message: err.message, detail: (err as CraftdriverError).detail }
        : err
    );
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('alice');
  });

  it('rejects a missing/empty url', () => {
    expect(() => parseRemoteEndpoint({ url: '' } as any)).toThrow(/remote\.url/);
  });

  it('rejects a non-object capabilities value', () => {
    expect(() =>
      parseRemoteEndpoint({ url: 'https://hub.example.com', capabilities: 'nope' as any })
    ).toThrow(/capabilities/);
  });

  it('rejects a non-positive sessionTimeoutMs/commandTimeoutMs', () => {
    expect(() =>
      parseRemoteEndpoint({ url: 'https://hub.example.com', sessionTimeoutMs: 0 })
    ).toThrow(/sessionTimeoutMs/);
    expect(() =>
      parseRemoteEndpoint({ url: 'https://hub.example.com', commandTimeoutMs: -5 })
    ).toThrow(/commandTimeoutMs/);
  });

  it('passes sessionTimeoutMs through separately from the endpoint (per-session-create only)', () => {
    const { endpoint, sessionTimeoutMs } = parseRemoteEndpoint({
      url: 'https://hub.example.com',
      sessionTimeoutMs: 60_000,
    });
    expect(sessionTimeoutMs).toBe(60_000);
    expect((endpoint as any).sessionTimeoutMs).toBeUndefined();
  });

  it('carries commandTimeoutMs onto the endpoint (applies to every command)', () => {
    const { endpoint } = parseRemoteEndpoint({
      url: 'https://hub.example.com',
      commandTimeoutMs: 30_000,
    });
    expect(endpoint.commandTimeoutMs).toBe(30_000);
  });
});

describe('redactUrlForLog', () => {
  it('strips embedded user-info, query string, and fragment (BiDi webSocketUrl secrets)', () => {
    const redacted = redactUrlForLog('wss://user:token@bidi.example.com/ws?access=super-secret#frag');
    expect(redacted).toBe('wss://bidi.example.com/ws');
    expect(redacted).not.toContain('token');
    expect(redacted).not.toContain('super-secret');
  });

  it('returns a fixed placeholder for an unparseable URL rather than echoing it', () => {
    expect(redactUrlForLog('::::not a url::::')).toBe('<unparseable-url-redacted>');
  });
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

describe('HttpClient — base-path join fix', () => {
  let server: http.Server | undefined;
  let lastRequestPath: string | undefined;
  let lastAuthHeader: string | undefined;

  afterEach(async () => {
    if (!server) return;
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  async function startFakeGrid(): Promise<number> {
    server = http.createServer((req, res) => {
      lastRequestPath = req.url;
      lastAuthHeader = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: 'ok' }));
    });
    return listen(server);
  }

  it('preserves a /wd/hub base path when joining a request path', async () => {
    const port = await startFakeGrid();
    const endpoint: WebDriverEndpoint = {
      protocol: 'http',
      hostname: '127.0.0.1',
      port,
      path: '/wd/hub',
    };
    const client = new HttpClient(endpoint);
    await client.send({ method: 'GET', path: '/session/abc/url' });
    expect(lastRequestPath).toBe('/wd/hub/session/abc/url');
  });

  it('is byte-identical to the previous behavior for a local endpoint (empty path)', async () => {
    const port = await startFakeGrid();
    const endpoint: WebDriverEndpoint = { protocol: 'http', hostname: '127.0.0.1', port, path: '' };
    const client = new HttpClient(endpoint);
    await client.send({ method: 'GET', path: '/session/abc/url' });
    expect(lastRequestPath).toBe('/session/abc/url');
  });

  it('is unchanged when endpoint.path is omitted entirely', async () => {
    const port = await startFakeGrid();
    const endpoint: WebDriverEndpoint = { protocol: 'http', hostname: '127.0.0.1', port };
    const client = new HttpClient(endpoint);
    await client.send({ method: 'GET', path: '/status' });
    expect(lastRequestPath).toBe('/status');
  });

  it('sends a Basic auth header for a known credential pair', async () => {
    const port = await startFakeGrid();
    const endpoint: WebDriverEndpoint = {
      protocol: 'http',
      hostname: '127.0.0.1',
      port,
      auth: { username: 'alice', password: 's3cret' },
    };
    const client = new HttpClient(endpoint);
    await client.send({ method: 'GET', path: '/status' });
    expect(lastAuthHeader).toBe(`Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
  });

  it('sends no Authorization header when the endpoint has no auth', async () => {
    const port = await startFakeGrid();
    const endpoint: WebDriverEndpoint = { protocol: 'http', hostname: '127.0.0.1', port };
    const client = new HttpClient(endpoint);
    await client.send({ method: 'GET', path: '/status' });
    expect(lastAuthHeader).toBeUndefined();
  });

  it('never includes the endpoint or its auth field in a thrown driver error', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: { error: 'invalid session id', message: 'nope' } }));
    });
    const port = await listen(server);
    const endpoint: WebDriverEndpoint = {
      protocol: 'http',
      hostname: '127.0.0.1',
      port,
      auth: { username: 'alice', password: 'super-secret-password' },
    };
    const client = new HttpClient(endpoint);
    const err = await client.send({ method: 'GET', path: '/status' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CraftdriverError);
    const serialized = JSON.stringify(err instanceof Error ? { message: err.message, detail: (err as CraftdriverError).detail } : err);
    expect(serialized).not.toContain('super-secret-password');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain(Buffer.from('alice:super-secret-password').toString('base64'));
  });
});
