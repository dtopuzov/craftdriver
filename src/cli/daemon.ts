/**
 * Daemon process: long-lived browser exposed over a Unix domain socket.
 *
 * - One daemon per project: it listens on a socket under
 *   `~/.craftdriver/projects/<project>-<hash>/` keyed by the project root
 *   (override with `$CRAFTDRIVER_SOCKET`). A user-global socket meant a
 *   daemon started in one project answered commands from another, sharing
 *   its browser, cookies and refs.
 * - Line-delimited JSON request/response, one connection per CLI call.
 * - Lazy browser launch: the first request that needs a browser starts
 *   one. Subsequent requests reuse it.
 * - Writes its PID beside the socket so `daemon status/stop` can find it.
 *   PID file is cleaned up on graceful exit.
 *
 * Run as a child process via `craftdriver daemon start`.
 */
import net from 'net';
import fs from 'fs';
import path from 'path';
import { Browser } from '../lib/browser.js';
import type { LaunchOptions } from '../lib/browser.js';
import { assertLocalOnlyLaunch } from '../lib/launchTarget.js';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import { DAEMON_SOCKET_PATH, DAEMON_PID_PATH } from './defaults.js';
import { AgentSession } from './agentSession.js';
import type { AgentDetailedResult } from './agentSession.js';
import {
  createSessionRegistry,
  validateSessionName,
  MAX_SESSIONS,
  type SessionRegistry,
} from './sessionRegistry.js';
import { BoundedLineReader, MAX_FRAME_BYTES } from './lineReader.js';
import { toWireError } from './wireError.js';
import { validateBatchObserve, validateBatchSteps } from './batch.js';
import type { Request, Response } from './protocol.js';

// Re-exported because every transport reports failures through it, and the
// daemon is where callers have always imported it from.
export { toWireError } from './wireError.js';

interface DaemonOptions {
  socketPath?: string;
  pidPath?: string;
  launch: LaunchOptions;
}

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  // The daemon is a local dev tool only — never reachable against a
  // Grid/cloud. Fail fast at startup, not on first browser use.
  assertLocalOnlyLaunch(opts.launch as unknown as Record<string, unknown>);

  const socketPath = opts.socketPath ?? DAEMON_SOCKET_PATH;
  const pidPath = opts.pidPath ?? DAEMON_PID_PATH;

  await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(pidPath), { recursive: true });
  // If a stale socket exists from a crashed previous daemon, remove it.
  try {
    await fs.promises.unlink(socketPath);
  } catch {
    /* ignore */
  }

  // One browser per named session, created on first use. As with the
  // ephemeral CLI: the wire response carries only the command result, so an
  // automatic post-action snapshot would be pure cost.
  const registry = createSessionRegistry({
    create: (name) =>
      new AgentSession({
        launchOptions: opts.launch,
        launch: () => Browser.launch(opts.launch),
        autoSnapshot: false,
        artifactName: name,
      }),
  });

  const server = net.createServer((sock) => {
    // Bounded like the MCP transport: this process is long-lived, so a peer
    // that writes without a newline would grow the buffer until the daemon
    // dies, with no process exit to reclaim it.
    const reader = new BoundedLineReader();
    sock.on('data', async (chunk) => {
      for (const event of reader.push(chunk)) {
        if (event.kind === 'oversized') {
          writeResp(sock, {
            id: -1,
            ok: false,
            error: {
              code: ErrorCode.INVALID_ARGUMENT,
              message: `request frame exceeds ${MAX_FRAME_BYTES}-byte limit`,
            },
          });
          continue;
        }
        const line = event.line;
        if (!line.trim()) continue;
        let req: Request;
        try {
          req = JSON.parse(line) as Request;
        } catch (e) {
          writeResp(sock, {
            id: -1,
            ok: false,
            error: {
              code: ErrorCode.INVALID_ARGUMENT,
              message: 'invalid JSON request: ' + (e as Error).message,
            },
          });
          continue;
        }
        const response = await handleDaemonRequest(registry, req, () => void shutdown(0));
        writeResp(sock, response);
      }
    });
    sock.on('error', () => {
      /* swallow per-client errors */
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        /* not fatal */
      }
      resolve();
    });
  });

  await fs.promises.writeFile(pidPath, String(process.pid), 'utf8');

  let shuttingDown = false;
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // Remove both files before anything that can block or yield.
    //
    // `daemon stop` reports success once the socket stops answering, and Node
    // unlinks a Unix socket path during `server.close()`. Cleaning up after
    // `registry.closeAll()` — which waits for every browser to quit — left a
    // window, seconds wide, where stop had already returned "daemon stopped"
    // and the PID file was still on disk. A later `daemon status` then
    // reported a PID owning nothing.
    try {
      fs.unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
    try {
      server.close();
    } catch {
      /* ignore */
    }
    await registry.closeAll();
    try {
      await fs.promises.unlink(socketPath);
    } catch {
      /* ignore */
    }
    process.exit(code);
  }

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('uncaughtException', (e) => {
    process.stderr.write('daemon uncaughtException: ' + ((e as Error)?.stack ?? String(e)) + '\n');
    void shutdown(1);
  });

  // Block the caller forever; the daemon shuts down via signal or
  // `daemon:stop`, both of which call `process.exit()` directly.
  await new Promise<void>(() => {
    /* never resolves */
  });
}

