import { spawn, ChildProcess } from 'child_process';
import { HttpClient } from './http.js';
import { WebDriverEndpoint } from './types.js';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { DRIVER_READINESS_TIMEOUT_MS, DRIVER_READINESS_POLL_INTERVAL_MS } from './timing.js';

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

async function findFreePort(): Promise<number> {
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

  async start(): Promise<void> {
    if (this.proc) return; // already started
    await this.ensureBinaryAvailable();

    // Assign a free port if not specified
    const port = this.opts.port ?? await findFreePort();
    this.endpoint = {
      protocol: 'http',
      hostname: this.opts.hostname,
      port,
      path: this.opts.pathBase,
    };

    this.proc = spawn(this.opts.command, [`--port=${port}`, ...this.opts.args], {
      env: { ...process.env, ...this.opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for readiness
    await this.waitUntilReady();
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = undefined;
    p.kill();
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
    throw new Error(
      `Driver service not ready at ${this.endpoint.hostname}:${this.endpoint.port} - ${String(lastErr)}`
    );
  }
}
