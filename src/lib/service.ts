import { spawn, ChildProcess } from 'child_process';
import { HttpClient } from './http.js';
import { WebDriverEndpoint } from './types.js';

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

export class DriverService {
  protected proc?: ChildProcess;
  protected endpoint: WebDriverEndpoint;
  protected readonly opts: Required<Omit<DriverServiceOptions, 'env'>> & {
    env?: NodeJS.ProcessEnv;
  };

  constructor(options: DriverServiceOptions) {
    this.opts = {
      args: options.args ?? [],
      command: options.command,
      hostname: options.hostname ?? '127.0.0.1',
      port: options.port ?? 9515,
      pathBase: options.pathBase ?? '',
      readinessPath: options.readinessPath ?? '/status',
      readinessTimeoutMs: options.readinessTimeoutMs ?? 5000,
      env: options.env,
    };
    this.endpoint = {
      protocol: 'http',
      hostname: this.opts.hostname,
      port: this.opts.port,
      path: this.opts.pathBase,
    };
  }

  getEndpoint(): WebDriverEndpoint {
    return this.endpoint;
  }

  async start(): Promise<void> {
    if (this.proc) return; // already started
    await this.ensureBinaryAvailable();
    this.proc = spawn(this.opts.command, [`--port=${this.opts.port}`, ...this.opts.args], {
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
    // Basic check: try "command --version" quickly
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
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `Driver service not ready at ${this.endpoint.hostname}:${this.endpoint.port} - ${String(lastErr)}`
    );
  }
}
