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

/**
 * Spawn `craftdriver --ephemeral` and feed a script via stdin.
 * stdout is piped (not a TTY) so the CLI emits one JSON object per
 * command on stdout by default.
 */
async function runCli(script: string): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      'node',
      [CLI_BIN, '--ephemeral', '--browser', BROWSER_NAME],
      {
        env: { ...process.env, HEADLESS: 'true' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

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
        .map((l) => {
          try {
            return JSON.parse(l) as RunResult['lines'][number];
          } catch {
            return { ok: false, error: { code: 'PARSE_ERROR', message: l } };
          }
        });
      resolveRun({ exitCode: code ?? -1, stdout, stderr, lines });
    });

    child.stdin.write(script);
    child.stdin.end();
  });
}

describe('CLI smoke', () => {
  const loginUrl = `${EXAMPLES_BASE_URL}/login.html`;

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
    expect(run.lines.every((l) => l.ok)).toBe(true);

    const last = run.lines[4];
    const result = last.result as { text: string };
    expect(result.text).toContain('Welcome back, testuser!');
  });

  it('takes a snapshot listing the form controls with refs', async () => {
    const script = [`go ${loginUrl}`, `snapshot`].join('\n');
    const run = await runCli(script);

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.lines).toHaveLength(2);
    expect(run.lines.every((l) => l.ok)).toBe(true);

    const snap = run.lines[1].result as { url: string; lines: string[] };
    expect(snap.url).toContain('/login.html');
    const all = snap.lines.join('\n');
    // Verify the renderer emitted refs + roles for the known controls.
    expect(all).toMatch(/e\d+: textbox .*Username/);
    expect(all).toMatch(/e\d+: textbox .*Password/);
    expect(all).toMatch(/e\d+: button .*Sign in/i);
  });

  it('surfaces stable error codes for missing selectors', async () => {
    const script = [
      `go ${loginUrl}`,
      `exists "#username"`, // present
      `exists "#definitely-not-here"`, // absent — ok:true, exists:false
      `text "#definitely-not-here"`, // missing — ok:false, NO_MATCH
    ].join('\n');

    const run = await runCli(script);

    // `exists` with no match returns exit 1 (sticky across the script);
    // and `text` against a missing element returns exit 1 (NO_MATCH).
    // Either way, the script's final rc is non-zero.
    expect(run.exitCode).toBe(1);
    expect(run.lines).toHaveLength(4);

    expect(run.lines[1].ok).toBe(true);
    expect((run.lines[1].result as { exists: boolean }).exists).toBe(true);

    expect(run.lines[2].ok).toBe(true);
    expect((run.lines[2].result as { exists: boolean }).exists).toBe(false);

    expect(run.lines[3].ok).toBe(false);
    expect(run.lines[3].error?.code).toBe('NO_MATCH');
  });
});
