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
import { readFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import { AgentSession, type AgentSessionRunner } from './agentSession.js';
import { parseArgv, HELP_TEXT, type ParsedCommand, type GlobalFlags } from './parseArgs.js';
import { DaemonClient } from './client.js';
import { runDaemon, toWireError } from './daemon.js';
import { DAEMON_SOCKET_PATH, DAEMON_PID_PATH, projectRoot } from './defaults.js';
import { MAX_STDIN_BYTES } from './bounds.js';
import { LEGACY_FLAVORS, runInit, SUPPORTED_FLAVORS, type Flavor } from './init.js';
import { runMcpServer } from './mcp/server.js';
import { validateSessionName } from './sessionRegistry.js';
import type { LaunchOptions } from '../lib/browser.js';

/**
 * Reported by `--version`, read from the installed package rather than a
 * constant. The hardcoded value had drifted to 0.1.0 against a 1.7.0 package,
 * so the CLI told every user the wrong version — the same defect the MCP
 * server carried in `serverInfo.version`.
 */
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * The daemon needs a Unix domain socket, which Windows does not provide —
 * there, Node maps a listen path onto a named pipe under `\\.\pipe\`, so the
 * socket path this CLI computes cannot be bound at all.
 *
 * Rather than surface the resulting ENOENT, the daemon is declared unsupported
 * on Windows and the two socket-free modes are named instead. Both genuinely
 * work there: `--ephemeral` owns one browser for the run, and `mcp` speaks
 * over stdio.
 */
function daemonSupported(): boolean {
  return process.platform !== 'win32';
}

function unsupportedDaemon(): number {
  process.stderr.write(
    'error: the craftdriver daemon is not supported on Windows\n' +
    `code:  ${ErrorCode.UNSUPPORTED}\n` +
    'hint:  use `craftdriver --ephemeral < script.txt` for a one-shot run, ' +
    'or `craftdriver mcp` for an agent session; both avoid the socket\n',
  );
  // UNSUPPORTED is an operational/platform limitation, not malformed CLI
  // syntax. Keep it aligned with the normal error-code-to-exit-code mapping.
  return 1;
}

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
  const parseFailure = formatParseFailure(parsed);
  if (parseFailure) {
    process.stderr.write(parseFailure);
    return 2;
  }

  // Validate the session name here, before anything opens a socket, spawns a
  // daemon or touches the filesystem: a bad name must not be able to start a
  // browser it will then be refused by.
  let session: string;
  try {
    session = validateSessionName(parsed.flags.session);
  } catch (e) {
    writeErr(toWireError(e));
    return 2;
  }
  const rc = checkSessionUsage(parsed);
  if (rc !== 0) return rc;

  applyHeadless(parsed.flags);

  // ------------------------------------------------------------------
  // `init codex` — no browser, no daemon. Installs the project skill.
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
  if (parsed.cmd.startsWith('daemon:') && !daemonSupported()) return unsupportedDaemon();
  if (parsed.cmd === 'daemon:start') return daemonStart(parsed.flags);
  if (parsed.cmd === 'daemon:stop') return daemonStop(parsed);
  if (parsed.cmd === 'daemon:status') return daemonStatus(parsed, session);
  if (parsed.cmd === 'daemon:run') return daemonRun(parsed.flags); // internal: actual daemon process

  // ------------------------------------------------------------------
  // Ephemeral mode — no daemon involved.
  // ------------------------------------------------------------------
  if (parsed.flags.ephemeral) return runEphemeral(parsed);

  // ------------------------------------------------------------------
  // Single command via daemon. Auto-start if needed.
  // ------------------------------------------------------------------
  if (!daemonSupported()) return unsupportedDaemon();
  if (!(await DaemonClient.isRunning())) {
    const ok = await autoStartDaemon(parsed.flags);
    if (!ok) {
      process.stderr.write('error: could not start daemon\ncode:  DRIVER_ERROR\nhint:  try `craftdriver daemon start` to see launch errors\n');
      return 1;
    }
  }

  const client = new DaemonClient({ session });
  try {
    const resp = await client.send(parsed.cmd, parsed.args);
    return emitResponse(parsed, resp);
  } catch (e) {
    process.stderr.write('error: ' + ((e as Error).message ?? String(e)) + '\ncode:  DRIVER_ERROR\n');
    return 1;
  }
}

const SESSION_SUBCOMMANDS = new Set(['session:list', 'session:close']);

/** Render parser pseudo-commands consistently in one-shot and stdin modes. */
function formatParseFailure(parsed: ParsedCommand, line?: string): string | null {
  const context = line ? ` in: ${line}` : '';
  if (parsed.cmd === '__unknown__') {
    return `error: unknown command "${parsed.args.cmd as string}"${context}\nrun: craftdriver --help\n`;
  }
  if (parsed.cmd === '__unknown_flag__') {
    const flag = parsed.args.flag as string;
    const suggestion = parsed.args.suggestion as string | undefined;
    return (
      `error: unknown flag "${flag}"${context}\n` +
      (suggestion ? `did you mean: ${suggestion}\n` : '') +
      'run: craftdriver --help\n'
    );
  }
  if (parsed.cmd === '__usage_error__') {
    const usage = parsed.args.usage as string | undefined;
    return (
      `error: ${parsed.args.message as string}${context}\n` +
      (usage ? `usage: ${usage}\n` : '') +
      'run: craftdriver --help\n'
    );
  }
  return null;
}

/**
 * Reject session usage the daemon cannot honour, before it is attempted.
 *
 * Ephemeral mode is one process, one browser, one session: it exits when the
 * command does, so a name cannot address anything on the next invocation.
 * Accepting `--session` there would promise continuity that does not exist,
 * so it fails instead of quietly meaning nothing.
 */
function checkSessionUsage(parsed: ParsedCommand): number {
  if (parsed.cmd.startsWith('session:') && !SESSION_SUBCOMMANDS.has(parsed.cmd)) {
    process.stderr.write(
      `error: unknown session subcommand "${parsed.cmd.slice('session:'.length)}"\n` +
        'code:  INVALID_ARGUMENT\n' +
        'hint:  craftdriver session list | session close <name>\n',
    );
    return 2;
  }
  if (!parsed.flags.ephemeral) return 0;
  if (parsed.flags.session !== undefined) {
    process.stderr.write(
      'error: --session cannot be combined with --ephemeral\n' +
        'code:  INVALID_ARGUMENT\n' +
        'hint:  an ephemeral run owns exactly one browser and exits with it; ' +
        'use the daemon for named sessions\n',
    );
    return 2;
  }
  if (SESSION_SUBCOMMANDS.has(parsed.cmd)) {
    process.stderr.write(
      `error: "${parsed.cmd.replace(':', ' ')}" needs the daemon and is not available with --ephemeral\n` +
        'code:  INVALID_ARGUMENT\n',
    );
    return 2;
  }
  return 0;
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
  // No automatic snapshots: this path renders only the command's own
  // result, so capturing one would cost several extra round-trips per
  // command — and stamp ref markers into the page — for output nothing
  // reads. Explicit `snapshot` still records the baseline refs need.
  const session = new AgentSession({
    launchOptions: parsed.flags.launch,
    autoSnapshot: false,
    artifactName: 'ephemeral',
  });
  let rc = 0;
  try {
    if (parsed.cmd === '__stdin__') {
      // Reading stdin can fail on the size cap. Report it the way every other
      // CLI failure is reported rather than letting the rejection escape as an
      // unhandled stack trace from the bin shim's top-level await.
      let lines: string;
      try {
        lines = await readAllStdin();
      } catch (e) {
        writeErr(toWireError(e));
        return 2;
      }
      for (const raw of lines.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const tokens = tokenize(line);
        const sub = parseArgv(tokens);
        if (!sub) continue;
        // A malformed line must not pass silently. Skipping every `__…`
        // pseudo-command meant `click #pay --forse` did nothing at all and the
        // script still exited 0 — the same silent-typo failure strict flag
        // parsing exists to prevent, just moved onto this path.
        const parseFailure = formatParseFailure(sub, line);
        if (parseFailure) {
          process.stderr.write(parseFailure);
          rc = Math.max(rc, 2);
          continue;
        }
        const ignoredLaunchFlag = ephemeralLineLaunchFlag(sub.flags);
        if (ignoredLaunchFlag) {
          process.stderr.write(
            `error: ${ignoredLaunchFlag} cannot be set inside an ephemeral script in: ${line}\n` +
              `hint: pass it on the outer \`craftdriver --ephemeral\` command\n`,
          );
          rc = Math.max(rc, 2);
          continue;
        }
        if (sub.cmd.startsWith('__')) continue;
        const result = await safeDispatch(session, sub);
        // Keep the worst status across the batch. `||` used to be safe when
        // success was always 0, but `exists` now returns 1 on a miss and
        // would overwrite a usage error (2) recorded earlier.
        rc = Math.max(rc, emitInProc(sub, result));
      }
    } else {
      const result = await safeDispatch(session, parsed);
      rc = emitInProc(parsed, result);
    }
  } finally {
    await session.close();
  }
  return rc;
}

