/**
 * Batch semantics, with fakes.
 *
 * The point of a batch is collapsing round trips *without* collapsing the
 * evidence, and every property that keeps that true is pinned here: one queue
 * slot, stop at the first failure, per-step results, one observation, and no
 * retry. `agent-batch.test.ts` runs the same contract against a real browser;
 * these are the fast checks that localise a break.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Browser } from '../../src/lib/browser.js';
import { CraftdriverError, ErrorCode } from '../../src/lib/errors.js';
import { AgentSession, type AgentDispatcher } from '../../src/cli/agentSession.js';
import {
  boundBatchSteps,
  batchRejection,
  renderBatchOutcome,
  validateBatchSteps,
  MAX_BATCH_RESULT_BYTES,
  MAX_BATCH_STEPS,
} from '../../src/cli/batch.js';
import { compileScript } from '../../src/cli/script.js';
import { renderObservedResult } from '../../src/cli/daemon.js';

const PAGE = {
  url: 'https://x.test/',
  title: 'x',
  documentId: 'd1',
  revision: 1,
  documentChange: 'same' as const,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * A browser that answers nothing.
 *
 * Enough for the observation *gating*: `peekDialog` swallows the failure and
 * `takeSnapshot` returns null, so an attempted observation is visible as the
 * "unavailable" note and countable through `getDialogMessage`.
 */
function fakeBrowser() {
  const getDialogMessage = vi.fn(async () => {
    throw new Error('no such alert');
  });
  return {
    getDialogMessage,
    browser: {
      getDialogMessage,
      quit: vi.fn().mockResolvedValue(undefined),
      setViewportSize: vi.fn().mockResolvedValue(undefined),
    } as unknown as Browser,
  };
}

interface SessionOptions {
  dispatcher?: AgentDispatcher;
  browser?: Browser;
}

function sessionWith({ dispatcher, browser }: SessionOptions = {}) {
  return new AgentSession({
    launchOptions: {},
    launch: async () => browser ?? fakeBrowser().browser,
    autoSnapshot: false,
    // Every real command reaches the browser through the handle, and that is
    // what makes one available to observe afterwards. A dispatcher that
    // skipped it would make the observation tests pass for the wrong reason.
    dispatcher:
      dispatcher ??
      (async (ctx, cmd, args) => {
        await ctx.handle.get();
        return { cmd, selector: args?.selector ?? null };
      }),
  });
}

