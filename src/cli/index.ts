/**
 * CLI entry point — `bin/craftdriver` invokes this after compile.
 *
 * Three modes:
 *
 * 1. `daemon start`   — fork into a long-running daemon process.
 * 2. `--ephemeral`    — short-lived browser, read commands from stdin
 *                       (one per line). Required for sandboxed cloud
 *                       agents that can't keep a daemon between calls.
 * 3. default          — talk to the running daemon over the socket;
 *                       auto-start one if none is up.
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Browser } from '../lib/browser.js';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import { createBrowserHandle, dispatch } from './dispatcher.js';
import { parseArgv, HELP_TEXT, type ParsedCommand, type GlobalFlags } from './parseArgs.js';
import { DaemonClient } from './client.js';
import { runDaemon, toWireError } from './daemon.js';
import { DAEMON_SOCKET_PATH, DAEMON_PID_PATH } from './defaults.js';
import { runInit, SUPPORTED_FLAVORS, type Flavor } from './init.js';
import { runMcpServer } from './mcp/server.js';
import type { LaunchOptions } from '../lib/browser.js';

const VERSION = '0.1.0';

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);

  if (parsed === null) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (parsed.cmd === '__version__') {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (parsed.flags.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (parsed.cmd === '__help__' || parsed.flags.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (parsed.cmd === '__unknown__') {
    process.stderr.write(`error: unknown command "${parsed.args.cmd as string}"\nrun: craftdriver --help\n`);
    return 2;
  }
  applyHeadless(parsed.flags);

  // ------------------------------------------------------------------
  // `init <flavor>` — no browser, no daemon. Writes agent-guide files
  // into the current project.
  // ------------------------------------------------------------------
  if (parsed.cmd === 'init') return runInitCommand(parsed);

  // ------------------------------------------------------------------
  // `mcp` — long-lived JSON-RPC server on stdio. Browser is launched
  // lazily on first tool call. No daemon involved (the MCP process is
  // itself the long-lived session).
  // ------------------------------------------------------------------
  if (parsed.cmd === 'mcp') {
    await runMcpServer({ launch: parsed.flags.launch });
    return 0;
  }

  // ------------------------------------------------------------------
  // Daemon control commands — handled in the foreground process.
  // ------------------------------------------------------------------
  if (parsed.cmd === 'daemon:start') return daemonStart(parsed.flags);
  if (parsed.cmd === 'daemon:stop') return daemonStop(parsed);
  if (parsed.cmd === 'daemon:status') return daemonStatus(parsed);
  if (parsed.cmd === 'daemon:run') return daemonRun(parsed.flags); // internal: actual daemon process

  // ------------------------------------------------------------------
  // Ephemeral mode — no daemon involved.
  // ------------------------------------------------------------------
  if (parsed.flags.ephemeral) return runEphemeral(parsed);

  // ------------------------------------------------------------------
  // Single command via daemon. Auto-start if needed.
  // ------------------------------------------------------------------
  if (!(await DaemonClient.isRunning())) {
    const ok = await autoStartDaemon(parsed.flags);
    if (!ok) {
      process.stderr.write('error: could not start daemon\ncode:  DRIVER_ERROR\nhint:  try `craftdriver daemon start` to see launch errors\n');
      return 1;
    }
  }

  const client = new DaemonClient();
  try {
    const resp = await client.send(parsed.cmd, parsed.args);
    return emitResponse(parsed, resp);
  } catch (e) {
    process.stderr.write('error: ' + ((e as Error).message ?? String(e)) + '\ncode:  DRIVER_ERROR\n');
    return 1;
  }
}

function applyHeadless(flags: GlobalFlags): void {
  if (flags.headless === true) process.env.HEADLESS = 'true';
  else if (flags.headless === false) process.env.HEADLESS = 'false';
  // Default to headless on the agent surface — interactive agents rarely
  // want a window popping up, and tests expect HEADLESS=true.
  else if (process.env.HEADLESS === undefined) process.env.HEADLESS = 'true';
}

// ---------------------------------------------------------------------------
// Ephemeral mode
// ---------------------------------------------------------------------------
async function runEphemeral(parsed: ParsedCommand): Promise<number> {
  const handle = createBrowserHandle(() => Browser.launch(parsed.flags.launch));
  let rc = 0;
  try {
    if (parsed.cmd === '__stdin__') {
      const lines = await readAllStdin();
      for (const raw of lines.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const tokens = tokenize(line);
        const sub = parseArgv(tokens);
        if (!sub || sub.cmd.startsWith('__')) continue;
        const result = await safeDispatch(handle, sub);
        rc = emitInProc(sub, result) || rc;
      }
    } else {
      const result = await safeDispatch(handle, parsed);
      rc = emitInProc(parsed, result);
    }
  } finally {
    await handle.close();
  }
  return rc;
}

interface DispatchOutcome {
  ok: boolean;
  value?: unknown;
  error?: ReturnType<typeof toWireError>;
}

async function safeDispatch(
  handle: ReturnType<typeof createBrowserHandle>,
  parsed: ParsedCommand,
): Promise<DispatchOutcome> {
  try {
    const value = await dispatch(
      { handle, launchOptions: parsed.flags.launch },
      parsed.cmd,
      parsed.args,
    );
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: toWireError(e) };
  }
}

function emitInProc(parsed: ParsedCommand, outcome: DispatchOutcome): number {
  if (outcome.ok) {
    writeOk(parsed, outcome.value);
    return 0;
  }
  writeErr(outcome.error!);
  return exitCodeFor(outcome.error!.code);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function runInitCommand(parsed: ParsedCommand): number {
  const flavor = String(parsed.args.flavor ?? '').toLowerCase();
  const allowed = new Set<string>([...SUPPORTED_FLAVORS, 'all']);
  if (!allowed.has(flavor)) {
    const list = [...SUPPORTED_FLAVORS, 'all'].join(' | ');
    process.stderr.write(
      `error: init requires a flavor (${list})\n` +
      `code:  INVALID_ARGUMENT\n` +
      `hint:  example: craftdriver init copilot\n`,
    );
    return 2;
  }
  const force = parsed.args.force === true;
  const dryRun = parsed.args['dry-run'] === true || parsed.args.dryRun === true;
  const result = runInit({ flavor: flavor as Flavor, cwd: process.cwd(), force, dryRun });
  const prefix = dryRun ? '[dry-run] ' : '';
  for (const p of result.written) process.stdout.write(`${prefix}wrote ${p}\n`);
  for (const p of result.skipped) {
    process.stdout.write(`skipped ${p} (already exists; use --force to overwrite)\n`);
  }
  if (result.written.length === 0 && result.skipped.length > 0) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Daemon control
// ---------------------------------------------------------------------------
async function daemonStart(flags: GlobalFlags): Promise<number> {
  if (await DaemonClient.isRunning()) {
    const pid = DaemonClient.getPid();
    process.stdout.write(`daemon already running (pid ${pid ?? '?'})\n`);
    return 0;
  }
  const ok = await autoStartDaemon(flags);
  if (!ok) {
    process.stderr.write('error: failed to start daemon\n');
    return 1;
  }
  const pid = DaemonClient.getPid();
  process.stdout.write(`daemon started (pid ${pid ?? '?'}) on ${DAEMON_SOCKET_PATH}\n`);
  return 0;
}

async function daemonStop(parsed: ParsedCommand): Promise<number> {
  if (!(await DaemonClient.isRunning())) {
    process.stdout.write('daemon not running\n');
    return 0;
  }
  const client = new DaemonClient();
  try {
    await client.send('daemon:stop');
  } catch {
    // expected — the daemon may close before flushing.
  }
  // Wait briefly for socket/PID cleanup.
  for (let i = 0; i < 20; i++) {
    if (!(await DaemonClient.isRunning())) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  process.stdout.write('daemon stopped\n');
  return 0;
}

async function daemonStatus(parsed: ParsedCommand): Promise<number> {
  const running = await DaemonClient.isRunning();
  const pid = DaemonClient.getPid();
  if (!running) {
    const result = { running: false, pid: null, socket: DAEMON_SOCKET_PATH };
    writeOk(parsed, result);
    return 0;
  }
  let info: Record<string, unknown> = { running: true, pid, socket: DAEMON_SOCKET_PATH };
  try {
    const client = new DaemonClient();
    const resp = await client.send('status');
    if (resp.ok) info = { ...info, ...(resp.result as Record<string, unknown>) };
  } catch { /* ignore */ }
  writeOk(parsed, info);
  return 0;
}

