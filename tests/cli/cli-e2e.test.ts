/**
 * End-to-end CLI flows through the real `craftdriver` binary.
 *
 * These spawn the shipped bin and pipe a script through `--ephemeral`
 * stdin mode, so every layer is exercised the way an agent actually hits
 * it: argv parsing, dispatch, the browser, and JSON rendering. The
 * in-process tests call `session.run({ cmd, args })` directly and would
 * not catch a command that is wired up wrongly on the command line.
 *
 * Organised as realistic flows rather than one assertion per command —
 * a login, a settings form, keyboard and mouse work — because that is
 * how the commands are actually used, and it catches ordering and state
 * problems that isolated calls miss.
 *
 * Requires `npm run build` (the bin shim loads `dist/`) and the example
 * server on port 8080.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

const here = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(here, '..', '..', 'bin', 'craftdriver.mjs');

/** Each test spawns its own browser, so these run well past the 30s default. */
const E2E_TIMEOUT = 90_000;

interface Line {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface RunResult {
  exitCode: number;
  lines: Line[];
  stderr: string;
}

/** Run a newline-separated script through one ephemeral browser. */
async function runCli(
  script: string,
  extraEnv: NodeJS.ProcessEnv = {},
  extraArgs: string[] = []
): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('node', [CLI_BIN, '--ephemeral', '--browser', BROWSER_NAME, ...extraArgs], {
      env: { ...process.env, ...extraEnv, HEADLESS: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as Line;
          } catch {
            return { ok: false, error: { code: 'PARSE_ERROR', message: l } };
          }
        });
      resolveRun({ exitCode: code ?? 0, lines, stderr });
    });
    child.stdin.end(script);
  });
}

/** Run one command through the persistent daemon surface. */
async function runCliOnce(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('node', [CLI_BIN, ...args], {
      env: { ...process.env, ...extraEnv, HEADLESS: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as Line;
          } catch {
            return { ok: false, error: { code: 'PARSE_ERROR', message: l } };
          }
        });
      resolveRun({ exitCode: code ?? 0, lines, stderr });
    });
  });
}

/** Assert every step succeeded, naming the first that did not. */
function expectAllOk(run: RunResult): void {
  const failed = run.lines.findIndex((l) => !l.ok);
  if (failed !== -1) {
    throw new Error(
      `step ${failed} failed: ${JSON.stringify(run.lines[failed].error)}\n${run.stderr}`,
    );
  }
}

