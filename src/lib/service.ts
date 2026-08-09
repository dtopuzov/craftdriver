import { spawn, ChildProcess } from 'child_process';
import { HttpClient } from './http.js';
import { WebDriverEndpoint } from './types.js';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { DRIVER_READINESS_TIMEOUT_MS, DRIVER_READINESS_POLL_INTERVAL_MS } from './timing.js';

const DRIVER_OUTPUT_TAIL_BYTES = 64 * 1024;
const DRIVER_OUTPUT_LABEL_BYTES = Buffer.byteLength('[stdout]\n\n[stderr]\n', 'utf8');
const DRIVER_OUTPUT_TAIL_BYTES_PER_STREAM = Math.floor(
  (DRIVER_OUTPUT_TAIL_BYTES - DRIVER_OUTPUT_LABEL_BYTES) / 2
);

export interface DriverServiceOptions {
  command: string;
  args?: string[];
  hostname?: string;
  port?: number;
  pathBase?: string;
  env?: NodeJS.ProcessEnv;
  readinessPath?: string; // e.g. /status
  readinessTimeoutMs?: number;
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export class DriverService {
  protected proc?: ChildProcess;
  protected endpoint!: WebDriverEndpoint;
  private stdoutTail = '';
  private stderrTail = '';
  private startupFailure?: Error;
  private ready = false;
  protected readonly opts: Required<Omit<DriverServiceOptions, 'env' | 'port'>> & {
    env?: NodeJS.ProcessEnv;
    port?: number;
  };

  constructor(options: DriverServiceOptions) {
    this.opts = {
      args: options.args ?? [],
      command: options.command,
      hostname: options.hostname ?? '127.0.0.1',
      port: options.port, // undefined means auto-assign
      pathBase: options.pathBase ?? '',
      readinessPath: options.readinessPath ?? '/status',
      readinessTimeoutMs: options.readinessTimeoutMs ?? DRIVER_READINESS_TIMEOUT_MS,
      env: options.env,
    };
  }

  getEndpoint(): WebDriverEndpoint {
    return this.endpoint;
  }

  getCommand(): string {
    return this.opts.command;
  }

  /**
   * Whether a timed-out local `POST /session` may be retried after replacing
   * this driver process. Disabled by default: remote sessions never use a
   * service, Firefox has its own readiness retry, and Safari/Electron need
   * browser-specific evidence before an automatic second launch is safe.
   */
  allowsFreshSessionRetry(): boolean {
    return false;
  }

  /**
   * Returns the bounded tail of driver stdout/stderr captured since the latest
   * start attempt. This is primarily useful when attaching startup diagnostics
   * to test-runner artifacts.
   */
  getOutputTail(): string {
    const parts: string[] = [];
    if (this.stdoutTail) parts.push(`[stdout]\n${this.stdoutTail}`);
    if (this.stderrTail) parts.push(`[stderr]\n${this.stderrTail}`);
    return parts.join('\n');
  }

  async start(): Promise<void> {
    if (this.proc) return; // already started
    await this.ensureBinaryAvailable();

    this.stdoutTail = '';
    this.stderrTail = '';
    this.startupFailure = undefined;
    this.ready = false;

    // Assign a free port if not specified
    const port = this.opts.port ?? (await findFreePort());
    this.endpoint = {
      protocol: 'http',
      hostname: this.opts.hostname,
      port,
      path: this.opts.pathBase,
    };

    this.proc = spawn(this.opts.command, this.buildCommandArgs(port), {
      env: this.computeSpawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Always drain both pipes. Leaving either unread can block a sufficiently
    // noisy driver before it reaches the readiness endpoint.
    this.proc.stdout?.on('data', (chunk: Buffer | string) => {
      this.appendOutput('stdout', chunk);
    });
    this.proc.stderr?.on('data', (chunk: Buffer | string) => {
      this.appendOutput('stderr', chunk);
    });
    this.proc.once('error', (error) => {
      if (!this.ready) this.startupFailure = error;
    });
    // `close` follows `exit` only after stdio has closed, so the error includes
    // every final stdout/stderr chunk rather than racing the pipe readers.
    this.proc.once('close', (code, signal) => {
      if (!this.ready) {
        const result = signal ? `signal ${signal}` : `code ${String(code)}`;
        this.startupFailure = new Error(`Driver process exited before it was ready (${result}).`);
      }
    });

    try {
      await this.waitUntilReady();
      this.ready = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = undefined;
    this.ready = false;
    p.kill();
  }

  /** Build the driver CLI arguments. Overridable by process-fixture tests. */
  protected buildCommandArgs(port: number): string[] {
    return [`--port=${port}`, ...this.opts.args];
  }

  /**
   * Environment for the spawned driver process. Overridable so a subclass can
   * scrub variables that would break the target it launches (see
   * {@link ElectronService}, which drops `ELECTRON_RUN_AS_NODE`).
   */
  protected computeSpawnEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.opts.env };
  }

  private appendOutput(source: 'stdout' | 'stderr', chunk: Buffer | string): void {
    let tail = (source === 'stdout' ? this.stdoutTail : this.stderrTail) + String(chunk);
    if (Buffer.byteLength(tail, 'utf8') > DRIVER_OUTPUT_TAIL_BYTES_PER_STREAM) {
      // Slice by characters first, then trim any remaining multibyte excess.
      // Driver logs are overwhelmingly ASCII, while this keeps the common path
      // cheap and guarantees a hard upper bound after the second pass.
      tail = tail.slice(-DRIVER_OUTPUT_TAIL_BYTES_PER_STREAM);
      while (Buffer.byteLength(tail, 'utf8') > DRIVER_OUTPUT_TAIL_BYTES_PER_STREAM) {
        tail = tail.slice(1);
      }
    }
    if (source === 'stdout') this.stdoutTail = tail;
    else this.stderrTail = tail;
  }

  private startupError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const output = this.getOutputTail().trim();
    return new Error(output ? `${message}\nDriver output (tail):\n${output}` : message);
  }

  protected async ensureBinaryAvailable(): Promise<void> {
    // When the command is an absolute path that exists, the driver resolver
    // (resolveChromeDriver / resolveFirefoxDriver) has already located and
    // validated it — skip the extra `<driver> --version` spawn. That spawn
    // launches the driver binary and costs ~150ms per Browser.launch() while
    // blocking the event loop (which hurts parallel launches). A broken binary
    // still surfaces a clear error from the real `--port` spawn below.
    if (path.isAbsolute(this.opts.command) && fs.existsSync(this.opts.command)) {
      return;
    }
    // Bare command name (e.g. resolved from PATH): confirm it runs.
    await new Promise<void>((resolve, reject) => {
      const check = spawn(this.opts.command, ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      let resolved = false;
      check.on('error', (e) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Failed to run ${this.opts.command}. Is it installed and on PATH?`));
        }
      });
      check.on('exit', () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });
    });
  }

  protected async waitUntilReady(): Promise<void> {
    const client = new HttpClient(this.endpoint);
    const deadline = Date.now() + this.opts.readinessTimeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      if (this.startupFailure) throw this.startupError(this.startupFailure);
      try {
        const res = await client.send({ method: 'GET', path: this.opts.readinessPath! });
        // chromedriver responds with { value: { ready: true, message: '...' } } or similar
        if (res && typeof res === 'object') return;
      } catch (e) {
        lastErr = e;
      }
      // Tight poll: the driver's /status endpoint comes up ~200ms after spawn,
      // so a short interval shaves the tail latency between "ready" and "we
      // notice". These are cheap localhost GETs.
      await new Promise((r) => setTimeout(r, DRIVER_READINESS_POLL_INTERVAL_MS));
    }
    if (this.startupFailure) throw this.startupError(this.startupFailure);
    throw this.startupError(
      `Driver service not ready at ${this.endpoint.hostname}:${this.endpoint.port} - ${String(lastErr)}`
    );
  }
}