async function daemonRun(flags: GlobalFlags): Promise<number> {
  // Block here forever; runDaemon never resolves on success (it exits on signal).
  await runDaemon({ launch: flags.launch });
  return 0;
}

async function autoStartDaemon(flags: GlobalFlags): Promise<boolean> {
  const self = process.argv[1] ?? fileURLToPath(import.meta.url);
  const args = ['daemon', '__run__'];
  if (flags.launch.browserName) { args.push('--browser', flags.launch.browserName); }
  if (flags.headless === true) args.push('--headless');
  if (flags.headless === false) args.push('--headed');
  const child = spawn(process.execPath, [self, ...args], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HEADLESS: process.env.HEADLESS ?? 'true' },
  });
  child.unref();
  // Wait up to 10s for the socket to appear.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await DaemonClient.isRunning()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------
function shouldJson(parsed: ParsedCommand): boolean {
  if (parsed.flags.json) return true;
  if (parsed.flags.pretty) return false;
  return !process.stdout.isTTY;
}

function writeOk(parsed: ParsedCommand, result: unknown): void {
  if (shouldJson(parsed)) {
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
    return;
  }
  // Pretty mode: small dispatcher-aware formatting for the most common cases.
  process.stdout.write(prettyResult(parsed.cmd, result) + '\n');
}