describe('CLI end-to-end flows', () => {
  it('drives a login form and lands on the welcome state', async () => {
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/login.html
      fill #username alice
      fill #password hunter2
      click #submit
      wait #welcome --state visible
      text #welcome
    `);

    expectAllOk(run);
    expect(run.exitCode).toBe(0);
    expect(String(run.lines.at(-1)!.result!.text)).toMatch(/welcome/i);
  }, E2E_TIMEOUT);

  it('returns an atomic page or delta observation only when requested', async () => {
    const run = await runCli(`
      open ${EXAMPLES_BASE_URL}/agent-actions.html --observe delta
      click #save --observe=delta
      click #counter --observe page
    `);

    expectAllOk(run);
    expect(run.lines[0].result!.delta).toContain('Agent actions');
    expect(run.lines[0].result!.delta).toContain('heading "Account settings" [level=1]');
    expect(run.lines[0].result!.delta).toContain('value="preset"');
    expect(run.lines[1].result).toMatchObject({
      ok: true,
      selector: '#save',
      delta: expect.stringContaining('text "saved" #log'),
    });
    expect(run.lines[1].result!.delta).not.toContain('no a11y changes');
    expect(run.lines[2].result).toMatchObject({
      ok: true,
      selector: '#counter',
      page: {
        url: expect.stringContaining('agent-actions.html'),
        documentId: expect.any(String),
        revision: expect.any(Number),
        documentChange: 'same',
      },
    });
  }, E2E_TIMEOUT);

  it('returns atomic deltas through the real persistent daemon', async () => {
    const daemonDir = mkdtempSync(join(tmpdir(), 'craftdriver-observe-daemon-'));
    const daemonEnv = {
      CRAFTDRIVER_SOCKET: join(daemonDir, 'sock'),
      CRAFTDRIVER_PID: join(daemonDir, 'pid'),
    };

    try {
      const opened = await runCliOnce([
        'open', `${EXAMPLES_BASE_URL}/agent-actions.html`, '--observe=delta',
        '--browser', BROWSER_NAME, '--headless',
      ], daemonEnv);
      expectAllOk(opened);

      const clicked = await runCliOnce(['click', '#save', '--observe=delta'], daemonEnv);
      expectAllOk(clicked);
      expect(clicked.lines[0].result).toMatchObject({
        ok: true,
        selector: '#save',
        delta: expect.stringContaining('text "saved" #log'),
      });
      expect(clicked.lines[0].result!.delta).not.toContain('no a11y changes');
    } finally {
      await runCliOnce(['daemon', 'stop'], daemonEnv).catch(() => undefined);
      rmSync(daemonDir, { recursive: true, force: true });
    }
  }, E2E_TIMEOUT);

  it('completes a settings form with every control type', async () => {
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      clear #nickname
      fill #nickname alice
      check #newsletter
      select #plan pro
      focus #nickname
      type -bob
      value #nickname
      is checked #newsletter
      value #plan
    `);

    expectAllOk(run);
    const [nickname, checked, plan] = run.lines.slice(-3);
    expect(nickname.result!.value).toBe('alice-bob');
    expect(checked.result!.result).toBe(true);
    expect(plan.result!.value).toBe('pro');
  }, E2E_TIMEOUT);

  it('explores with a ref and converts it to a durable locator', async () => {
    // The workflow the skill actually teaches: snapshot, act on a ref,
    // then ask for a selector that belongs in a committed test.
    const snap = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      snapshot
    `);
    expectAllOk(snap);
    const lines = snap.lines.at(-1)!.result!.lines as string[];
    const saveRef = /^(e\d+):/.exec(lines.find((l) => l.includes('#save'))!.trim())![1];

    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      snapshot
      locators ref=${saveRef}
    `);
    expectAllOk(run);

    const report = run.lines.at(-1)!.result as {
      best: string | null;
      candidates: Array<{ selector: string; status: string; code: string }>;
    };
    expect(report.best).toBe('role=button[name=Save changes]');
    expect(report.candidates.some((c) => c.selector === 'testid=save-button')).toBe(true);
    // Nothing an agent could paste into a test may carry a ref.
    for (const candidate of report.candidates) {
      expect(candidate.code).not.toMatch(/ref=e\d+/);
    }
  }, E2E_TIMEOUT);

  it('reports STALE_REF instead of acting on a replacement element', async () => {
    const snap = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-ref-shift.html
      snapshot
    `);
    expectAllOk(snap);
    const lines = snap.lines.at(-1)!.result!.lines as string[];
    const payRef = /^(e\d+):/.exec(lines.find((l) => / #pay(\s|$)/.test(l))!.trim())![1];

    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-ref-shift.html
      snapshot
      click #remove-pay
      click ref=${payRef}
    `);

    const last = run.lines.at(-1)!;
    expect(last.ok).toBe(false);
    expect(last.error!.code).toBe('STALE_REF');
    expect(run.exitCode).toBe(1);
  }, E2E_TIMEOUT);

  it('drives keyboard and mouse commands', async () => {
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      dblclick #counter
      text #dbl-count
      mouse click #save
      text #log
      scroll #far-below
      mouse wheel --delta-y 200
      key press Tab
    `);

    expectAllOk(run);
    expect(run.lines[2].result!.text).toBe('1');
    expect(run.lines[4].result!.text).toBe('saved');
  }, E2E_TIMEOUT);

  it('inspects, accepts and dismisses dialogs without stalling', async () => {
    // One spawn covers all three dialog cases. Regression: a modal blocks
    // script execution, so the automatic post-action snapshot used to sit
    // on the WebDriver script timeout — 60s per dialog-opening click.
    const started = Date.now();
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/dialogs.html
      dialog inspect
      click #show-alert
      dialog inspect
      dialog accept
      click #show-confirm
      dialog dismiss
      text #confirm-result
    `);

    expectAllOk(run);
    // No dialog open: an answer, not an error (the driver signals "no such
    // alert" by throwing).
    expect(run.lines[1].result).toMatchObject({ open: false, message: '' });
    expect(run.lines[3].result).toMatchObject({ open: true, message: 'Hello from alert' });
    expect(run.lines.at(-1)!.result!.text).toBe('dismissed');
    expect(Date.now() - started).toBeLessThan(60_000);
  }, E2E_TIMEOUT);

  it('keeps page observations explicit when identity is unknown or a dialog blocks snapshots', async () => {
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/login.html
      go ${EXAMPLES_BASE_URL}/dialogs.html --observe=page
      click #show-alert --observe=page
      dialog accept
    `);

    expectAllOk(run);
    expect(run.lines[1].result).toMatchObject({
      page: {
        url: expect.stringContaining('dialogs.html'),
        documentChange: 'unknown',
      },
    });
    expect(run.lines[2].result).toMatchObject({
      ok: true,
      selector: '#show-alert',
      warning: expect.stringContaining('dialog open: Hello from alert'),
    });
  }, E2E_TIMEOUT);

  it('uploads a file by path without echoing its contents', async () => {
    const file = resolve(process.cwd(), 'tests', 'fixtures', 'sample.txt');
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/upload.html
      upload #file-input ${file}
      value #file-input
    `);

    expectAllOk(run);
    expect(run.lines[1].result!.count).toBe(1);
    expect(String(run.lines.at(-1)!.result!.value)).toContain('sample.txt');
    expect(JSON.stringify(run.lines)).not.toContain('hello from craftdriver');
  }, E2E_TIMEOUT);

  it('inspects a page and captures a screenshot', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'craftdriver-cli-')), 'shot.png');
    const implicitRoot = mkdtempSync(join(tmpdir(), 'craftdriver-cli-latest-'));
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      find button --all --limit 3
      exists #save
      attr #save data-testid
      text #dbl-count
      pages
      press Tab #nickname
      screenshot -o ${out}
      screenshot
      screenshot
      quit
    `, { CRAFTDRIVER_SCREENSHOT_DIR: implicitRoot });

    expectAllOk(run);
    const [find, exists, attr, text, pages] = run.lines.slice(1);
    expect(find.result!.count as number).toBeGreaterThan(1);
    expect((find.result!.matches as unknown[]).length).toBeLessThanOrEqual(3);
    expect(exists.result).toMatchObject({ exists: true });
    expect(attr.result).toMatchObject({ name: 'data-testid', value: 'save-button' });
    expect(text.result!.text).toBe('0');
    expect((pages.result!.pages as unknown[]).length).toBeGreaterThan(0);
    expect(statSync(out).size).toBeGreaterThan(0);
    const implicit = run.lines
      .map((line) => line.result?.path)
      .filter((path): path is string => typeof path === 'string' && path.startsWith(implicitRoot));
    expect(implicit).toHaveLength(2);
    expect(implicit[0]).toBe(implicit[1]);
    expect(implicit[0]).toMatch(/screenshot-ephemeral\.png$/);
    expect(readdirSync(implicitRoot)).toEqual(['screenshot-ephemeral.png']);
  }, E2E_TIMEOUT);

  it('exits 1 when exists finds nothing, in ephemeral mode too', async () => {
    // The probe contract must not depend on the transport: the daemon
    // path applied it and the ephemeral path did not.
    const missing = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      exists #definitely-not-here
    `);
    expect(missing.lines.at(-1)!.result).toMatchObject({ exists: false });
    expect(missing.exitCode).toBe(1);

    const found = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      exists #save
    `);
    expect(found.exitCode).toBe(0);
  }, E2E_TIMEOUT);

  it('navigates through history with back and forward', async () => {
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      go ${EXAMPLES_BASE_URL}/agent-ref-shift.html
      back
      forward
      status
    `);

    expectAllOk(run);
    expect(String(run.lines[2].result!.url)).toContain('agent-actions.html');
    expect(String(run.lines[3].result!.url)).toContain('agent-ref-shift.html');
    expect(run.lines[4].result).toMatchObject({ ready: true });
  }, E2E_TIMEOUT);

  it('works across tabs: open, select, act, close', async () => {
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/popup.html
      click #open-popup
      page list
      page select 1
      text #popup-heading
      page close 1
      page list
    `);

    expectAllOk(run);
    expect(run.lines[2].result!.count).toBe(2);
    // Content in the second tab is unreachable until it is selected.
    expect(run.lines[4].result!.text).toBe('Popup Window');
    expect(run.lines[6].result!.count).toBe(1);
  }, E2E_TIMEOUT);

  it('exits 2 on a usage error and 1 on a failed action', async () => {
    const usage = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      is sideways #save
    `);
    expect(usage.stderr).toContain('is: unknown state "sideways"');
    expect(usage.exitCode).toBe(2);

    const missing = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      click #not-here --timeout 500
    `);
    expect(missing.lines.at(-1)!.ok).toBe(false);
    expect(missing.exitCode).toBe(1);
  }, E2E_TIMEOUT);

  it('fails a script line with an unknown flag instead of skipping it', async () => {
    // The line used to be dropped in silence: no output, no error, exit 0 —
    // so a typo turned a click into a no-op and the script still "passed".
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      click #save --forse
    `);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('unknown flag "--forse"');
    expect(run.stderr).toContain('--force');
  }, E2E_TIMEOUT);

  it('fails a script line with an unknown command instead of skipping it', async () => {
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      clik #save
    `);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('unknown command "clik"');
  }, E2E_TIMEOUT);

  it('stops an ephemeral script at the first failed command', async () => {
    // The script used to run on: the failed fill left #username empty, the
    // form was submitted anyway, and the last line returned the application's
    // own "Missing credentials" — an app-shaped answer to what was really a
    // broken selector. Collapsing the steps must not collapse the evidence.
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/login.html
      fill #not-a-field alice --timeout 500
      fill #password hunter2
      click #submit
      text #result
    `);

    expect(run.exitCode).toBe(1);
    expect(run.lines).toHaveLength(2);
    expect(run.lines[0].ok).toBe(true);
    expect(run.lines[1].ok).toBe(false);
    expect(run.stderr).toContain('stopped at failed step 2 of 5');
    expect(run.stderr).toContain('3 later commands not run');
  }, E2E_TIMEOUT);

  it('runs past a failed command with --continue-on-error', async () => {
    const run = await runCli(
      `
      go ${EXAMPLES_BASE_URL}/login.html
      fill #not-a-field alice --timeout 500
      text h1
    `,
      {},
      ['--continue-on-error']
    );

    expect(run.exitCode).toBe(1);
    expect(run.lines).toHaveLength(3);
    expect(run.lines[1].ok).toBe(false);
    expect(run.lines[2].ok).toBe(true);
  }, E2E_TIMEOUT);

  it('parses the whole ephemeral script before running any of it', async () => {
    // A typo on the last line used to be found only after the earlier lines
    // had already navigated and filled, leaving a half-driven browser behind
    // for a fault that was knowable without launching one.
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/login.html
      fill #username alice
      clik #submit
    `);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('unknown command "clik"');
    expect(run.lines).toHaveLength(0);
  }, E2E_TIMEOUT);

  it('rejects --continue-on-error outside an ephemeral script', async () => {
    const run = await runCliOnce(['status', '--continue-on-error']);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('--continue-on-error applies to an --ephemeral script');
  }, E2E_TIMEOUT);

  it('rejects launch and session flags inside an ephemeral script', async () => {
    const run = await runCli(`
      status --session checkout
      status --headed
    `);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('--session cannot be set inside an ephemeral script');
    expect(run.stderr).toContain('--headed cannot be set inside an ephemeral script');
    expect(run.lines).toHaveLength(0);
  }, E2E_TIMEOUT);

  it('keeps the documented 2000-character default for page text', async () => {
    // `--limit` here is a character budget, not a row count. Clamping it to
    // the list cap silently halved it to 1000.
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      text --limit 3000
    `);

    const text = run.lines.at(-1)!.result as { total: number; truncated: boolean };
    // The fixture is well under the budget, so nothing should be truncated —
    // which only holds if the requested 3000 survived the clamp.
    expect(text.truncated).toBe(false);
    expect(text.total).toBeLessThan(3000);
  }, E2E_TIMEOUT);

  it('reports element text with the same shape as page text', async () => {
    const run = await runCli(`
      go ${EXAMPLES_BASE_URL}/agent-actions.html
      text #save
    `);

    // `.text` is a string whether or not it was bounded; callers should not
    // have to type-test before reading it.
    const result = run.lines.at(-1)!.result as Record<string, unknown>;
    expect(typeof result.text).toBe('string');
    expect(result.truncated).toBe(false);
    expect(typeof result.total).toBe('number');
  }, E2E_TIMEOUT);
});
