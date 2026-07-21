import { describe, expect, it, vi } from 'vitest';
import type { Browser } from '../../src/lib/browser.js';
import { CraftdriverError, ErrorCode } from '../../src/lib/errors.js';
import {
  AgentSession,
  type AgentDispatcher,
} from '../../src/cli/agentSession.js';
import type { BrowserHandle } from '../../src/cli/dispatcher.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeBrowser() {
  return {
    browser: { quit: vi.fn().mockResolvedValue(undefined) } as unknown as Browser,
  };
}

describe('AgentSession', () => {
  it('runs commands FIFO when an earlier command is still pending', async () => {
    const slow = deferred();
    const slowStarted = deferred();
    const started: string[] = [];
    const { browser } = fakeBrowser();
    const dispatcher: AgentDispatcher = vi.fn(async (_ctx, cmd) => {
      started.push(cmd);
      if (cmd === 'slow') {
        slowStarted.resolve();
        await slow.promise;
      }
      return { cmd };
    });
    const session = new AgentSession({
      launchOptions: {},
      launch: async () => browser,
      dispatcher,
    });

    const first = session.run({ cmd: 'slow', args: {} });
    const second = session.run({ cmd: 'fast', args: {} });
    await slowStarted.promise;
    await Promise.resolve();

    expect(started).toEqual(['slow']);
    slow.resolve();
    await expect(first).resolves.toEqual({ cmd: 'slow' });
    await expect(second).resolves.toEqual({ cmd: 'fast' });
    expect(started).toEqual(['slow', 'fast']);
    await session.close();
  });

  it('continues the queue after a rejected command', async () => {
    const firstStarted = deferred();
    const rejectFirst = deferred();
    const started: string[] = [];
    const { browser } = fakeBrowser();
    const dispatcher: AgentDispatcher = vi.fn(async (_ctx, cmd) => {
      started.push(cmd);
      if (cmd === 'reject') {
        firstStarted.resolve();
        await rejectFirst.promise;
        throw new Error('expected failure');
      }
      return { cmd };
    });
    const session = new AgentSession({
      launchOptions: {},
      launch: async () => browser,
      dispatcher,
    });

    const first = session.run({ cmd: 'reject' });
    const second = session.run({ cmd: 'recover' });
    await firstStarted.promise;
    expect(started).toEqual(['reject']);

    rejectFirst.resolve();
    await expect(first).rejects.toThrow('expected failure');
    await expect(second).resolves.toEqual({ cmd: 'recover' });
    expect(started).toEqual(['reject', 'recover']);
    await session.close();
  });

  it('launches the browser lazily and only once for queued concurrent calls', async () => {
    const { browser } = fakeBrowser();
    const launch = vi.fn(async () => browser);
    const dispatcher: AgentDispatcher = async (ctx, cmd) => {
      await ctx.handle.get();
      return cmd;
    };
    const session = new AgentSession({ launchOptions: {}, launch, dispatcher });

    expect(launch).not.toHaveBeenCalled();
    await expect(Promise.all([
      session.run({ cmd: 'first' }),
      session.run({ cmd: 'second' }),
    ])).resolves.toEqual(['first', 'second']);
    expect(launch).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it('close waits for accepted work, closes once, and rejects new work', async () => {
    const work = deferred();
    const workStarted = deferred();
    const { browser } = fakeBrowser();
    const dispatcher: AgentDispatcher = vi.fn(async (ctx) => {
      await ctx.handle.get();
      workStarted.resolve();
      await work.promise;
      return { done: true };
    });
    const session = new AgentSession({
      launchOptions: {},
      launch: async () => browser,
      dispatcher,
    });

    const accepted = session.run({ cmd: 'slow' });
    await workStarted.promise;
    const closing = session.close();
    const closingAgain = session.close();

    expect(browser.quit).not.toHaveBeenCalled();
    await expect(session.run({ cmd: 'late' })).rejects.toMatchObject({
      code: ErrorCode.STATE_INVALID,
    });
    work.resolve();
    await expect(accepted).resolves.toEqual({ done: true });
    await expect(Promise.all([closing, closingAgain])).resolves.toEqual([undefined, undefined]);
    expect(browser.quit).toHaveBeenCalledTimes(1);
  });

  it('close before launch and repeated close do not launch a browser', async () => {
    const { browser } = fakeBrowser();
    const launch = vi.fn(async () => browser);
    const session = new AgentSession({ launchOptions: {}, launch });

    await session.close();
    await session.close();

    expect(launch).not.toHaveBeenCalled();
    expect(browser.quit).not.toHaveBeenCalled();
  });

  it('keeps close idempotent when browser cleanup throws synchronously', async () => {
    const browser = {
      quit: vi.fn(() => {
        throw new Error('cleanup failed');
      }),
    } as unknown as Browser;
    const session = new AgentSession({
      launchOptions: {},
      launch: async () => browser,
      dispatcher: async (ctx) => {
        await ctx.handle.get();
        return { ready: true };
      },
    });
    await session.run({ cmd: 'launch' });

    await expect(session.close()).resolves.toBeUndefined();
    await expect(session.close()).resolves.toBeUndefined();
    expect(browser.quit).toHaveBeenCalledTimes(1);
  });

  it('does not latch a rejected close and retries cleanup on the next close', async () => {
    const close = vi
      .fn<BrowserHandle['close']>()
      .mockRejectedValueOnce(new Error('temporary cleanup failure'))
      .mockResolvedValueOnce(undefined);
    const handle: BrowserHandle = {
      get: vi.fn(),
      peek: vi.fn(() => null),
      close,
    };
    const session = new AgentSession({ launchOptions: {}, handle });

    await expect(session.close()).rejects.toThrow('temporary cleanup failure');
    await expect(session.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    await expect(session.run({ cmd: 'late' })).rejects.toMatchObject({
      code: ErrorCode.STATE_INVALID,
    });
  });

  it('uses the structured invalid-state convention after closing', async () => {
    const session = new AgentSession({
      launchOptions: {},
      launch: vi.fn(),
    });
    await session.close();

    const error = await session.run({ cmd: 'status' }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CraftdriverError);
    expect(error).toMatchObject({
      code: ErrorCode.STATE_INVALID,
      message: expect.stringContaining('closed'),
    });
  });
});