function writeErr(err: { code: string; message: string; hint?: string; detail?: Record<string, unknown> }): void {
  // Strip the chromedriver/geckodriver stack-trace dump that comes through
  // on transport errors. Agents read `code` and the first line of `message`;
  // the rest is noise.
  const cleanMessage = err.message.split('\n')[0].split('stacktrace')[0].trim();
  if (process.stdout.isTTY) {
    process.stderr.write(`error: ${cleanMessage}\ncode:  ${err.code}\n`);
    if (err.hint) process.stderr.write(`hint:  ${err.hint}\n`);
    return;
  }
  process.stdout.write(JSON.stringify({ ok: false, error: { ...err, message: cleanMessage } }) + '\n');
}

function emitResponse(parsed: ParsedCommand, resp: { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; hint?: string; detail?: Record<string, unknown> } }): number {
  if (resp.ok) {
    writeOk(parsed, resp.result);
    // `exists` is a probe: exit 1 when nothing matched, even though
    // the call itself succeeded. Agents script around the exit code.
    if (parsed.cmd === 'exists') {
      const r = resp.result as { exists?: boolean };
      if (r && r.exists === false) return 1;
    }
    return 0;
  }
  writeErr(resp.error);
  return exitCodeFor(resp.error.code);
}

function exitCodeFor(code: string): number {
  if (code === ErrorCode.INVALID_ARGUMENT) return 2;
  return 1;
}

function prettyResult(cmd: string, result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  const r = result as Record<string, unknown>;

  if (cmd === 'find' && Array.isArray(r.matches)) {
    const lines = (r.matches as Array<Record<string, unknown>>).map((m, i) => {
      const idx = (m.index as number | undefined) ?? i;
      const tag = m.tag ?? '';
      const text = m.text ?? '';
      const vis = m.visible ? '' : ' (hidden)';
      return `[${idx}] <${tag}>${vis}  "${text}"`;
    });
    const header = `count=${r.count}${r.truncated ? ' (truncated)' : ''}`;
    const trailer = r.truncated && r.total !== undefined && r.next_offset !== undefined && r.next_offset !== null
      ? `\n... ${r.total} total; resume with --offset ${r.next_offset}`
      : '';
    return [header, ...lines].join('\n') + trailer;
  }
  if (cmd === 'pages' && Array.isArray(r.pages)) {
    return (r.pages as Array<Record<string, unknown>>)
      .map((p, i) => `[${i}] ${p.url ?? ''}  —  ${p.title ?? ''}`)
      .join('\n');
  }
  if (cmd === 'snapshot' && Array.isArray(r.lines)) {
    const header = `page: ${(r.title as string) || '(untitled)'} — ${(r.url as string) || '(no url)'}`;
    const lines = r.lines as string[];
    if (lines.length === 0) return `${header}\n(no interactive elements detected)`;
    return `${header}\n${lines.join('\n')}`;
  }
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tokenize(line: string): string[] {
  // Minimal shell-like tokeniser: supports single/double quotes.
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ' ' || ch === '\t') { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

async function readAllStdin(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
  });
}

// Handle the internal "daemon __run__" invocation used by autoStartDaemon.
// Map sub-token "__run__" → "run" so parseArgv produces `daemon:run`.
if (process.argv[3] === '__run__') process.argv[3] = 'run';
