/**
 * A batch against a real browser, end to end.
 *
 * `batch.test.ts` pins the semantics with fakes. This pins the part fakes
 * cannot: that several real commands in one queue slot leave the page in the
 * state each of them individually would have, that a failed step really does
 * stop the ones after it, and that the whole thing survives the daemon wire
 * and the shipped binary.
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
import { handleDaemonRequest } from '../../src/cli/daemon.js';
import { createSessionRegistry } from '../../src/cli/sessionRegistry.js';
import { ErrorCode } from '../../src/lib/errors.js';
import type { BatchOutcome } from '../../src/cli/batch.js';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

const here = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(here, '..', '..', 'bin', 'craftdriver.mjs');
const ACTIONS = `${EXAMPLES_BASE_URL}/agent-actions.html`;

function newSession(): AgentSession {
  return new AgentSession({
    launchOptions: { browserName: BROWSER_NAME },
    autoSnapshot: false,
  });
}

describe('a batch drives a real page', () => {
  let session: AgentSession;

  beforeAll(() => {
    session = newSession();
  });

  afterAll(async () => {
    await session.close();
  });

  it('runs the flow and reports each step, with one accumulated observation', async () => {
    const outcome = await session.runBatch({
      observe: 'delta',
      steps: [
        { cmd: 'go', args: { url: ACTIONS } },
        { cmd: 'fill', args: { selector: '#nickname', value: 'mitko' } },
        { cmd: 'check', args: { selector: '#newsletter' } },
        { cmd: 'select', args: { selector: '#plan', value: 'pro' } },
        { cmd: 'click', args: { selector: '#save' } },
      ],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ran).toBe(5);
    expect(outcome.skipped).toBe(0);
    expect(outcome.steps.map((step) => step.ok)).toEqual([true, true, true, true, true]);
    for (const step of outcome.steps) expect(step.durationMs).toBeGreaterThan(0);

    // The single delta covers what the unobserved steps did, not just the
    // click that was last — that accumulation is why one observation is
    // enough for the whole batch.
    expect(outcome.delta).toContain('mitko');
    expect(outcome.delta).toContain('saved');

    // And the page really is in the state every step asked for.
    await expect(session.run({ cmd: 'value', args: { selector: '#nickname' } })).resolves.toMatchObject({
      value: 'mitko',
    });
    await expect(
      session.run({ cmd: 'is', args: { what: 'checked', selector: '#newsletter' } })
    ).resolves.toMatchObject({ result: true });
    await expect(session.run({ cmd: 'value', args: { selector: '#plan' } })).resolves.toMatchObject({
      value: 'pro',
    });
  });

  it('stops at the failed step and leaves the later ones unrun', async () => {
    await session.run({ cmd: 'go', args: { url: ACTIONS } });

    const outcome = await session.runBatch({
      steps: [
        { cmd: 'fill', args: { selector: '#nickname', value: 'before' } },
        { cmd: 'fill', args: { selector: '#nonexistent', value: 'never', timeout: 500 } },
        { cmd: 'click', args: { selector: '#save' } },
      ],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failedStep).toBe(1);
    expect(outcome.ran).toBe(2);
    expect(outcome.skipped).toBe(1);

    // The click never happened, so the page never logged "saved". Without
    // fail-fast this reads as an application answer rather than a broken
    // selector — the exact confusion the stop rule exists to prevent.
    await expect(session.run({ cmd: 'text', args: { selector: '#log' } })).resolves.toMatchObject({
      text: 'keydown seen',
    });
  });

  it('reports whether any step made the application throw', async () => {
    const outcome = await session.runBatch({
      observe: 'delta',
      steps: [
        { cmd: 'go', args: { url: `${EXAMPLES_BASE_URL}/console-errors.html` } },
        { cmd: 'click', args: { selector: '#btn-console-log' } },
        { cmd: 'click', args: { selector: '#btn-console-error' } },
      ],
    });

    // One observation covers the whole batch, so an error from an unobserved
    // middle step is exactly what would otherwise go unnoticed.
    expect(outcome.ok).toBe(true);
    expect(outcome.logs?.errors).toBe(1);
    expect(outcome.logs?.logCursor).toEqual(expect.any(Number));
  });

  it('attaches a recovery snapshot when a step spends a stale ref', async () => {
    await session.run({ cmd: 'go', args: { url: ACTIONS } });
    const snapshot = (await session.run({ cmd: 'snapshot' })) as { lines: string[] };
    const line = snapshot.lines.find((l) => l.includes('Save changes'));
    expect(line).toBeDefined();
    const ref = /^\s*(e\d+):/.exec(line!)![1];

    // Reload: the ref was issued against a document that no longer exists.
    await session.run({ cmd: 'reload', args: {} });

    const outcome = await session.runBatch({
      steps: [{ cmd: 'click', args: { selector: `ref=${ref}` } }],
    });

    expect(outcome.ok).toBe(false);
    const error = outcome.steps[0].error;
    expect(error?.code).toBe(ErrorCode.STALE_REF);
    expect(error?.recoverySnapshot).toContain('Save changes');
    // Context, never a repair: the click was not retried against whatever the
    // new snapshot happens to contain, so the page never logged "saved".
    await expect(session.run({ cmd: 'text', args: { selector: '#log' } })).resolves.toMatchObject({
      text: '',
    });
  });
});

describe('the daemon serves a batch on one session', () => {
  const registry = createSessionRegistry({ create: () => newSession() });

  afterAll(async () => {
    await registry.closeAll();
  });

  it('routes it to the named session and answers with the outcome', async () => {
    const response = await handleDaemonRequest(registry, {
      id: 7,
      cmd: 'batch',
      session: 'shopper',
      args: {
        steps: [
          { cmd: 'go', args: { url: ACTIONS } },
          { cmd: 'fill', args: { selector: '#nickname', value: 'wire' } },
        ],
        observe: 'delta',
      },
    });

    expect(response.ok).toBe(true);
    const outcome = (response as { result: BatchOutcome }).result;
    expect(outcome.ok).toBe(true);
    expect(outcome.steps.map((step) => step.cmd)).toEqual(['go', 'fill']);
    expect(outcome.delta).toContain('wire');
  });

  it('refuses a malformed batch without touching a browser', async () => {
    const response = await handleDaemonRequest(registry, {
      id: 8,
      cmd: 'batch',
      session: 'never-created',
      args: { steps: [{ cmd: 'quit' }] },
    });

    expect(response.ok).toBe(false);
    expect((response as { error: { code: string } }).error.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(registry.list().map((s) => s.name)).not.toContain('never-created');
  });
});

describe('`craftdriver run` through the shipped binary', () => {
  // Its own socket, so the test neither disturbs nor is disturbed by a daemon
  // the developer already has running for this project.
  const home = mkdtempSync(join(tmpdir(), 'craftdriver-batch-'));
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

  function cli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
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

  it('runs a script against the live daemon session in one call', async () => {
    const script = [
      `go ${ACTIONS}`,
      "fill '#nickname' mitko",
      'check #newsletter',
      'select #plan pro',
      'click #save --observe=delta',
    ].join('\n');

    const { code, stdout, stderr } = await cli(['run', '--session', 'batchflow'], script);
    expect(stderr).toBe('');
    expect(code).toBe(0);

    const { ok, result } = JSON.parse(stdout.trim()) as { ok: boolean; result: BatchOutcome };
    expect(ok).toBe(true);
    expect(result.steps.map((step) => step.cmd)).toEqual(['go', 'fill', 'check', 'select', 'click']);
    expect(result.delta).toContain('saved');

    // The session outlives the batch: a following command sees the same page.
    const after = await cli(['value', '#nickname', '--session', 'batchflow']);
    expect(JSON.parse(after.stdout.trim())).toMatchObject({ result: { value: 'mitko' } });
  });

  it('exits non-zero on a failed step and names it, before running the rest', async () => {
    const script = [
      `go ${ACTIONS}`,
      "fill '#nonexistent' alice --timeout 500",
      "click '#save'",
    ].join('\n');

    const { code, stdout } = await cli(['run', '--session', 'batchfail'], script);
    expect(code).toBe(1);

    const { ok, result } = JSON.parse(stdout.trim()) as { ok: boolean; result: BatchOutcome };
    expect(ok).toBe(false);
    expect(result.failedStep).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('fails the run when a step executed fine and answered no', async () => {
    // `exists` matching nothing exits 1 as a single command and inside an
    // --ephemeral script. A batch reporting 0 for it would make the same
    // script pass or fail depending only on how it was run.
    const script = [
      `go ${ACTIONS}`,
      'exists #definitely-not-here',
      "fill '#nickname' never-reached",
    ].join('\n');

    const { code, stdout } = await cli(['run', '--session', 'batchverdict'], script);
    expect(code).toBe(1);

    const { ok, result } = JSON.parse(stdout.trim()) as { ok: boolean; result: BatchOutcome };
    expect(ok).toBe(false);
    expect(result.failedStep).toBe(1);
    expect(result.skipped).toBe(1);
    // The answer survives alongside the verdict.
    expect(result.steps[1].result).toMatchObject({ exists: false });
    expect(result.steps[1].error?.code).toBe(ErrorCode.NO_MATCH);
  });

  it('rejects a bad script before it starts anything', async () => {
    const { code, stdout, stderr } = await cli(['run'], 'click #pay --forse\n');
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('unknown flag "--forse"');
  });
});
