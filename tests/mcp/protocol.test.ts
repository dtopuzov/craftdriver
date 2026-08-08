import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRunner } from '../../src/cli/agentSession.js';
import { TOOLS } from '../../src/cli/mcp/tools.js';
import {
  MCP_MAX_FRAME_BYTES,
  negotiateProtocolVersion,
  classifyJsonRpcMessage,
  decodeJsonLine,
  runMcpServer,
  serializeJsonRpcResponse,
} from '../../src/cli/mcp/server.js';

interface RpcMessage {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function collectOutput(output: PassThrough): { text: () => string; lines: () => RpcMessage[] } {
  let captured = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    captured += chunk;
  });
  return {
    text: () => captured,
    lines: () => captured
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RpcMessage),
  };
}

function fakeSession(): AgentSessionRunner {
  const run = vi.fn(async ({ cmd }: { cmd: string }) => cmd === 'status'
    ? { browser: null, pid: 123, ready: false }
    : { ok: true });
  return {
    run,
    // The real session captures the post-action snapshot inside the same
    // operation; a fake with no browser simply has no delta to report.
    runDetailed: vi.fn(async (command) => ({ value: await run(command) })),
    runBatch: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for MCP output');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const pkgVersion = (
  JSON.parse(readFileSync(resolvePath(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('protocol version negotiation', () => {
  // A server that echoes whatever it is asked for claims to speak revisions
  // nobody implemented, and a client is entitled to believe it.
  it.each([['2025-06-18'], ['2025-03-26'], ['2024-11-05']])(
    'answers %s with itself, because it is supported',
    (version) => {
      expect(negotiateProtocolVersion(version)).toBe(version);
    },
  );

  it.each([
    ['a future version', '2099-01-01'],
    ['a malformed value', 'banana'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { version: '2024-11-05' }],
  ])('falls back to a supported version for %s', (_label, requested) => {
    expect(negotiateProtocolVersion(requested)).toBe('2024-11-05');
  });
});

describe('MCP protocol units', () => {
  it('decodes and classifies requests separately from notifications', () => {
    const request = decodeJsonLine('{"jsonrpc":"2.0","id":7,"method":"ping"}');
    const notification = decodeJsonLine(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    );

    expect(classifyJsonRpcMessage(request)).toMatchObject({
      kind: 'request',
      message: { id: 7, method: 'ping' },
    });
    expect(classifyJsonRpcMessage(notification)).toMatchObject({
      kind: 'notification',
      message: { method: 'notifications/initialized' },
    });
  });

  it('serializes exactly one newline-delimited JSON-RPC frame', () => {
    expect(serializeJsonRpcResponse({
      jsonrpc: '2.0',
      id: 'abc',
      result: { pong: true },
    })).toBe('{"jsonrpc":"2.0","id":"abc","result":{"pong":true}}\n');
  });
});

describe('MCP wire characterization', () => {
  it('honours an explicit success-response cap at the server seam', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const captured = collectOutput(output);
    const runDetailed = vi.fn().mockResolvedValue({
      value: { text: 'x'.repeat(20_000) },
    });
    const session: AgentSessionRunner = {
      run: vi.fn(async (command) => (await runDetailed(command)).value),
      runDetailed,
      runBatch: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const running = runMcpServer({
      launch: {},
      input,
      output,
      snapshot: 'none',
      spillBytes: 100_000,
      maxResponseBytes: 1024,
      sessionFactory: () => session,
      signalSource: new EventEmitter(),
    });

    input.end(JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'browser_status', arguments: {} },
    }) + '\n');
    await running;

    const result = captured.lines()[0].result;
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(1024);
    expect(result?.structuredContent).toMatchObject({ truncated: true });
  });

  it('preserves initialize, list, call, notification, and error responses', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const captured = collectOutput(output);
    const signals = new EventEmitter();
    const session = fakeSession();
    const running = runMcpServer({
      launch: {},
      input,
      output,
      snapshot: 'none',
      sessionFactory: () => session,
      signalSource: signals,
    });

    input.write('{not json}\n');
    input.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2099-01-01' },
    }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    input.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'browser_status', arguments: {} },
    }) + '\n');
    input.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'missing_tool', arguments: {} },
    }) + '\n');
    input.end(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'missing/method' }) + '\n');

    await running;
    const messages = captured.lines();
    expect(messages).toHaveLength(6);
    expect(messages[0]).toMatchObject({ id: null, error: { code: -32700 } });
    // This previously asserted that the server echoed '2099-01-01' back and
    // reported version 0.1.0 — it was pinning two defects. A server must not
    // claim to speak a protocol revision nobody implemented, and the version
    // comes from the installed package rather than a constant that had drifted
    // three minors behind.
    expect(messages.find((message) => message.id === 1)?.result).toMatchObject({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'craftdriver', version: pkgVersion },
    });
    expect(messages.find((message) => message.id === 2)?.result?.tools).toHaveLength(TOOLS.length);
    expect(messages.find((message) => message.id === 3)?.result).toMatchObject({
      content: [{ type: 'text' }],
      structuredContent: { result: { browser: null, pid: 123, ready: false } },
    });
    // An unknown tool is a caller mistake about the protocol, so it is a
    // JSON-RPC -32602 rather than a successful result carrying isError.
    // Normal action failures — a missing element, a timeout — stay successful
    // results, which is what keeps the two distinguishable.
    expect(messages.find((message) => message.id === 4)?.error).toMatchObject({
      code: -32602,
    });
    expect(messages.find((message) => message.id === 5)).toMatchObject({
      error: { code: -32601, message: 'method not found: missing/method' },
    });
    expect(captured.text().split('\n').filter(Boolean).every((line) => {
      expect(() => JSON.parse(line)).not.toThrow();
      return true;
    })).toBe(true);
    expect(session.run).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('answers stateless requests while a browser tool call is in flight', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const captured = collectOutput(output);
    const toolStarted = deferred();
    const finishTool = deferred<unknown>();
    const runDetailed = vi.fn(async () => {
      toolStarted.resolve();
      return { value: await finishTool.promise };
    });
    const session: AgentSessionRunner = {
      run: vi.fn(async (command) => (await runDetailed(command)).value),
      runDetailed,
      runBatch: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const running = runMcpServer({
      launch: {},
      input,
      output,
      snapshot: 'none',
      sessionFactory: () => session,
      signalSource: new EventEmitter(),
    });

    input.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'browser_status', arguments: {} },
    }) + '\n');
    await toolStarted.promise;
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'ping' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/list' }) + '\n');

    let repliedBeforeTool = true;
    try {
      await waitFor(() => {
        const ids = captured.lines().map((message) => message.id);
        return ids.includes(21) && ids.includes(22);
      });
    } catch {
      repliedBeforeTool = false;
    }

    finishTool.resolve({ ready: false });
    input.end();
    await running;

    expect(repliedBeforeTool).toBe(true);
    expect(captured.lines().find((message) => message.id === 21)).toEqual({
      jsonrpc: '2.0',
      id: 21,
      result: {},
    });
    expect(captured.lines().find((message) => message.id === 22)?.result?.tools).toHaveLength(TOOLS.length);
  });

  it('writes only newline-delimited JSON-RPC frames to stdout in MCP mode', async () => {
    const input = new PassThrough();
    const signals = new EventEmitter();
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    });

    try {
      const running = runMcpServer({
        launch: {},
        input,
        snapshot: 'none',
        sessionFactory: fakeSession,
        signalSource: signals,
      });
      input.write('{not json}\n');
      input.end(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }) + '\n');
      await running;
    } finally {
      write.mockRestore();
    }

    const lines = stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
      { jsonrpc: '2.0', id: 8, result: {} },
    ]);
  });

  it('rejects a complete oversized frame and resumes at the next line', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const captured = collectOutput(output);
    const session = fakeSession();
    const running = runMcpServer({
      launch: {},
      input,
      output,
      snapshot: 'none',
      sessionFactory: () => session,
      signalSource: new EventEmitter(),
    });

    input.end(
      'x'.repeat(MCP_MAX_FRAME_BYTES + 1) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n',
    );
    await running;

    expect(captured.lines()).toEqual([
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `input frame exceeds ${MCP_MAX_FRAME_BYTES}-byte limit`,
        },
      },
      { jsonrpc: '2.0', id: 9, result: {} },
    ]);
  });

  it('rejects an unterminated oversized frame before EOF without retaining it', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const captured = collectOutput(output);
    const running = runMcpServer({
      launch: {},
      input,
      output,
      snapshot: 'none',
      sessionFactory: fakeSession,
      signalSource: new EventEmitter(),
    });

    input.write('x'.repeat(MCP_MAX_FRAME_BYTES + 1));
    await waitFor(() => captured.lines().length === 1);
    expect(captured.lines()[0]).toMatchObject({
      id: null,
      error: {
        code: -32700,
        message: `input frame exceeds ${MCP_MAX_FRAME_BYTES}-byte limit`,
      },
    });

    input.end('\n' + JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }) + '\n');
    await running;
    expect(captured.lines().at(-1)).toEqual({ jsonrpc: '2.0', id: 10, result: {} });
  });
});

