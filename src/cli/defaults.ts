/**
 * Constants for the CLI / MCP agent surface.
 *
 * The **library** keeps its 30 s auto-wait — that's right for stable
 * tests written by humans. The **agent surface** (this CLI and the
 * future MCP server) lowers the default to 5 s because agents probe
 * with hallucinated selectors and should learn from failures fast.
 *
 * Override per call with `--timeout`, globally with the
 * `CRAFTDRIVER_AGENT_TIMEOUT` environment variable.
 *
 * Never import these constants from `src/lib/*`. The agent-surface
 * defaults must stay out of the library hot path.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Root of the project the CLI is being run against: the nearest ancestor
 * holding a `package.json` or `.git`, falling back to the working directory.
 *
 * Resolved through `realpath` so `/tmp` and `/private/tmp` — or any other
 * symlinked path — do not key two daemons for the same project.
 */
export function projectRoot(cwd: string = process.cwd()): string {
  let dir: string;
  try {
    dir = fs.realpathSync(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
  const start = dir;
  for (;;) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) ||
      fs.existsSync(path.join(dir, '.git'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * Per-project daemon directory.
 *
 * The socket used to be user-global, so a daemon started in project A served
 * project B: same browser, same cookies, same refs, and artifacts written
 * into whichever project happened to start it first. Keying the socket by
 * project root fixes that at the transport, and — unlike a session namespace
 * inside one shared daemon — it also stops project A's installed craftdriver
 * version from serving project B.
 *
 * The directory name carries the project's basename purely so `lsof` and
 * `ls ~/.craftdriver/projects` are readable; the hash is what disambiguates.
 */
export function daemonDir(root: string = projectRoot()): string {
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12);
  const label = path.basename(root).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
  return path.join(os.homedir(), '.craftdriver', 'projects', `${label}-${hash}`);
}

export const AGENT_DEFAULT_TIMEOUT_MS = (() => {
  const raw = process.env.CRAFTDRIVER_AGENT_TIMEOUT;
  if (raw === undefined || raw === '') return 5_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5_000;
})();

/** Default `--limit` for list-returning commands. */
export const AGENT_DEFAULT_LIMIT = 20;

export interface AgentViewport {
  width: number;
  height: number;
}

/** Desktop layout used by CLI/MCP sessions unless navigation overrides it. */
export const AGENT_DEFAULT_VIEWPORT: AgentViewport = { width: 1280, height: 800 };

/** Path to this project's daemon socket. */
export const DAEMON_SOCKET_PATH = (() => {
  const override = process.env.CRAFTDRIVER_SOCKET;
  if (override) return override;
  return path.join(daemonDir(), 'sock');
})();

/** PID file written by the daemon so `daemon status/stop` can find it. */
export const DAEMON_PID_PATH = (() => {
  const override = process.env.CRAFTDRIVER_PID;
  if (override) return override;
  return path.join(daemonDir(), 'pid');
})();
