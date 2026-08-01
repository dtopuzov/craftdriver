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
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';
import { TOOLS } from '../src/cli/mcp/tools';

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

function parseRpcLine(line: string): RpcResponse | undefined {
  try {
    return JSON.parse(line) as RpcResponse;
  } catch {
    return undefined;
  }
}

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
  /** Extra environment for the spawned server (e.g. an owned trace root). */
  extraEnv?: Record<string, string>;

  async start(): Promise<void> {
    this.child = spawn('node', [CLI_BIN, 'mcp', '--browser', BROWSER_NAME], {
      env: { ...process.env, HEADLESS: 'true', ...(this.extraEnv ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        const msg = parseRpcLine(line);
        if (!msg) continue;
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
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  get capturedStderr(): string {
    return this.stderr;
  }
}

describe('MCP smoke', () => {
  const mcp = new McpHarness();
  const loginUrl = `${EXAMPLES_BASE_URL}/login.html`;
  const traceRoot = mkdtempSync(join(tmpdir(), 'craftdriver-mcp-trace-'));

  beforeAll(async () => {
    mcp.extraEnv = { CRAFTDRIVER_TRACE_DIR: traceRoot };
    await mcp.start();
  });

  afterAll(async () => {
    await mcp.stop();
    rmSync(traceRoot, { recursive: true, force: true });
  });

  it('tools/list advertises exactly the registered tools, with schemas', async () => {
    const resp = (await mcp.request('tools/list', {})) as RpcSuccess;
    const tools = resp.result.tools as Array<{
      name: string;
      inputSchema: { type: string; additionalProperties: boolean };
      annotations: { title: string; readOnlyHint: boolean };
    }>;

    // Pinned to the registry rather than a frozen list: the invariant is that
    // every registered tool is advertised, not that there are N of them.
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());

    // Every advertised tool carries a schema that refuses extra fields and
    // annotations a client can act on.
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations.title.length).toBeGreaterThan(0);
    }
  });

  it('rejects invalid arguments as -32602, before reaching the browser', async () => {
    const unknownField = (await mcp.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: 'http://127.0.0.1:1/', bogus: 1 },
    })) as { error?: { code: number; message: string } };
    expect(unknownField.error?.code).toBe(-32602);
    expect(unknownField.error?.message).toMatch(/unknown argument "bogus"/);

    const missing = (await mcp.request('tools/call', {
      name: 'browser_click',
      arguments: {},
    })) as { error?: { code: number } };
    expect(missing.error?.code).toBe(-32602);

    const unknownTool = (await mcp.request('tools/call', {
      name: 'browser_nope',
      arguments: {},
    })) as { error?: { code: number } };
    expect(unknownTool.error?.code).toBe(-32602);
  });

  it('records a trace into the owned root, not a caller-chosen path', async () => {
    // The tool deliberately no longer accepts an out_dir: the previous
    // MCP-only command took an unvalidated filesystem path straight off the
    // wire. Output lands in the owned root and the response reports where.
    const start = (await mcp.request('tools/call', {
      name: 'browser_trace',
      arguments: { action: 'start', name: 'mcplogin' },
    })) as RpcSuccess;
    expect((start.result as { isError?: boolean }).isError ?? false).toBe(false);

    await mcp.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: loginUrl },
    });
    const stop = (await mcp.request('tools/call', {
      name: 'browser_trace',
      arguments: { action: 'stop', zip: true },
    })) as RpcSuccess;
    const stopped = stop.result as {
      isError?: boolean;
      structuredContent?: { result?: { zip?: string } };
    };
    expect(stopped.isError ?? false).toBe(false);

    const zipPath = stopped.structuredContent?.result?.zip as string;
    expect(zipPath.startsWith(traceRoot)).toBe(true);
    expect(existsSync(zipPath)).toBe(true);
    expect(readFileSync(zipPath).subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('exposes the landed CLI surface with the same semantics', async () => {
    await mcp.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: loginUrl },
    });

    // browser_locators: the flagship of the write-a-test workflow. It must
    // return a durable candidate and never a ref, exactly as the CLI does.
    const locators = (await mcp.request('tools/call', {
      name: 'browser_locators',
      arguments: { selector: '#submit' },
    })) as RpcSuccess;
    const report = (
      locators.result as {
        structuredContent: { result: { best?: string; candidates: Array<{ status: string }> } };
      }
    ).structuredContent.result;
    expect(report.best).toBeTruthy();
    expect(report.best).not.toMatch(/ref=/);
    expect(report.candidates.some((c) => c.status === 'unique')).toBe(true);

    // browser_logs: capture is running from launch, so a message emitted
    // before the query is still answerable.
    await mcp.request('tools/call', {
      name: 'browser_advanced_eval',
      arguments: { js: 'console.error("mcp-parity-marker"); return 1' },
    });
    const logs = (await mcp.request('tools/call', {
      name: 'browser_logs',
      arguments: { action: 'wait', contains: 'mcp-parity-marker', timeout_ms: 10000 },
    })) as RpcSuccess;
    expect((logs.result as { isError?: boolean }).isError ?? false).toBe(false);

    // kind=error covers console.error, the query an agent actually types.
    const errors = (await mcp.request('tools/call', {
      name: 'browser_logs',
      arguments: { action: 'list', kind: 'error' },
    })) as RpcSuccess;
    const page = (
      errors.result as {
        structuredContent: { result: { entries: Array<{ kind: string }> } };
      }
    ).structuredContent.result;
    expect(page.entries.length).toBeGreaterThan(0);

    // browser_element: one tool, several real dispatcher commands behind it.
    const focused = (await mcp.request('tools/call', {
      name: 'browser_element',
      arguments: { action: 'focus', selector: '#username' },
    })) as RpcSuccess;
    expect((focused.result as { isError?: boolean }).isError ?? false).toBe(false);

    // browser_page: tabs, mirroring the CLI's action shape.
    const pages = (await mcp.request('tools/call', {
      name: 'browser_page',
      arguments: { action: 'list' },
    })) as RpcSuccess;
    const listed = (
      pages.result as {
        structuredContent: { result: { count: number } };
      }
    ).structuredContent.result;
    expect(listed.count).toBeGreaterThan(0);
  });

  it('navigate + snapshot returns refs for known controls', async () => {
    const nav = (await mcp.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: loginUrl },
    })) as RpcSuccess;
    const navResult = nav.result as { isError?: boolean; structuredContent: { result: unknown } };
    expect(navResult.isError ?? false).toBe(false);

    const snap = (await mcp.request('tools/call', {
      name: 'browser_snapshot',
      arguments: {},
    })) as RpcSuccess;
    const snapResult = snap.result as {
      isError?: boolean;
      structuredContent: { result: { url: string; lines: string[] } };
    };
    expect(snapResult.isError ?? false).toBe(false);
    const { url, lines } = snapResult.structuredContent.result;
    expect(url).toContain('/login.html');
    const all = lines.join('\n');
    expect(all).toMatch(/e\d+: textbox .*Username/);
    // No ARIA role for a password input; listed under its tag, still reffed.
    expect(all).toMatch(/e\d+: input .*Password/);
    expect(all).toMatch(/e\d+: button .*Sign in/i);
  });

  it('browser_fill submit shares the observed navigation semantics', async () => {
    await mcp.request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: `${EXAMPLES_BASE_URL}/reactive-search.html?delay=40` },
    });

    const fill = (await mcp.request('tools/call', {
      name: 'browser_fill',
      arguments: { selector: '#query', value: 'MCP Atomic', submit: true },
    })) as RpcSuccess;
    const result = fill.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
      structuredContent: { result: { submitted?: boolean } };
    };

    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent.result.submitted).toBe(true);
    expect(result.content.map((item) => item.text ?? '').join('\n')).toContain(
      'heading "MCP Atomic"'
    );
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
      /^(NO_MATCH|TIMEOUT(_WAITING_(VISIBLE|STATE))?)$/
    );
  });

  it('surfaces WebDriver protocol detail in structured errors', async () => {
    const resp = (await mcp.request('tools/call', {
      name: 'browser_click',
      arguments: { selector: '[', timeout_ms: 200 },
    })) as RpcSuccess;
    const result = resp.result as {
      isError: boolean;
      structuredContent: {
        error: {
          code: string;
          detail?: Record<string, unknown>;
        };
      };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe('DRIVER_ERROR');
    expect(result.structuredContent.error.detail).toMatchObject({
      webDriverError: 'invalid selector',
    });
    expect(result.structuredContent.error.detail?.stacktrace).toBeUndefined();
  });
});