describe('runBatch executes the steps', () => {
  it('reports every step with its own ok and duration', async () => {
    const session = sessionWith();

    const outcome = await session.runBatch({
      steps: [
        { cmd: 'go', args: { url: 'about:blank' } },
        { cmd: 'check', args: { selector: '#news' } },
      ],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ran).toBe(2);
    expect(outcome.skipped).toBe(0);
    expect(outcome.steps.map((step) => [step.index, step.cmd, step.ok])).toEqual([
      [0, 'go', true],
      [1, 'check', true],
    ]);
    for (const step of outcome.steps) {
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
      expect(step.result).toBeDefined();
    }
    await session.close();
  });

  it('stops at the first failure and says how many were skipped', async () => {
    const seen: string[] = [];
    const dispatcher: AgentDispatcher = vi.fn(async (_ctx, cmd) => {
      seen.push(cmd);
      if (cmd === 'fill') {
        throw new CraftdriverError(ErrorCode.TIMEOUT, 'Wait timed out after 4980ms');
      }
      return { cmd };
    });
    const session = sessionWith({ dispatcher });

    const outcome = await session.runBatch({
      steps: [
        { cmd: 'go', args: {} },
        { cmd: 'fill', args: { selector: '#nonexistent' } },
        { cmd: 'click', args: { selector: '#submit' } },
        { cmd: 'text', args: { selector: '#result' } },
      ],
    });

    // The defect this exists to prevent: `text #result` running anyway and
    // answering "Missing credentials" for a form that was never filled.
    expect(seen).toEqual(['go', 'fill']);
    expect(outcome.ok).toBe(false);
    expect(outcome.failedStep).toBe(1);
    expect(outcome.ran).toBe(2);
    expect(outcome.skipped).toBe(2);
    expect(outcome.steps[1].error?.code).toBe(ErrorCode.TIMEOUT);
    await session.close();
  });

  it('runs every step under continueOnError, still marking the batch failed', async () => {
    const dispatcher: AgentDispatcher = vi.fn(async (_ctx, cmd) => {
      if (cmd === 'fill') throw new CraftdriverError(ErrorCode.NO_MATCH, 'no element');
      return { cmd };
    });
    const session = sessionWith({ dispatcher });

    const outcome = await session.runBatch({
      continueOnError: true,
      steps: [
        { cmd: 'fill', args: {} },
        { cmd: 'exists', args: {} },
        { cmd: 'text', args: {} },
      ],
    });

    expect(outcome.ran).toBe(3);
    expect(outcome.skipped).toBe(0);
    expect(outcome.ok).toBe(false);
    // The *first* failure, so a sweep with several does not rename its cause.
    expect(outcome.failedStep).toBe(0);
    await session.close();
  });

  it('never retries or re-dispatches a failed step', async () => {
    const dispatcher: AgentDispatcher = vi.fn(async () => {
      throw new CraftdriverError(ErrorCode.STALE_REF, 'ref e4 is stale');
    });
    const session = sessionWith({ dispatcher });

    await session.runBatch({ steps: [{ cmd: 'click', args: { selector: 'ref=e4' } }] });

    expect(dispatcher).toHaveBeenCalledTimes(1);
    await session.close();
  });
});

describe('a batch is one queue slot', () => {
  it('lets nothing interleave between its steps', async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];
    const dispatcher: AgentDispatcher = vi.fn(async (_ctx, cmd) => {
      order.push(cmd);
      if (cmd === 'first') {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { cmd };
    });
    const session = sessionWith({ dispatcher });

    const batch = session.runBatch({
      steps: [
        { cmd: 'first', args: {} },
        { cmd: 'second', args: {} },
      ],
    });
    await firstStarted.promise;
    // Submitted while the batch is mid-flight, and therefore queued behind
    // all of it — this is the property that keeps the page an agent reasoned
    // about the page its next step acts on.
    const interloper = session.run({ cmd: 'interloper', args: {} });
    await Promise.resolve();
    releaseFirst.resolve();

    await batch;
    await interloper;
    expect(order).toEqual(['first', 'second', 'interloper']);
    await session.close();
  });

  it('refuses to start once the session is closing', async () => {
    const session = sessionWith();
    await session.close();
    await expect(session.runBatch({ steps: [{ cmd: 'status', args: {} }] })).rejects.toMatchObject({
      code: ErrorCode.STATE_INVALID,
    });
  });
});