/** Launch/session choices apply to the script's one browser, not one line. */
function ephemeralLineLaunchFlag(flags: GlobalFlags): string | null {
  if (flags.session !== undefined) return '--session';
  if (flags.ephemeral) return '--ephemeral';
  if (flags.headless === true) return '--headless';
  if (flags.headless === false) return '--headed';
  if (flags.launch.browserName !== undefined) return '--browser';
  return null;
}

interface DispatchOutcome {
  ok: boolean;
  value?: unknown;
  error?: ReturnType<typeof toWireError>;
}

async function safeDispatch(
  session: AgentSessionRunner,
  parsed: ParsedCommand,
): Promise<DispatchOutcome> {
  try {
    const value = await session.run({ cmd: parsed.cmd, args: parsed.args });
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: toWireError(e) };
  }
}

function emitInProc(parsed: ParsedCommand, outcome: DispatchOutcome): number {
  if (outcome.ok) {
    writeOk(parsed, outcome.value);
    return successExitCode(parsed, outcome.value);
  }
  writeErr(outcome.error!);
  return exitCodeFor(outcome.error!.code);
}

/**
 * Exit code for a command that succeeded.
 *
 * `exists` is a probe: the call succeeds, but "nothing matched" has to
 * reach the shell as a non-zero status because agents script around it.
 * Shared by the ephemeral and daemon paths so one command cannot report
 * two different contracts depending on how it was run.
 */
