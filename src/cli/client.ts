/**
 * Tiny IPC client: speaks the line-delimited JSON protocol over a
 * Unix socket. Each call opens a fresh connection — daemon-side state
 * (active page, browser) survives between calls.
 */
import net from 'net';
import fs from 'fs';
import { DAEMON_SOCKET_PATH, DAEMON_PID_PATH } from './defaults.js';
import type { Request, Response } from './protocol.js';
import { BoundedLineReader, MAX_FRAME_BYTES } from './lineReader.js';

export interface ClientOptions {
  socketPath?: string;
  timeoutMs?: number;
  /** Named daemon session to address. Omitted means the default session. */
  session?: string;
}

export class DaemonClient {
  private nextId = 1;
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly session: string | undefined;

  constructor(opts: ClientOptions = {}) {
    this.socketPath = opts.socketPath ?? DAEMON_SOCKET_PATH;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.session = opts.session;
  }

  /** Returns true if a daemon socket is reachable. */
  static async isRunning(socketPath: string = DAEMON_SOCKET_PATH): Promise<boolean> {
    if (!fs.existsSync(socketPath)) return false;
    return new Promise<boolean>((resolve) => {
      const sock = net.createConnection(socketPath);
      const done = (v: boolean) => { sock.destroy(); resolve(v); };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(500, () => done(false));
    });
  }

  /** Returns the daemon PID, if a PID file exists and the process is alive. */
  static getPid(pidPath: string = DAEMON_PID_PATH): number | null {
    try {
      const raw = fs.readFileSync(pidPath, 'utf8').trim();
      const pid = Number(raw);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      try { process.kill(pid, 0); } catch { return null; }
      return pid;
    } catch {
      return null;
    }
  }

  async send(cmd: string, args: Record<string, unknown> = {}): Promise<Response> {
    const req: Request = {
      id: this.nextId++,
      cmd,
      args,
      ...(this.session ? { session: this.session } : {}),
    };
    return new Promise<Response>((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      // Bounded like the daemon's own reader. Accumulating without a cap meant
      // a daemon that never wrote a newline could grow this buffer until the
      // CLI process died, with nothing to report for it.
      const reader = new BoundedLineReader();
      let answered = false;
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`daemon call timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      sock.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.on('connect', () => {
        sock.write(JSON.stringify(req) + '\n');
      });
      sock.on('data', (chunk) => {
        for (const event of reader.push(chunk)) {
          if (answered) return;
          answered = true;
          clearTimeout(timer);
          sock.end();
          if (event.kind === 'oversized') {
            reject(new Error(
              `daemon response exceeded ${MAX_FRAME_BYTES} bytes and was discarded`,
            ));
            return;
          }
          try {
            resolve(JSON.parse(event.line) as Response);
          } catch (e) {
            reject(new Error('invalid response from daemon: ' + (e as Error).message));
          }
        }
      });
      sock.on('end', () => {
        if (!answered) {
          clearTimeout(timer);
          reject(new Error('daemon closed connection without sending a response'));
        }
      });
    });
  }
}