export async function handleDaemonRequest(
  registry: SessionRegistry,
  req: Request,
  onStop?: () => void
): Promise<Response> {
  // Daemon- and registry-level commands answer without touching a session.
  // `session:close` in particular must not be routed *through* the session it
  // is about, which would queue the close behind that session's own work.
  if (req.cmd === 'daemon:ping') {
    return { id: req.id, ok: true, result: { pong: true, pid: process.pid } };
  }
  if (req.cmd === 'daemon:stop') {
    if (onStop) setImmediate(onStop);
    return { id: req.id, ok: true, result: { stopping: true, pid: process.pid } };
  }
  if (req.cmd === 'session:list') {
    const sessions = registry.list();
    return {
      id: req.id,
      ok: true,
      result: { sessions, count: sessions.length, limit: MAX_SESSIONS },
    };
  }

  try {
    if (req.cmd === 'session:close') {
      // `target` when named explicitly, otherwise whichever session the
      // caller addressed — `craftdriver session close --session checkout`.
      const name = validateSessionName((req.args?.target as unknown) ?? req.session);
      const closed = await registry.close(name);
      return { id: req.id, ok: true, result: { closed, name } };
    }

    if (req.cmd === 'batch') {
      // Validated here as well as on the CLI side, for the same reason the
      // session name is: a socket peer is not necessarily the CLI.
      //
      // This checks the *shape* — step count, argument types, command names
      // that must never run in a batch — not that every name is a command the
      // dispatcher implements. A raw peer that sends an unknown one therefore
      // finds out at that step rather than before the first, which the two
      // real clients never hit: the CLI compiles its script up front, and the
      // MCP server resolves every step against the tool registry.
      const steps = validateBatchSteps(req.args?.steps);
      const observe = validateBatchObserve(req.args?.observe);
      const session = registry.get(validateSessionName(req.session));
      const outcome = await session.runBatch({
        steps,
        continueOnError: req.args?.continueOnError === true,
        // Opt-in, and the CLI is what opts in: it has exit statuses, so a
        // command that answered no is a step that failed there. A peer that
        // does not ask keeps the plain reading, which is what MCP wants.
        stopOnVerdict: req.args?.stopOnVerdict === true,
        ...(observe ? { observe } : {}),
      });
      return { id: req.id, ok: true, result: outcome };
    }

    // Untrusted: the CLI validates before opening a socket, but a socket peer
    // is not necessarily the CLI. Validation precedes session creation.
    const { observe, ...args } = req.args ?? {};
    if (observe !== undefined && observe !== 'page' && observe !== 'delta') {
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `--observe must be "page" or "delta", got ${JSON.stringify(observe)}`
      );
    }
    const session = registry.get(validateSessionName(req.session));
    const observation: 'page' | 'delta' | undefined =
      observe === 'page' || observe === 'delta' ? observe : undefined;
    const command = {
      cmd: req.cmd,
      args,
      ...(observation ? { observe: observation } : {}),
    };
    const detailed = await session.runDetailed(command);
    const result = renderObservedResult(detailed, observe);
    return { id: req.id, ok: true, result };
  } catch (err) {
    return { id: req.id, ok: false, error: toWireError(err) };
  }
}

/** Add requested observation without changing the normal compact CLI result. */
export function renderObservedResult(detailed: AgentDetailedResult, observe: unknown): unknown {
  if (observe !== 'page' && observe !== 'delta') return detailed.value;
  // Every observable browser action currently returns an object. Keep the
  // wrapper robust for future commands instead of silently dropping its value.
  const value = detailed.value;
  const result: Record<string, unknown> =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : { result: value };
  if (observe === 'page' && detailed.page) result.page = detailed.page;
  else if (observe === 'page' && detailed.delta) result.warning = detailed.delta;
  if (observe === 'delta' && detailed.delta) result.delta = detailed.delta;
  // Flat rather than nested, and on both observation kinds: this is a
  // tripwire, and an agent should not have to know where to look for it. An
  // action that changed no a11y node can still have made the page throw.
  if (detailed.logs) {
    result.errors = detailed.logs.errors;
    result.logCursor = detailed.logs.logCursor;
    if (detailed.logs.logsDropped !== undefined) result.logsDropped = detailed.logs.logsDropped;
    // Both qualifiers are only ever present as `false`, and both qualify a
    // number beside them: an unconfirmed zero must not read like a confirmed
    // one, and an upper bound must not read like a count.
    if (detailed.logs.logsDroppedExact === false) result.logsDroppedExact = false;
    if (detailed.logs.logsSettled === false) result.logsSettled = false;
  }
  return result;
}

function writeResp(sock: net.Socket, resp: Response): void {
  try {
    const frame = JSON.stringify(resp);
    // Results are bounded where they are produced, so an oversized frame here
    // means a bug rather than a large-but-legitimate answer. Reporting it
    // beats writing a megabyte into a reader that has to buffer the whole
    // line before it can parse anything.
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) {
      const replacement: Response = {
        id: resp.id,
        ok: false,
        error: {
          code: ErrorCode.INVALID_ARGUMENT,
          message: `daemon: response exceeded ${MAX_FRAME_BYTES} bytes and was dropped`,
          hint: 'narrow the command (a selector, a smaller --limit) and retry',
        },
      };
      sock.write(JSON.stringify(replacement) + '\n');
      return;
    }
    sock.write(frame + '\n');
  } catch {
    /* socket may have closed; ignore */
  }
}
