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
import os from 'os';
import path from 'path';

export const AGENT_DEFAULT_TIMEOUT_MS = (() => {
  const raw = process.env.CRAFTDRIVER_AGENT_TIMEOUT;
  if (raw === undefined || raw === '') return 5_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5_000;
})();

/** Default `--limit` for list-returning commands. */
export const AGENT_DEFAULT_LIMIT = 20;

/** Path to the daemon's Unix socket. */
export const DAEMON_SOCKET_PATH = (() => {
  const override = process.env.CRAFTDRIVER_SOCKET;
  if (override) return override;
  return path.join(os.homedir(), '.craftdriver', 'sock');
})();

/** PID file written by the daemon so `daemon status/stop` can find it. */
export const DAEMON_PID_PATH = (() => {
  const override = process.env.CRAFTDRIVER_PID;
  if (override) return override;
  return path.join(os.homedir(), '.craftdriver', 'pid');
})();

/** Idle browser shutdown delay (ms) when daemon receives no requests. */
export const DAEMON_IDLE_SHUTDOWN_MS = 0; // 0 = never auto-shutdown