describe('browser_batch on the wire', () => {
  function batchSession(outcome: unknown) {
    const runBatch = vi.fn().mockResolvedValue(outcome);
    return {
      session: {
        run: vi.fn(),
        runDetailed: vi.fn(),
        runBatch,
        close: vi.fn().mockResolvedValue(undefined),
      } as AgentSessionRunner,
      runBatch,
    };
  }

  async function call(session: AgentSessionRunner, args: unknown) {
    const input = new PassThrough();
    const output = new PassThrough();
    const captured = collectOutput(output);
    const running = runMcpServer({
      launch: {},
      input,
      output,
      snapshot: 'none',
      sessionFactory: () => session,
      signalSource: new EventEmitter(),
    });
    input.end(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'browser_batch', arguments: args },
    }) + '\n');
    await running;
    return captured.lines()[0];
  }

  it('compiles steps through the tools they name and runs them in one batch', async () => {
    const outcome = {
      ok: true,
      ran: 2,
      skipped: 0,
      steps: [
        { index: 0, cmd: 'go', ok: true, durationMs: 49 },
        { index: 1, cmd: 'fill', ok: true, durationMs: 80 },
      ],
      delta: '+ e12: textbox "Nickname" value="alice"',
    };
    const { session, runBatch } = batchSession(outcome);

    const message = await call(session, {
      steps: [
        { tool: 'browser_navigate', arguments: { url: 'https://example.com' } },
        { tool: 'browser_fill', arguments: { selector: 'ref=e4', value: 'alice' } },
      ],
      observe: 'delta',
    });

    // One call, not two: this is the round trip the tool exists to collapse.
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(runBatch.mock.calls[0][0]).toMatchObject({
      observe: 'delta',
      steps: [
        { cmd: 'go', args: { url: 'https://example.com' } },
        { cmd: 'fill', args: { selector: 'ref=e4', value: 'alice' } },
      ],
    });
    expect(message.result?.structuredContent).toMatchObject({ result: outcome });
    expect(message.result?.content?.[0]?.text).toContain('1 ✓ go  49ms');
    expect(message.result?.isError).toBeUndefined();
  });

  it('marks a batch with a failed step as an error, keeping the steps that ran', async () => {
    const outcome = {
      ok: false,
      ran: 1,
      skipped: 1,
      failedStep: 0,
      steps: [
        { index: 0, cmd: 'click', ok: false, durationMs: 4980, error: { code: 'TIMEOUT', message: 'nope' } },
      ],
    };
    const { session } = batchSession(outcome);

    const message = await call(session, {
      steps: [{ tool: 'browser_click', arguments: { selector: '#pay' } }],
    });

    expect(message.result?.isError).toBe(true);
    expect(message.result?.structuredContent).toMatchObject({ result: { failedStep: 0 } });
  });

  it.each([
    ['an unknown tool', { steps: [{ tool: 'browser_teleport', arguments: {} }] }, /unknown tool/],
    [
      'arguments the named tool refuses',
      { steps: [{ tool: 'browser_fill', arguments: { selector: '#a' } }] },
      /missing required argument "value"/,
    ],
    [
      'a batch inside a batch',
      { steps: [{ tool: 'browser_batch', arguments: { steps: [] } }] },
      /cannot be used as a batch step/,
    ],
    ['an empty batch', { steps: [] }, /no steps to run/],
  ])('refuses %s before touching the session', async (_label, args, expected) => {
    const { session, runBatch } = batchSession({});

    const message = await call(session, args);

    expect(runBatch).not.toHaveBeenCalled();
    expect(message.error?.code).toBe(-32602);
    expect(message.error?.message).toMatch(expected);
  });
});
