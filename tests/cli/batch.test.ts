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
  MAX_BATCH_FRAME_BYTES,
  MAX_BATCH_RESULT_BYTES,
  MAX_BATCH_STEPS,
} from '../../src/cli/batch.js';
import { compileScript, tokenize } from '../../src/cli/script.js';
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

  it('carries the tripwire, and its qualifiers, out of the session', async () => {
    // The batch is the surface where an agent is least likely to look at the
    // logs directly, so the qualifiers on the count are load-bearing here: an
    // upper bound and an unconfirmed zero have to survive the whole way out.
    let emit: ((message: Record<string, unknown>) => void) | undefined;
    const browser = {
      getDialogMessage: vi.fn(async () => {
        throw new Error('no such alert');
      }),
      quit: vi.fn().mockResolvedValue(undefined),
      setViewportSize: vi.fn().mockResolvedValue(undefined),
      get logs() {
        return {
          onLog(handler: (message: Record<string, unknown>) => void) {
            emit = handler;
            return () => {};
          },
        };
      },
      get network() {
        return { on: () => () => {} };
      },
      activePage: async () => ({ url: async () => 'https://x.test/' }),
    } as unknown as Browser;
    const session = sessionWith({ browser });

    // A read-only batch, so the observation is skipped and the tripwire comes
    // from the fallback path — the one that used to answer without a barrier.
    await session.run({ cmd: 'text', args: {} });
    for (let i = 0; i < 1001; i++) {
      emit?.({ type: 'javascript', level: 'error', text: `e${i}`, timestamp: new Date() });
    }

    const outcome = await session.runBatch({
      observe: 'delta',
      steps: [{ cmd: 'text', args: {} }],
    });

    expect(outcome.logs).toMatchObject({ logsDropped: 501, logsDroppedExact: false });
    expect(outcome.logs?.errors).toBe(500);
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

  it('still observes when steps ran after the recovered failure', async () => {
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

    // The recovery snapshot was taken before the `fill` that follows it, so it
    // cannot describe what that fill changed. Suppressing the observation here
    // used to lose the only account of the rest of the batch.
    const outcome = await session.runBatch({
      observe: 'delta',
      continueOnError: true,
      steps: [
        { cmd: 'click', args: { selector: 'ref=e4' } },
        { cmd: 'fill', args: { selector: '#nickname' } },
      ],
    });

    expect(outcome.steps[0].error?.recoverySnapshot).toBe('e1: button "Save"');
    expect(getDialogMessage).toHaveBeenCalledTimes(1);
    expect(outcome.delta).toBe('post-action snapshot unavailable');
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

  it('keeps a quoted empty argument', () => {
    // How a field is emptied. Dropping the `''` turned a correct line into a
    // usage error about a missing value.
    expect(tokenize("fill '#search' ''")).toEqual(['fill', '#search', '']);
    const { steps, errors } = compile("fill '#search' ''");
    expect(errors).toEqual([]);
    expect(steps[0].args).toMatchObject({ selector: '#search', value: '' });
  });

  it('refuses a line whose quote is never closed', () => {
    // It used to tokenise as `click #save` and run, so the day a selector
    // really did start with a quote the script did something else instead.
    expect(() => tokenize("click '#save")).toThrow(/unterminated single quote/);
    const { steps, errors } = compile(["click '#save", 'text #log'].join('\n'));
    expect(steps.map((step) => step.cmd)).toEqual(['text']);
    expect(errors[0]).toContain('unterminated single quote');
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

  it('trims the errors too, so a sweep of failures cannot outgrow the frame', () => {
    // What `--continue-on-error` over a page that navigated can really produce:
    // every step fails on a stale ref, and every failure carries a recovery
    // snapshot. Unbounded, this is the case that overruns the daemon's frame
    // limit and discards the batch after all the browser work is done.
    const bounded = boundBatchSteps(
      Array.from({ length: MAX_BATCH_STEPS }, (_, index) => ({
        index,
        cmd: 'click',
        ok: false,
        durationMs: 5,
        error: {
          code: ErrorCode.NO_MATCH,
          message: `no element matched ref=e${index}`,
          hint: 'h'.repeat(2_000),
          detail: { snapshot: 'd'.repeat(4_000) },
          recoverySnapshot: 's'.repeat(12 * 1024),
        },
      }))
    );

    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
      MAX_BATCH_FRAME_BYTES
    );
    // The first failure — the one an agent acts on — keeps everything.
    expect(bounded[0].error?.recoverySnapshot).toHaveLength(12 * 1024);
    expect(bounded[0].truncated).toBeUndefined();
    // The rest keep the part that cannot be reconstructed from the page.
    for (const step of bounded.slice(1)) {
      expect(step.error?.code).toBe(ErrorCode.NO_MATCH);
      expect(step.error?.message).toContain('no element matched');
    }
    expect(bounded.at(-1)?.truncated).toBe(true);
    expect(bounded.at(-1)?.error?.recoverySnapshot).toBeUndefined();
  });

  it('holds the ceiling against content that costs more once serialized', () => {
    // The bound is on the frame, and the frame is JSON: a quote costs two
    // bytes there, a control character six. Bounding raw text instead let 25
    // maximum-sized errors serialize to ~60 KB against a "ceiling" of 48 KB.
    for (const filler of ['"', '\u0001', '😀', 'a']) {
      const bounded = boundBatchSteps(
        Array.from({ length: MAX_BATCH_STEPS }, (_, index) => ({
          index,
          cmd: filler.repeat(32),
          ok: false,
          durationMs: 5,
          result: filler.repeat(40 * 1024),
          error: {
            code: ErrorCode.DRIVER_ERROR,
            message: filler.repeat(16 * 1024),
            hint: filler.repeat(4 * 1024),
            detail: { d: filler.repeat(8 * 1024) },
            recoverySnapshot: filler.repeat(12 * 1024),
          },
        }))
      );

      expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(
        MAX_BATCH_FRAME_BYTES
      );
      // Whatever else went, every step still says what failed.
      for (const step of bounded) expect(step.error?.code).toBe(ErrorCode.DRIVER_ERROR);
    }
  });
});

describe('a step that succeeded and answered no', () => {
  const dispatcher: AgentDispatcher = vi.fn(async (_ctx, cmd) => {
    if (cmd === 'exists') return { exists: false, count: 0 };
    if (cmd === 'a11y') {
      return { checked: true, passed: false, minImpact: 'serious', counts: { violations: 3 } };
    }
    return { cmd };
  });

  it('is a failed step when the caller asked for verdicts, and stops the rest', async () => {
    const session = sessionWith({ dispatcher });

    const outcome = await session.runBatch({
      stopOnVerdict: true,
      steps: [
        { cmd: 'go', args: {} },
        { cmd: 'exists', args: { selector: '#gone' } },
        { cmd: 'click', args: { selector: '#save' } },
      ],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failedStep).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect(outcome.steps[1].error?.code).toBe(ErrorCode.NO_MATCH);
    // The answer is still there: a verdict does not replace the result.
    expect(outcome.steps[1].result).toMatchObject({ exists: false });
    await session.close();
  });

  it('names a failed a11y --check as the assertion it opted into', async () => {
    const session = sessionWith({ dispatcher });

    const outcome = await session.runBatch({
      stopOnVerdict: true,
      steps: [{ cmd: 'a11y', args: { check: true } }],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.steps[0].error?.code).toBe(ErrorCode.EXPECT_MISMATCH);
    expect(outcome.steps[0].error?.message).toContain('3 serious+ violations');
    await session.close();
  });

  it('is an ordinary answer for a caller that did not ask', async () => {
    // MCP: `browser_read` is documented to answer rather than fail, and
    // `browser_expect` is the tool that returns a verdict.
    const session = sessionWith({ dispatcher });

    const outcome = await session.runBatch({
      steps: [
        { cmd: 'exists', args: { selector: '#gone' } },
        { cmd: 'click', args: { selector: '#save' } },
      ],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ran).toBe(2);
    await session.close();
  });

  it('runs the rest under continueOnError, still failing the batch', async () => {
    const session = sessionWith({ dispatcher });

    const outcome = await session.runBatch({
      stopOnVerdict: true,
      continueOnError: true,
      steps: [
        { cmd: 'exists', args: { selector: '#gone' } },
        { cmd: 'click', args: { selector: '#save' } },
      ],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ran).toBe(2);
    expect(outcome.skipped).toBe(0);
    await session.close();
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
    expect(text).toContain('stopped at step 2 of 3; 1 later step not run');
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
    // Exact by default: the qualifier is absent rather than true, so its
    // presence always means the same thing.
    expect(rendered.logsDroppedExact).toBeUndefined();
  });

  it('carries both qualifiers of the count, not just the count', () => {
    // A number that reaches an agent must not look more precise, or more
    // confirmed, than the journal that produced it.
    const rendered = renderObservedResult(
      {
        value: {},
        logs: {
          errors: 0,
          logCursor: 3,
          logsDropped: 501,
          logsDroppedExact: false,
          logsSettled: false,
        },
      },
      'delta',
    ) as Record<string, unknown>;

    expect(rendered).toMatchObject({
      errors: 0,
      logsDropped: 501,
      logsDroppedExact: false,
      logsSettled: false,
    });
  });

  it('leaves an unobserved result alone', () => {
    expect(renderObservedResult({ value: { ok: true }, logs: { errors: 9, logCursor: 1 } }, undefined))
      .toEqual({ ok: true });
  });
});
