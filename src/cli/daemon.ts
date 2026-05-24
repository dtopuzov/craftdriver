/**
 * Daemon process: long-lived browser exposed over a Unix domain socket.
 *
 * - Listens on `~/.craftdriver/sock` (override with `$CRAFTDRIVER_SOCKET`).
 * - Line-delimited JSON request/response, one connection per CLI call.
 * - Lazy browser launch: the first request that needs a browser starts
 *   one. Subsequent requests reuse it.
 * - Writes its PID to `~/.craftdriver/pid` so `daemon status/stop` can
 *   find it. PID file is cleaned up on graceful exit.
 *
 * Run as a child process via `craftdriver daemon start`.
 */
import net from 'net';
import fs from 'fs';
import path from 'path';
import { Browser } from '../lib/browser.js';
import type { LaunchOptions } from '../lib/browser.js';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import { DAEMON_SOCKET_PATH, DAEMON_PID_PATH } from './defaults.js';
import { createBrowserHandle, dispatch, type BrowserHandle } from './dispatcher.js';
import type { Request, Response } from './protocol.js';

interface DaemonOptions {
  socketPath?: string;
  pidPath?: string;
  launch: LaunchOptions;
}

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const socketPath = opts.socketPath ?? DAEMON_SOCKET_PATH;
  const pidPath = opts.pidPath ?? DAEMON_PID_PATH;

  await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(pidPath), { recursive: true });
  // If a stale socket exists from a crashed previous daemon, remove it.
  try { await fs.promises.unlink(socketPath); } catch { /* ignore */ }

  const handle: BrowserHandle = createBrowserHandle(() => Browser.launch(opts.launch));

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
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
        try {
          // Built-in daemon control commands handled here.
          if (req.cmd === 'daemon:ping') {
            writeResp(sock, { id: req.id, ok: true, result: { pong: true, pid: process.pid } });
            continue;
          }
          if (req.cmd === 'daemon:stop') {
            writeResp(sock, { id: req.id, ok: true, result: { stopping: true, pid: process.pid } });
            // Defer shutdown so the response flushes.
            setImmediate(() => void shutdown(0));
            continue;
          }
          const result = await dispatch(
            { handle, launchOptions: opts.launch },
            req.cmd,
            req.args ?? {}
          );
          writeResp(sock, { id: req.id, ok: true, result });
        } catch (err) {
          writeResp(sock, { id: req.id, ok: false, error: toWireError(err) });
        }
      }
    });
    sock.on('error', () => { /* swallow per-client errors */ });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      try { fs.chmodSync(socketPath, 0o600); } catch { /* not fatal */ }
      resolve();
    });
  });

  await fs.promises.writeFile(pidPath, String(process.pid), 'utf8');

  let shuttingDown = false;
  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try { server.close(); } catch { /* ignore */ }
    await handle.close();
    try { await fs.promises.unlink(socketPath); } catch { /* ignore */ }
    try { await fs.promises.unlink(pidPath); } catch { /* ignore */ }
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
  await new Promise<void>(() => { /* never resolves */ });
}

function writeResp(sock: net.Socket, resp: Response): void {
  try {
    sock.write(JSON.stringify(resp) + '\n');
  } catch {
    /* socket may have closed; ignore */
  }
}

export function toWireError(err: unknown): { code: string; message: string; hint?: string; detail?: Record<string, unknown> } {
  if (err instanceof CraftdriverError) {
    const out: { code: string; message: string; hint?: string; detail?: Record<string, unknown> } = {
      code: err.code,
      message: err.message,
    };
    if (err.hint) out.hint = err.hint;
    if (err.detail) out.detail = err.detail;
    return out;
  }
  if (err instanceof Error) {
    return { code: ErrorCode.DRIVER_ERROR, message: err.message };
  }
  return { code: ErrorCode.DRIVER_ERROR, message: String(err) };
}
