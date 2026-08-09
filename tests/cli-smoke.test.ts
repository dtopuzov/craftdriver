/**
 * CLI smoke tests — spawn the `craftdriver` binary as a child process,
 * pipe a script through `--ephemeral` stdin mode, and assert on the
 * JSON-per-line output.
 *
 * The CLI bin shim loads `dist/cli/index.js`, so these tests require
 * `npm run build` to have been run. If dist is missing the shim exits
 * with code 2 and a clear message — the assertions below will surface
 * that without ambiguity.
 *
 * Why ephemeral mode: it makes each test self-contained (one short-lived
 * browser per spawn) without needing to coordinate a daemon socket.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

const here = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(here, '..', 'bin', 'craftdriver.mjs');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Each non-empty JSON line on stdout, parsed. */
  lines: Array<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>;
}

function parseOutputLine(line: string): RunResult['lines'][number] {
  try {
    return JSON.parse(line) as RunResult['lines'][number];
  } catch {
    return { ok: false, error: { code: 'PARSE_ERROR', message: line } };
  }
}

/**
 * Spawn `craftdriver --ephemeral` and feed a script via stdin.
 * stdout is piped (not a TTY) so the CLI emits one JSON object per
 * command on stdout by default.
 */
async function runCli(script: string, extraArgs: string[] = []): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn('node', [CLI_BIN, '--ephemeral', '--browser', BROWSER_NAME, ...extraArgs], {
      env: { ...process.env, HEADLESS: 'true' },
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
        .filter((l) => l.length > 0)
        .map(parseOutputLine);
      resolveRun({ exitCode: code ?? -1, stdout, stderr, lines });
    });

    child.stdin.write(script);
    child.stdin.end();
  });
}

describe('CLI smoke', () => {
  const loginUrl = `${EXAMPLES_BASE_URL}/login.html`;
  const selectorsUrl = `${EXAMPLES_BASE_URL}/selectors.html`;

  it('drives a login flow end-to-end', async () => {
    const script = [
      `go ${loginUrl}`,
      `fill "#username" testuser`,
      `fill "#password" secret`,
      `click "#submit"`,
      `text "#result"`,
    ].join('\n');

    const run = await runCli(script);

    expect(run.exitCode, run.stderr).toBe(0);
    // One JSON line per command — 5 commands.
    expect(run.lines).toHaveLength(5);
    expect(run.lines.map((line) => line.ok)).toEqual([true, true, true, true, true]);

    expect(run.lines.at(-1)?.result).toMatchObject({
      text: expect.stringContaining('Welcome back, testuser!'),
    });
  });

  it('takes a snapshot listing the form controls with refs', async () => {
    const script = [`go ${loginUrl}`, `snapshot`].join('\n');
    const run = await runCli(script);

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.lines).toHaveLength(2);
    expect(run.lines.map((line) => line.ok)).toEqual([true, true]);

    const snap = run.lines[1].result as { url: string; lines: string[] };
    expect(snap.url).toContain('/login.html');
    const all = snap.lines.join('\n');
    // Verify the renderer emitted refs + roles for the known controls.
    expect(all).toMatch(/e\d+: textbox .*Username/);
    // A password input has no corresponding ARIA role, so it is listed under
    // its tag rather than being claimed as a textbox it cannot be resolved
    // as. It still carries a ref and its accessible name.
    expect(all).toMatch(/e\d+: input .*Password/);
    expect(all).toMatch(/e\d+: button .*Sign in/i);
  });

  it('uses the same common role mappings in snapshots as By.role()', async () => {
    const script = [`go ${selectorsUrl}`, `snapshot`].join('\n');
    const run = await runCli(script);

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.lines).toHaveLength(2);
    expect(run.lines.map((line) => line.ok)).toEqual([true, true]);

    const snap = run.lines[1].result as { url: string; lines: string[] };
    expect(snap.url).toContain('/selectors.html');
    const all = snap.lines.join('\n');
    expect(all).toMatch(/e\d+: combobox .*#single-select/);
    expect(all).toMatch(/e\d+: listbox .*#multi-select/);
    expect(all).toMatch(/e\d+: banner .*#page-header/);
    expect(all).toMatch(/e\d+: contentinfo .*#page-footer/);
    expect(all).not.toContain('article-header');
    expect(all).not.toContain('article-footer');
  });

  it('surfaces stable error codes for missing selectors', async () => {
    const script = [
      `go ${loginUrl}`,
      `exists "#username"`, // present
      `exists "#definitely-not-here"`, // absent — ok:true, exists:false
      `text "#definitely-not-here"`, // missing — ok:false, NO_MATCH
    ].join('\n');

    // A probe that answered no exits 1, and in a script — where there is
    // nothing to branch on — that stops the run like any other failed step.
    const stopped = await runCli(script);
    expect(stopped.exitCode).toBe(1);
    expect(stopped.lines).toHaveLength(3);
    expect(stopped.lines[1].result).toMatchObject({ exists: true });
    expect(stopped.lines[2].result).toMatchObject({ exists: false });
    expect(stopped.stderr).toContain('stopped at failed step 3 of 4');

    // Said the other way — these probes are independent — every line runs and
    // each keeps its own code.
    const run = await runCli(script, ['--continue-on-error']);
    expect(run.exitCode).toBe(1);
    expect(run.lines).toHaveLength(4);

    expect(run.lines[1].ok).toBe(true);
    expect(run.lines[1].result).toMatchObject({ exists: true });

    expect(run.lines[2].ok).toBe(true);
    expect(run.lines[2].result).toMatchObject({ exists: false });

    expect(run.lines[3].ok).toBe(false);
    expect(run.lines[3].error?.code).toBe('NO_MATCH');
  });
});
