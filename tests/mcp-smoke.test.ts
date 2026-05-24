/**
 * MCP server smoke tests — spawn `craftdriver mcp` as a child process,
 * speak JSON-RPC 2.0 over its stdio, and assert on the protocol surface.
 *
 * No LLM in the loop: MCP is a deterministic protocol, the model is just
 * the production *client*. The test harness plays that role.
 *
 * Requires `npm run build` first (the bin shim loads `dist/cli/index.js`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

const here = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(here, '..', 'bin', 'craftdriver.mjs');

interface RpcSuccess {
  jsonrpc: '2.0';
  id: number;
  result: Record<string, unknown>;
}
interface RpcFailure {
  jsonrpc: '2.0';
  id: number;
  error: { code: number; message: string };
}
type RpcResponse = RpcSuccess | RpcFailure;

/**
 * Minimal MCP client over a child process. One pending request at a
 * time is enough for a smoke test — easier to reason about than
 * interleaved responses.
 */
class McpHarness {
  private child!: ChildProcessWithoutNullStreams;
  private buf = '';
  private pending = new Map<number, (resp: RpcResponse) => void>();
  private nextId = 1;
  private stderr = '';

  async start(): Promise<void> {
    this.child = spawn(
      'node',
      [CLI_BIN, 'mcp', '--browser', BROWSER_NAME],
      {
        env: { ...process.env, HEADLESS: 'true' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg: RpcResponse;
        try {
          msg = JSON.parse(line) as RpcResponse;
        } catch {
          continue;
        }
        const cb = this.pending.get(msg.id);
        if (cb) {
          this.pending.delete(msg.id);
          cb(msg);
        }
      }
    });
    this.child.stderr.on('data', (b: Buffer) => (this.stderr += b.toString('utf8')));

    // Handshake.
    const init = (await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'craftdriver-test', version: '0' },
    })) as RpcSuccess;
    expect(init.result).toBeDefined();
    // Spec: clients send `notifications/initialized` after `initialize`.
    this.notify('notifications/initialized', {});
  }

  async stop(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolveClose) => {
      this.child.on('close', () => resolveClose());
      // Safety net — kill after 5 s if the server hangs on shutdown.
      setTimeout(() => this.child.kill(), 5000).unref();
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const id = this.nextId++;
    return new Promise<RpcResponse>((resolveReq) => {
      this.pending.set(id, resolveReq);
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      );
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n',
    );
  }

  get capturedStderr(): string {
    return this.stderr;
  }
}

describe('MCP smoke', () => {
  const mcp = new McpHarness();
  const loginUrl = `${EXAMPLES_BASE_URL}/login.html`;

  beforeAll(async () => {
    await mcp.start();
  });

  afterAll(async () => {
    await mcp.stop();
  });

  it('tools/list returns the 14 documented tools', async () => {
    const resp = (await mcp.request('tools/list', {})) as RpcSuccess;
    const tools = resp.result.tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'browser_advanced_eval',
        'browser_click',
        'browser_exists',
        'browser_fill',
        'browser_find',
        'browser_hover',
        'browser_navigate',
        'browser_pages',
        'browser_press',
        'browser_read',
        'browser_screenshot',
        'browser_snapshot',
        'browser_status',
        'browser_wait',
      ].sort(),
    );
  });

  it('navigate + snapshot returns refs for known controls', async () => {
    const nav = (await mcp.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: loginUrl },
    })) as RpcSuccess;
    const navResult = nav.result as { isError?: boolean; structuredContent: { result: unknown } };
    expect(navResult.isError).toBeFalsy();

    const snap = (await mcp.request('tools/call', {
      name: 'browser_snapshot',
      arguments: {},
    })) as RpcSuccess;
    const snapResult = snap.result as {
      isError?: boolean;
      structuredContent: { result: { url: string; lines: string[] } };
    };
    expect(snapResult.isError).toBeFalsy();
    const { url, lines } = snapResult.structuredContent.result;
    expect(url).toContain('/login.html');
    const all = lines.join('\n');
    expect(all).toMatch(/e\d+: textbox .*Username/);
    expect(all).toMatch(/e\d+: textbox .*Password/);
    expect(all).toMatch(/e\d+: button .*Sign in/i);
  });

  it('surfaces stable error codes via isError + structuredContent.error', async () => {
    const resp = (await mcp.request('tools/call', {
      name: 'browser_click',
      // Bound the per-call timeout so a missing selector fails fast
      // regardless of whether the library short-circuits at t=0 or
      // burns the full wait window.
      arguments: { selector: '#definitely-not-here', timeout_ms: 200 },
    })) as RpcSuccess;
    const result = resp.result as {
      isError: boolean;
      structuredContent: { error: { code: string; message: string } };
    };
    expect(result.isError).toBe(true);
    // Stable, agent-readable error code. The library may surface
    // NO_MATCH (zero matches at t=0), TIMEOUT_WAITING_VISIBLE (matched
    // but never actionable), or generic TIMEOUT — all valid signals.
    expect(result.structuredContent.error.code).toMatch(
      /^(NO_MATCH|TIMEOUT(_WAITING_(VISIBLE|STATE))?)$/,
    );
  });
});
