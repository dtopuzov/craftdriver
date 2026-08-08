/**
 * `expect` — a verification step with a verdict, against a real page.
 *
 * The distinction being pinned here is the whole point of the command: `is
 * visible` and `exists` are *reads*, so they answer and exit 0 whatever the
 * answer is. `expect` fails. That is what lets a batch report that the outcome
 * was the wanted one rather than only that every step executed, and it is why
 * most of these tests care about the failure path.
 *
 * The second thing under test is the diagnosis. A failed assertion that says
 * only "timed out" costs the agent one or two more round trips to learn what
 * the driver already knew, so the failures assert on their own wording:
 * "hidden" and "nothing matched" must not look alike, and a missing element
 * must never be reported as text `""`.
 *
 * Requires `npm run build` (the bin shim loads `dist/`) and the example server
 * on port 8080.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSession } from '../../src/cli/agentSession.js';
import { CraftdriverError, ErrorCode } from '../../src/lib/errors.js';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

const here = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(here, '..', '..', 'bin', 'craftdriver.mjs');
const ACTIONS = `${EXAMPLES_BASE_URL}/agent-actions.html`;
const DISPLAYED = `${EXAMPLES_BASE_URL}/displayed.html`;
const CONSOLE_ERRORS = `${EXAMPLES_BASE_URL}/console-errors.html`;

/** Short, because every negative case here waits it out. */
const FAST = 700;

function newSession(): AgentSession {
  return new AgentSession({
    launchOptions: { browserName: BROWSER_NAME },
    autoSnapshot: false,
  });
}

/** Run `expect` and return the error it threw. Fails the test if it passed. */
async function failureOf(
  session: AgentSession,
  args: Record<string, unknown>
): Promise<CraftdriverError> {
  try {
    await session.run({ cmd: 'expect', args: { timeout: FAST, ...args } });
  } catch (error) {
    if (!CraftdriverError.is(error)) throw error;
    return error;
  }
  throw new Error(`expect ${JSON.stringify(args)} passed, but the test needed it to fail`);
}