function successExitCode(parsed: ParsedCommand, result: unknown): number {
  if (parsed.cmd !== 'exists') return 0;
  const r = result as { exists?: boolean } | null;
  return r && r.exists === false ? 1 : 0;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function runInitCommand(parsed: ParsedCommand): number {
  const flavor = String(parsed.args.flavor ?? '').toLowerCase();
  const allowed = new Set<string>([...SUPPORTED_FLAVORS, ...LEGACY_FLAVORS]);
  if (!allowed.has(flavor)) {
    process.stderr.write(
      'error: init requires the codex flavor\n' +
      `code:  INVALID_ARGUMENT\n` +
      `hint:  run: craftdriver init codex\n`,
    );
    return 2;
  }
  const force = parsed.args.force === true;
  const dryRun = parsed.args['dry-run'] === true || parsed.args.dryRun === true;
  const mcp = parsed.args.mcp === true;
  try {
    const result = runInit({ flavor: flavor as Flavor, cwd: process.cwd(), force, dryRun, mcp });
    process.stdout.write(`project root: ${result.projectRoot}\n`);
    if (result.status === 'installed') process.stdout.write(`installed ${result.destination}\n`);
    else if (result.status === 'updated') process.stdout.write(`updated ${result.destination}\n`);
    else if (result.status === 'unchanged') process.stdout.write(`unchanged ${result.destination}\n`);
    else if (result.status === 'would-install') {
      process.stdout.write(`[dry-run] would install ${result.destination}\n`);
    } else {
      process.stdout.write(`[dry-run] would update ${result.destination}\n`);
    }
    if (result.mcpSnippet) {
      process.stdout.write(
        '\nAdd this project-pinned MCP configuration manually; no config file was read or changed:\n\n' +
          result.mcpSnippet +
          '\n',
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `error: ${(error as Error).message ?? String(error)}\n` +
        `code:  INVALID_ARGUMENT\n`,
    );
    return 2;
  }
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
    // A PID file with no daemon behind it is stale by definition — the daemon
    // writes both files and removes both on a graceful exit, so this is the
    // residue of one that was killed or crashed. Leaving it means the next
    // `daemon status` reports a PID that owns nothing, and "shutdown leaves no
    // stale state" quietly stops being true.
    try {
      unlinkSync(DAEMON_PID_PATH);
    } catch {
      /* nothing to clean up */
    }
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

async function daemonStatus(parsed: ParsedCommand, session: string): Promise<number> {
  const running = await DaemonClient.isRunning();
  const pid = DaemonClient.getPid();
  // The daemon serves one project. Reporting which one makes an unexpected
  // "not running" self-explanatory when the command was run from elsewhere.
  const project = projectRoot();
  if (!running) {
    const result = { running: false, pid: null, socket: DAEMON_SOCKET_PATH, project };
    writeOk(parsed, result);
    return 0;
  }
  let info: Record<string, unknown> = {
    running: true, pid, socket: DAEMON_SOCKET_PATH, project, session,
  };
  try {
    const client = new DaemonClient({ session });
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
    return successExitCode(parsed, resp.result);
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
  if (cmd === 'locators' && Array.isArray(r.candidates)) {
    const rows = (r.candidates as Array<Record<string, unknown>>).map((c) => {
      const mark = c.status === 'unique' ? '✓' : c.status === 'ambiguous' ? '~' : '✗';
      const count = c.status === 'unique' ? '' : `  (${c.matches} matches)`;
      return `${mark} ${c.selector}${count}\n    ${c.code}`;
    });
    const head = r.best
      ? `best: ${r.best as string}`
      : `no unique locator — ${(r.note as string) ?? 'add a data-testid'}`;
    return [head, ...rows].join('\n');
  }
  if (cmd === 'session:list' && Array.isArray(r.sessions)) {
    const head = `${r.count} of ${r.limit} sessions open`;
    const rows = (r.sessions as Array<Record<string, unknown>>)
      .map((s) => `  ${s.name as string}  (since ${s.createdAt as string})`);
    return rows.length === 0 ? head : [head, ...rows].join('\n');
  }
  if (cmd === 'state' && Array.isArray(r.states)) {
    const names = r.states as string[];
    const head = `state root: ${r.root as string}`;
    return names.length === 0
      ? `${head}\n(no saved state — create one with \`craftdriver state save <name>\`)`
      : [head, ...names.map((n) => `  ${n}`)].join('\n');
  }
  if (cmd === 'state' && typeof r.action === 'string') {
    // Counts and origins only — never the cookies or storage values.
    const origins = (r.origins as string[]) ?? [];
    const scope = origins.length > 0 ? ` for ${origins.join(', ')}` : '';
    const note = r.note ? `\nnote: ${r.note as string}` : '';
    return (
      `${r.action as string} ${r.name as string}: ` +
      `${r.cookies as number} cookies, ${r.storageKeys as number} storage keys${scope}${note}`
    );
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

/**
 * Read the whole ephemeral script from stdin, bounded.
 *
 * It is accumulated in memory before the first command runs, so an unbounded
 * pipe could exhaust the process before it did any work. The cap is far above
 * any real command script.
 */
async function readAllStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    let bytes = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      bytes += Buffer.byteLength(c, 'utf8');
      if (bytes > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new CraftdriverError(
          ErrorCode.INVALID_ARGUMENT,
          `stdin exceeded ${MAX_STDIN_BYTES} bytes`,
          { hint: 'split the script, or drive the daemon one command at a time' },
        ));
        return;
      }
      buf += c;
    });
    process.stdin.on('end', () => resolve(buf));
  });
}

// Handle the internal "daemon __run__" invocation used by autoStartDaemon.
// Map sub-token "__run__" → "run" so parseArgv produces `daemon:run`.
if (process.argv[3] === '__run__') process.argv[3] = 'run';