describe('a batch returns one observation, not one per step', () => {
  it('observes once after several mutating steps', async () => {
    const { browser, getDialogMessage } = fakeBrowser();
    const session = sessionWith({ browser });

    const outcome = await session.runBatch({
      observe: 'delta',
      steps: [
        { cmd: 'fill', args: { selector: '#a' } },
        { cmd: 'fill', args: { selector: '#b' } },
        { cmd: 'click', args: { selector: '#save' } },
      ],
    });

    expect(getDialogMessage).toHaveBeenCalledTimes(1);
    expect(outcome.delta).toBe('post-action snapshot unavailable');
    await session.close();
  });

  it('observes nothing when no step could have changed the page', async () => {
    const { browser, getDialogMessage } = fakeBrowser();
    const session = sessionWith({ browser });

    const outcome = await session.runBatch({
      observe: 'delta',
      steps: [
        { cmd: 'text', args: {} },
        { cmd: 'exists', args: {} },
      ],
    });

    expect(getDialogMessage).not.toHaveBeenCalled();
    expect(outcome.delta).toBeUndefined();
    await session.close();
  });

  it('observes nothing when none was asked for', async () => {
    const { browser, getDialogMessage } = fakeBrowser();
    const session = sessionWith({ browser });

    await session.runBatch({ steps: [{ cmd: 'click', args: {} }] });

    expect(getDialogMessage).not.toHaveBeenCalled();
    await session.close();
  });

  it('does not snapshot again when a failure already attached a recovery snapshot', async () => {
    const { browser, getDialogMessage } = fakeBrowser();
    const dispatcher: AgentDispatcher = vi.fn(async (ctx, cmd) => {
      await ctx.handle.get();
      if (cmd === 'click') {
        throw new CraftdriverError(ErrorCode.NO_MATCH, 'gone', {
          recoverySnapshot: 'e1: button "Save"',
        });
      }
      return { cmd };
    });
    const session = sessionWith({ browser, dispatcher });

    const outcome = await session.runBatch({
      observe: 'delta',
      steps: [
        { cmd: 'fill', args: {} },
        { cmd: 'click', args: { selector: 'ref=e4' } },
      ],
    });

    expect(outcome.steps[1].error?.recoverySnapshot).toBe('e1: button "Save"');
    expect(getDialogMessage).not.toHaveBeenCalled();
    expect(outcome.delta).toBeUndefined();
    await session.close();
  });
});

