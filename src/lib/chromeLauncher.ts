/**
 * Launch Chrome directly, without chromedriver, and expose its DevTools
 * endpoint. Used by the hybrid launch path, where craftdriver owns the
 * browser process: chromedriver attaches to it for Classic, and the
 * in-process chromium-bidi mapper speaks CDP to it for BiDi.
 *
 * The flags are chromedriver's own, so both launch paths boot the same
 * browser.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CraftdriverError, ErrorCode } from './errors.js';
import { CHROME_DEVTOOLS_READY_TIMEOUT_MS } from './timing.js';

/**
 * The switches chromedriver passes to Chrome, from chromedriver 156's
 * `--verbose` "Launching chrome:" line (macOS). `--user-data-dir`,
 * `--headless=new` and the `data:,` start URL are added per launch.
 */
export const CHROMEDRIVER_DEFAULT_SWITCHES: readonly string[] = [
  '--allow-pre-commit-input',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-client-side-phishing-detection',
  '--disable-default-apps',
  '--disable-features=IgnoreDuplicateNavs,Prewarm',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--enable-automation',
  '--enable-logging',
  '--log-level=0',
  '--no-first-run',
  '--no-service-autorun',
  '--password-store=basic',
  '--remote-debugging-port=0',
  '--test-type=webdriver',
  '--use-mock-keychain',
];

const OUTPUT_TAIL_BYTES = 32 * 1024;
const DEVTOOLS_URL = /DevTools listening on (ws:\/\/\S+)/;

export interface ChromeLaunchOptions {
  /** Chrome executable (absolute path or a command on PATH). */
  binary: string;
  headless: boolean;
  /** Extra switches, appended after the defaults (so they win on conflicts). */
  args?: string[];
  /** Profile prefs, written to `Default/Preferences` the way chromedriver writes them. */
  prefs?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface LaunchedChrome {
  /** Browser-level CDP WebSocket URL. */
  readonly wsUrl: string;
  /** `host:port` for `goog:chromeOptions.debuggerAddress`. */
  readonly debuggerAddress: string;
  readonly pid: number | undefined;
  /** The temp profile this launch created (removed on close); undefined for a caller-supplied one. */
  readonly userDataDir: string | undefined;
  /** Bounded tail of Chrome's stderr, for error diagnostics. */
  getOutputTail(): string;
  /** Kill Chrome and remove the temp profile. Idempotent. */
  close(): Promise<void>;
}

/** Build Chrome's command line. User args come last so they override defaults. */
export function buildChromeArgs(opts: {
  headless: boolean;
  userDataDir?: string;
  args?: string[];
}): string[] {
  return [
    ...CHROMEDRIVER_DEFAULT_SWITCHES,
    ...(opts.headless ? ['--headless=new'] : []),
    ...(opts.userDataDir ? [`--user-data-dir=${opts.userDataDir}`] : []),
    ...(opts.args ?? []),
    'data:,',
  ];
}

/**
 * Expand chromedriver-style dotted pref keys into the nested JSON Chrome
 * stores: `{ 'download.default_directory': d }` → `{ download: { default_directory: d } }`.
 */
export function expandPrefs(prefs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(prefs)) {
    const parts = key.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

/** The `--user-data-dir` value in `args`, if the caller supplied their own profile. */
export function userDataDirFromArgs(args: readonly string[] = []): string | undefined {
  for (const arg of args) {
    const m = /^--user-data-dir=(.+)$/.exec(arg);
    if (m) return m[1];
  }
  return undefined;
}

// Chrome processes still running in this Node process. If Node exits without
// closing them (a test runner tearing down a worker, an uncaught error), the
// 'exit' hook kills them synchronously rather than leaving orphans.
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function killNow(proc: ChildProcess): void {
  try {
    proc.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
  } catch {
    // already gone
  }
}

function trackForExit(proc: ChildProcess): void {
  live.add(proc);
  proc.once('exit', () => live.delete(proc));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const p of live) killNow(p);
    });
  }
}

export async function launchChrome(opts: ChromeLaunchOptions): Promise<LaunchedChrome> {
  const ownUserDataDir = userDataDirFromArgs(opts.args) === undefined;
  const userDataDir = ownUserDataDir
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'craftdriver-chrome-'))
    : undefined;
  if (userDataDir && opts.prefs && Object.keys(opts.prefs).length) {
    fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, 'Default', 'Preferences'),
      JSON.stringify(expandPrefs(opts.prefs))
    );
  }

  const removeProfile = () => {
    if (userDataDir) {
      // Helper processes can keep writing into the profile for a moment after
      // the browser process exits.
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  };

  let proc: ChildProcess;
  try {
    proc = spawn(opts.binary, buildChromeArgs({ ...opts, userDataDir }), {
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    removeProfile();
    throw err;
  }
  trackForExit(proc);

  let tail = '';
  // A spawn failure (ENOENT) emits 'error' and never 'exit'.
  const exited = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.once('error', () => resolve());
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (proc.exitCode === null && proc.signalCode === null) {
      killNow(proc);
      await exited;
    }
    removeProfile();
  };

  const timeoutMs = opts.timeoutMs ?? CHROME_DEVTOOLS_READY_TIMEOUT_MS;
  let wsUrl: string;
  try {
    wsUrl = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (err: Error | null, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(url!);
      };
      const timer = setTimeout(
        () => finish(new Error(`Chrome did not print its DevTools URL within ${timeoutMs}ms`)),
        timeoutMs
      );
      proc.stderr!.setEncoding('utf8');
      // Keep draining after the match: Chrome logs to stderr and would block
      // on a full pipe.
      proc.stderr!.on('data', (chunk: string) => {
        tail = (tail + chunk).slice(-OUTPUT_TAIL_BYTES);
        const m = settled ? null : DEVTOOLS_URL.exec(tail);
        if (m) finish(null, m[1]);
      });
      proc.once('error', (err) => finish(err));
      proc.once('exit', (code, signal) =>
        finish(
          new Error(
            `Chrome exited (${signal ? `signal ${signal}` : `code ${code}`}) before DevTools was ready`
          )
        )
      );
    });
  } catch (err) {
    await close();
    const message = err instanceof Error ? err.message : String(err);
    throw new CraftdriverError(
      ErrorCode.DRIVER_ERROR,
      `Failed to launch Chrome (${opts.binary}): ${message}` +
        (tail.trim() ? `\nChrome output (tail):\n${tail.trim()}` : ''),
      { detail: { binary: opts.binary }, cause: err }
    );
  }

  const { host } = new URL(wsUrl);
  return {
    wsUrl,
    debuggerAddress: host,
    pid: proc.pid,
    userDataDir,
    getOutputTail: () => tail,
    close,
  };
}
