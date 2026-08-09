import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRunner } from '../../src/cli/agentSession.js';
import { runMcpServer } from '../../src/cli/mcp/server.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('MCP server lifecycle', () => {
  it('waits for a tool accepted before EOF and then closes its session once', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const signals = new EventEmitter();
    const toolStarted = deferred();
    const finishTool = deferred<{ ready: boolean }>();
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
      signalSource: signals,
    });

    input.end(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'browser_status', arguments: {} },
    }) + '\n');
    await toolStarted.promise;
    await Promise.resolve();
    expect(session.close).not.toHaveBeenCalled();

    finishTool.resolve({ ready: false });
    await running;
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`closes its session on ${signal} and removes lifecycle hooks`, async () => {
      const input = new PassThrough();
      const signals = new EventEmitter();
      const session: AgentSessionRunner = {
        run: vi.fn(),
        runDetailed: vi.fn(),
        runBatch: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const running = runMcpServer({
        launch: {},
        input,
        output: new PassThrough(),
        snapshot: 'none',
        sessionFactory: () => session,
        signalSource: signals,
      });

      expect(signals.listenerCount('SIGINT')).toBe(1);
      expect(signals.listenerCount('SIGTERM')).toBe(1);
      signals.emit(signal);
      await running;

      expect(session.close).toHaveBeenCalledTimes(1);
      expect(signals.listenerCount('SIGINT')).toBe(0);
      expect(signals.listenerCount('SIGTERM')).toBe(0);
      expect(input.listenerCount('end')).toBe(0);
      expect(input.listenerCount('close')).toBe(0);
    });
  }
});