describe('compiling a script into a batch', () => {
  const compile = (source: string) => compileScript(source, { mode: 'batch' });

  it('parses the same command syntax the CLI takes', () => {
    const { steps, errors } = compile(
      ["# a comment", '', "fill '#nickname' mitko", 'check #newsletter', "text '#log'"].join('\n')
    );

    expect(errors).toEqual([]);
    expect(steps.map((step) => step.cmd)).toEqual(['fill', 'check', 'text']);
    expect(steps[0].args).toMatchObject({ selector: '#nickname', value: 'mitko' });
  });

  it('reports every syntax problem, not just the first', () => {
    const { steps, errors } = compile(['click #pay --forse', 'nonsense #x'].join('\n'));

    expect(steps).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('unknown flag "--forse"');
    expect(errors[1]).toContain('unknown command "nonsense"');
  });

  it('refuses flags that choose the browser or the session', () => {
    const { errors } = compile('click #pay --session other');
    expect(errors[0]).toContain('--session cannot be set inside a batch script');
    expect(errors[0]).toContain('craftdriver run');
  });

  it('refuses a command that is not about the page', () => {
    for (const line of ['quit', 'daemon stop', 'session close', 'run']) {
      const { errors } = compile(line);
      expect(errors[0]).toContain('cannot run inside a batch');
    }
  });

  it('allows --observe on the last step only', () => {
    expect(compile(['fill #a x', 'click #save --observe=delta'].join('\n')).errors).toEqual([]);

    const { errors } = compile(['fill #a x --observe=delta', 'click #save'].join('\n'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('--observe is only valid on the last step');
  });

  it('leaves per-line observation alone in an ephemeral script', () => {
    const { errors } = compileScript(['fill #a x --observe=delta', 'click #save'].join('\n'), {
      mode: 'ephemeral',
    });
    expect(errors).toEqual([]);
  });
});

describe('an untrusted step list', () => {
  it('rejects the shapes a socket peer could send', () => {
    expect(() => validateBatchSteps('go')).toThrow(/must be an array/);
    expect(() => validateBatchSteps([])).toThrow(/no steps/);
    expect(() => validateBatchSteps([{ args: {} }])).toThrow(/missing "cmd"/);
    expect(() => validateBatchSteps([{ cmd: 'go', args: 'url' }])).toThrow(/"args" must be/);
    expect(() =>
      validateBatchSteps(Array.from({ length: MAX_BATCH_STEPS + 1 }, () => ({ cmd: 'status' })))
    ).toThrow(/too many steps/);
  });

  it('applies the same command policy the CLI compiler does', () => {
    expect(() => validateBatchSteps([{ cmd: 'quit' }])).toThrow(/cannot run inside a batch/);
    expect(batchRejection('click')).toBeNull();
    expect(batchRejection('session:close')).toMatch(/daemon/);
  });
});

describe('bounding a batch result', () => {
  it('keeps ok and duration for a step whose result is dropped', () => {
    const big = 'x'.repeat(MAX_BATCH_RESULT_BYTES);
    const bounded = boundBatchSteps([
      { index: 0, cmd: 'eval', ok: true, durationMs: 3, result: big },
      { index: 1, cmd: 'eval', ok: true, durationMs: 4, result: big },
      { index: 2, cmd: 'click', ok: true, durationMs: 5, result: { ok: true } },
    ]);

    expect(bounded[0].truncated).toBe(true);
    expect(bounded[2].ok).toBe(true);
    expect(bounded[2].durationMs).toBe(5);
    const serialized = Buffer.byteLength(JSON.stringify(bounded), 'utf8');
    expect(serialized).toBeLessThan(MAX_BATCH_RESULT_BYTES * 2);
  });

  it('leaves a small result untouched', () => {
    const steps = [{ index: 0, cmd: 'text', ok: true, durationMs: 1, result: 'saved' }];
    expect(boundBatchSteps(steps)).toEqual(steps);
  });
});

describe('rendering a batch for a human', () => {
  it('shows each step, the stop, and the observation', () => {
    const text = renderBatchOutcome({
      ok: false,
      ran: 2,
      skipped: 1,
      failedStep: 1,
      delta: '+ e22: text "saved"',
      steps: [
        { index: 0, cmd: 'go', ok: true, durationMs: 49, result: { url: 'about:blank' } },
        {
          index: 1,
          cmd: 'fill',
          ok: false,
          durationMs: 4980,
          error: { code: ErrorCode.TIMEOUT, message: 'element exists but is not displayed' },
        },
      ],
    });

    expect(text).toContain('1 ✓ go  49ms');
    expect(text).toContain('2 ✗ fill  4980ms');
    expect(text).toContain('element exists but is not displayed');
    expect(text).toContain('stopped at step 2 of 2; 1 later step not run');
    expect(text).toContain('+ e22: text "saved"');
  });
});


describe('the error tripwire on an observation', () => {
  it('is absent, not zero, when the session cannot capture logs', async () => {
    // A Classic session has no journal events at all. Reporting `errors: 0`
    // there would be an all-clear nobody checked.
    const { browser } = fakeBrowser();
    const session = sessionWith({ browser });

    const outcome = await session.runBatch({
      observe: 'delta',
      steps: [{ cmd: 'click', args: {} }],
    });

    expect(outcome.logs).toBeUndefined();
    await session.close();
  });
});

describe('rendering an observation for a transport', () => {
  it('adds the tripwire to both observation kinds, flat', () => {
    const detailed = {
      value: { ok: true },
      delta: '+ e1: text "saved"',
      logs: { errors: 1, logCursor: 8 },
    };

    expect(renderObservedResult(detailed, 'delta')).toEqual({
      ok: true,
      delta: '+ e1: text "saved"',
      errors: 1,
      logCursor: 8,
    });
    expect(renderObservedResult({ ...detailed, page: PAGE }, 'page')).toMatchObject({
      errors: 1,
      logCursor: 8,
    });
  });

  it('reports an evicted window so the count is not read as exact', () => {
    const rendered = renderObservedResult(
      { value: {}, logs: { errors: 0, logCursor: 3, logsDropped: 40 } },
      'delta',
    ) as Record<string, unknown>;

    expect(rendered.logsDropped).toBe(40);
  });

  it('leaves an unobserved result alone', () => {
    expect(renderObservedResult({ value: { ok: true }, logs: { errors: 9, logCursor: 1 } }, undefined))
      .toEqual({ ok: true });
  });
});