describe('expect visible', () => {
  let session: AgentSession;

  beforeAll(async () => {
    session = newSession();
    await session.run({ cmd: 'go', args: { url: DISPLAYED } });
  });

  afterAll(async () => {
    await session.close();
  });

  it('passes on a displayed element and reports what it checked', async () => {
    await expect(
      session.run({ cmd: 'expect', args: { what: 'visible', selector: '#visible-el' } })
    ).resolves.toMatchObject({ ok: true, matcher: 'visible', selector: '#visible-el' });
  });

  it('distinguishes hidden from absent, which is the expensive confusion', async () => {
    // Present but display:none. The agent's next move is "open the thing
    // containing it"; for a selector that matches nothing it is "fix the
    // selector". A bare timeout tells it neither.
    const hidden = await failureOf(session, { what: 'visible', selector: '#display-none-self' });
    expect(hidden.code).toBe(ErrorCode.EXPECT_MISMATCH);
    expect(hidden.message).toContain('#display-none-self');
    expect(hidden.message).toContain('hidden');
    expect(hidden.detail).toMatchObject({ actual: 'hidden', matched: 1 });
    expect(hidden.hint).toContain('exists');

    const absent = await failureOf(session, { what: 'visible', selector: '#no-such-element' });
    expect(absent.code).toBe(ErrorCode.EXPECT_MISMATCH);
    expect(absent.message).toContain('nothing matched');
    expect(absent.detail).toMatchObject({ actual: 'no match', matched: 0 });
  });

  it('waits for an element that is not visible yet', async () => {
    await session.run({
      cmd: 'eval',
      args: {
        js: `const el = document.createElement('div');
             el.id = 'late'; el.textContent = 'here'; el.style.display = 'none';
             document.body.appendChild(el);
             setTimeout(() => { el.style.display = 'block'; }, 300);
             return true;`,
      },
    });
    await expect(
      session.run({ cmd: 'expect', args: { what: 'visible', selector: '#late', timeout: 4000 } })
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('expect text', () => {
  let session: AgentSession;

  beforeAll(async () => {
    session = newSession();
    await session.run({ cmd: 'go', args: { url: ACTIONS } });
    await session.run({ cmd: 'click', args: { selector: '#save' } });
  });

  afterAll(async () => {
    await session.close();
  });

  it('matches exactly on a positional value and by substring on --contains', async () => {
    await expect(
      session.run({ cmd: 'expect', args: { what: 'text', selector: '#log', expected: 'saved' } })
    ).resolves.toMatchObject({ ok: true, matcher: 'text', mode: 'exact', expected: 'saved' });
    await expect(
      session.run({ cmd: 'expect', args: { what: 'text', selector: '#log', contains: 'ave' } })
    ).resolves.toMatchObject({ ok: true, mode: 'contains' });
    // Exact really is exact, or `--contains` would be pointless.
    const partial = await failureOf(session, {
      what: 'text',
      selector: '#log',
      expected: 'ave',
    });
    expect(partial.code).toBe(ErrorCode.EXPECT_MISMATCH);
  });

  it('quotes the text it actually found', async () => {
    const failure = await failureOf(session, {
      what: 'text',
      selector: '#log',
      expected: 'discarded',
    });
    expect(failure.message).toContain('"discarded"');
    expect(failure.message).toContain('"saved"');
    expect(failure.detail).toMatchObject({ expected: 'discarded', actual: 'saved', matched: 1 });
  });

  it('says nothing matched rather than reporting empty text', async () => {
    // The library's own message here is `but got ""`, which reads as "the
    // element is there and empty" — a different problem with a different fix.
    const failure = await failureOf(session, {
      what: 'text',
      selector: '#no-such-element',
      contains: 'saved',
    });
    expect(failure.message).toContain('nothing matched');
    expect(failure.message).not.toContain('got ""');
    expect(failure.detail).toMatchObject({ matched: 0, actual: null });
  });

  it('requires exactly one of an expected value and --contains', async () => {
    for (const args of [
      { what: 'text', selector: '#log' },
      { what: 'text', selector: '#log', expected: 'saved', contains: 'saved' },
    ]) {
      const failure = await failureOf(session, args);
      expect(failure.code).toBe(ErrorCode.INVALID_ARGUMENT);
    }
  });
});

describe('expect url', () => {
  let session: AgentSession;

  beforeAll(async () => {
    session = newSession();
    await session.run({ cmd: 'go', args: { url: ACTIONS } });
  });

  afterAll(async () => {
    await session.close();
  });

  it('matches the whole URL, or a substring with --contains', async () => {
    await expect(
      session.run({ cmd: 'expect', args: { what: 'url', expected: ACTIONS } })
    ).resolves.toMatchObject({ ok: true, matcher: 'url', mode: 'exact' });
    await expect(
      session.run({ cmd: 'expect', args: { what: 'url', contains: '/agent-actions.html' } })
    ).resolves.toMatchObject({ ok: true, mode: 'contains' });
  });

  it('reports the substring the caller typed, not the pattern built from it', async () => {
    // `--contains` rides the library's RegExp matcher. Leaking the escaped
    // pattern into the message would show the agent something it never wrote.
    const failure = await failureOf(session, { what: 'url', contains: '/dashboard' });
    expect(failure.code).toBe(ErrorCode.EXPECT_MISMATCH);
    expect(failure.message).toContain('"/dashboard"');
    expect(failure.message).not.toContain('\\/');
    expect(failure.message).toContain('agent-actions.html');
    expect(failure.detail).toMatchObject({ expected: '/dashboard', actual: ACTIONS });
  });

  it('auto-waits through a navigation', async () => {
    await session.run({
      cmd: 'eval',
      args: { js: `setTimeout(() => { location.href = 'login.html'; }, 250); return true;` },
    });
    await expect(
      session.run({ cmd: 'expect', args: { what: 'url', contains: '/login.html', timeout: 5000 } })
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('expect no-errors', () => {
  let session: AgentSession;

  beforeAll(async () => {
    session = newSession();
    await session.run({ cmd: 'go', args: { url: CONSOLE_ERRORS } });
    // The fixture logs on load; only errors count, and it logs none.
    await session.run({ cmd: 'click', args: { selector: '#btn-console-log' } });
  });

  afterAll(async () => {
    await session.close();
  });

  it('passes on a page that logged no errors, and hands back the cursor', async () => {
    const result = (await session.run({ cmd: 'expect', args: { what: 'no-errors' } })) as {
      ok: boolean;
      errors: number;
      logCursor: number;
    };
    expect(result).toMatchObject({ ok: true, matcher: 'no-errors', errors: 0 });
    expect(result.logCursor).toBeGreaterThan(0);
  });

  it('fails with the error text, so the verdict needs no follow-up logs call', async () => {
    const before = (await session.run({ cmd: 'expect', args: { what: 'no-errors' } })) as {
      logCursor: number;
    };
    await session.run({ cmd: 'click', args: { selector: '#btn-console-error' } });

    const failure = await failureOf(session, { what: 'no-errors' });
    expect(failure.code).toBe(ErrorCode.EXPECT_MISMATCH);
    expect(failure.message).toContain('the page logged 1');
    expect(failure.message).toContain('via console.error');
    expect(failure.hint).toContain('logs --kind error');

    // Same failure, narrowed to the window after the earlier clean check —
    // the cursor an observation already emits is what makes that possible.
    const narrowed = await failureOf(session, { what: 'no-errors', since: before.logCursor });
    expect(narrowed.detail).toMatchObject({ actual: 1, since: before.logCursor });
  });

  it('is repeatable: checking twice does not consume the evidence', async () => {
    // Deliberately not "since my last check". An assertion that passes on a
    // re-run because the first run moved a cursor is worse than a noisy one.
    const first = await failureOf(session, { what: 'no-errors' });
    const second = await failureOf(session, { what: 'no-errors' });
    expect(second.detail?.actual).toBe(first.detail?.actual);
  });

  it('starts clean again after logs clear', async () => {
    await session.run({ cmd: 'logs', args: { action: 'clear' } });
    await expect(session.run({ cmd: 'expect', args: { what: 'no-errors' } })).resolves.toMatchObject(
      { ok: true, errors: 0 }
    );
  });
});

describe('expect inside a batch', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = newSession();
  });

  afterAll(async () => {
    await session.close();
  });

  it('stops the batch at the assertion that did not hold', async () => {
    const outcome = await session.runBatch({
      steps: [
        { cmd: 'go', args: { url: ACTIONS } },
        { cmd: 'click', args: { selector: '#save' } },
        { cmd: 'expect', args: { what: 'text', selector: '#log', expected: 'nope', timeout: FAST } },
        { cmd: 'click', args: { selector: '#counter' } },
      ],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failedStep).toBe(2);
    expect(outcome.skipped).toBe(1);
    expect(outcome.steps[2].error?.code).toBe(ErrorCode.EXPECT_MISMATCH);
    // Without the verdict this batch would have reported four green steps and
    // an application that quietly did the wrong thing.
    expect(outcome.steps[2].error?.message).toContain('"saved"');
  });

  it('carries the batch observation when the assertion is the last step', async () => {
    const outcome = await session.runBatch({
      observe: 'delta',
      steps: [
        { cmd: 'go', args: { url: ACTIONS } },
        { cmd: 'fill', args: { selector: '#nickname', value: 'mitko' } },
        { cmd: 'click', args: { selector: '#save' } },
        { cmd: 'expect', args: { what: 'text', selector: '#log', contains: 'saved' } },
      ],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.delta).toContain('mitko');
    expect(outcome.logs?.errors).toBe(0);
  });

  it('observes a standalone assertion when one is asked for', async () => {
    // `expect` is not mutating, so it never triggers an auto-snapshot — but an
    // explicit --observe must still be honoured, or the flag a batch requires
    // on its last step would be a silent no-op run on its own.
    await session.run({ cmd: 'go', args: { url: ACTIONS } });
    await session.run({ cmd: 'click', args: { selector: '#save' } });
    const detailed = await session.runDetailed({
      cmd: 'expect',
      args: { what: 'visible', selector: '#log' },
      observe: 'page',
    });
    expect(detailed.value).toMatchObject({ ok: true });
    expect(detailed.page?.title).toBe('Agent actions');
  });

  // Last in this session on purpose: it leaves a real error in the journal,
  // which every later observation in the same session would then report.
  it('catches an error the batch caused, not just one that predates it', async () => {
    // The click's own response comes back before the console event it caused,
    // so counting immediately would report the page clean. Inside a batch
    // there is no second process whose startup would have covered the gap —
    // this is the case the ordering barrier exists for.
    const outcome = await session.runBatch({
      steps: [
        { cmd: 'go', args: { url: CONSOLE_ERRORS } },
        { cmd: 'click', args: { selector: '#btn-console-error' } },
        { cmd: 'expect', args: { what: 'no-errors' } },
      ],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failedStep).toBe(2);
    expect(outcome.steps[2].error?.code).toBe(ErrorCode.EXPECT_MISMATCH);
    expect(outcome.steps[2].error?.message).toContain('via console.error');
  });
});

describe('`craftdriver expect` through the shipped binary', () => {
  const home = mkdtempSync(join(tmpdir(), 'craftdriver-expect-'));
  const env = {
    ...process.env,
    HEADLESS: 'true',
    CRAFTDRIVER_SOCKET: join(home, 'sock'),
    CRAFTDRIVER_PID: join(home, 'pid'),
  };

  afterAll(async () => {
    await cli(['daemon', 'stop']);
    rmSync(home, { recursive: true, force: true });
  });

  function cli(
    args: string[],
    stdin?: string
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolveRun, reject) => {
      const child = spawn('node', [CLI_BIN, ...args, '--browser', BROWSER_NAME, '--json'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => (stdout += String(b)));
      child.stderr.on('data', (b) => (stderr += String(b)));
      child.on('error', reject);
      child.on('close', (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
      if (stdin !== undefined) child.stdin.end(stdin);
      else child.stdin.end();
    });
  }

  it('exits 0 when the expectation holds and 1 when it does not', async () => {
    const session = ['--session', 'verdict'];
    await cli(['go', ACTIONS, ...session]);

    const pass = await cli(['expect', 'visible', '#save', ...session]);
    expect(pass.code).toBe(0);
    expect(JSON.parse(pass.stdout.trim())).toMatchObject({ ok: true, result: { ok: true } });

    // The read next to it succeeds either way — that difference is the feature.
    const read = await cli(['is', 'visible', '#no-such-element', ...session]);
    expect(read.code).toBe(0);

    const fail = await cli(['expect', 'visible', '#no-such-element', '--timeout', '500', ...session]);
    expect(fail.code).toBe(1);
    // Piped output is JSON on stdout — the same envelope every other failure
    // uses, so a batch and a lone assertion report a mismatch identically.
    expect(JSON.parse(fail.stdout.trim())).toMatchObject({
      ok: false,
      error: { code: 'EXPECT_MISMATCH' },
    });
  });

  it('exits 2 on a usage mistake, before starting anything', async () => {
    const { code, stdout, stderr } = await cli(['expect', 'enabled', '#save']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('unknown action "enabled"');
  });

  it('runs as a batch step and stops the script it is in', async () => {
    const passing = [
      `go ${ACTIONS}`,
      "click '#save'",
      "expect text '#log' --contains saved --observe=delta",
    ].join('\n');
    const ok = await cli(['run', '--session', 'verdictrun'], passing);
    expect(ok.code).toBe(0);
    const okOutcome = JSON.parse(ok.stdout.trim()).result as {
      steps: Array<{ cmd: string; ok: boolean }>;
      delta?: string;
    };
    expect(okOutcome.steps.map((s) => s.cmd)).toEqual(['go', 'click', 'expect']);
    expect(okOutcome.delta).toContain('saved');

    const failing = [
      `go ${ACTIONS}`,
      "expect text '#log' --contains saved --timeout 500",
      "click '#counter'",
    ].join('\n');
    const bad = await cli(['run', '--session', 'verdictrun2'], failing);
    expect(bad.code).toBe(1);
    const outcome = JSON.parse(bad.stdout.trim()).result as {
      failedStep: number;
      skipped: number;
    };
    expect(outcome.failedStep).toBe(1);
    expect(outcome.skipped).toBe(1);
  });
});
