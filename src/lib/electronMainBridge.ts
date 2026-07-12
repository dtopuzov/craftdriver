/**
 * Minimal CDP bridge to an Electron app's **main-process** Node inspector, the
 * transport behind `browser.electron.executeMain()`. The app is launched with
 * `--inspect=<host>:<port>` (see Browser.launch's electron path); this connects
 * to that inspector and evaluates user callbacks in the main process with the
 * `electron` module injected as the first callback argument.
 *
 * Deliberately tiny — no `@electron/fuses` dependency and no full CDP client. If
 * the inspector isn't reachable (fuse disabled, wrong port), connect() fails with
 * an actionable {@link ErrorCode.ELECTRON_MAIN_UNAVAILABLE}.
 */
import http from 'node:http';
import { WebSocket } from 'ws';
import { CraftdriverError, ErrorCode } from './errors.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;
/** Guard against a runaway return value flooding the socket (32 MB). */
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const INSPECTOR_CONNECT_POLL_MS = 100;

interface InspectorTarget {
  webSocketDebuggerUrl?: string;
  type?: string;
}

interface CdpResult {
  result?: {
    type: string;
    value?: unknown;
    subtype?: string;
    description?: string;
    unserializableValue?: string;
  };
  exceptionDetails?: {
    exception?: { description?: string; value?: unknown };
    text?: string;
  };
}

/** A CDP event frame (no `id`), forwarded to a listener instead of being dropped. */
export type CdpEventListener = (method: string, params: Record<string, unknown>) => void;

export class ElectronMainBridge {
  readonly #host: string;
  readonly #port: number;
  #ws?: WebSocket;
  #nextId = 1;
  #connected = false;
  #onEvent?: CdpEventListener;
  readonly #pending = new Map<
    number,
    { resolve: (v: CdpResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(host: string, port: number) {
    this.#host = host;
    this.#port = port;
  }

  get isConnected(): boolean {
    return this.#connected;
  }

  /**
   * Register a listener for CDP event frames (those without an `id`, e.g.
   * `Runtime.consoleAPICalled`). Used by the main-process log capture; set it
   * before {@link enableRuntime} so the replayed backlog isn't missed.
   */
  onEvent(listener: CdpEventListener): void {
    this.#onEvent = listener;
  }

  /**
   * Enable the CDP `Runtime` domain so the inspector starts (and replays any
   * buffered) `consoleAPICalled` / `exceptionThrown` events. Idempotent.
   */
  async enableRuntime(timeoutMs = DEFAULT_EXECUTE_TIMEOUT_MS): Promise<void> {
    await this.#send('Runtime.enable', {}, timeoutMs);
  }

  /** Fetch the inspector's WebSocket URL and connect to it. */
  async connect(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.#connected) return;

    const deadline = Date.now() + timeoutMs;
    let targets: InspectorTarget[] | undefined;
    let wsUrl: string | undefined;
    let lastCause: unknown;

    while (Date.now() < deadline) {
      try {
        targets = await this.#httpJson(
          `http://${this.#host}:${this.#port}/json/list`,
          Math.max(1, deadline - Date.now())
        );
        wsUrl = targets.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
        if (wsUrl) break;
        lastCause = new Error('inspector exposed no debug target yet');
      } catch (cause) {
        lastCause = cause;
      }

      await delay(Math.min(INSPECTOR_CONNECT_POLL_MS, Math.max(0, deadline - Date.now())));
    }

    if (!wsUrl && !targets) {
      throw this.#unavailable(
        `Could not reach the Electron main-process inspector at ${this.#host}:${this.#port}.`,
        lastCause
      );
    }
    if (!wsUrl) {
      throw this.#unavailable(
        `The Electron main-process inspector at ${this.#host}:${this.#port} exposed no debug target.`,
        lastCause
      );
    }

    const wsTimeoutMs = Math.max(1, deadline - Date.now());
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { maxPayload: MAX_PAYLOAD_BYTES });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(
          this.#unavailable(
            `Timed out connecting to the main-process inspector after ${wsTimeoutMs}ms.`
          )
        );
      }, wsTimeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        this.#ws = ws;
        this.#connected = true;
        ws.on('message', (data) => this.#onMessage(data));
        ws.on('close', () => {
          this.#connected = false;
          this.#failAllPending(new Error('main-process inspector socket closed'));
        });
        ws.on('error', () => {
          /* surfaced per-request via reject/close */
        });
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(this.#unavailable('Failed to open the main-process inspector socket.', err));
      });
    });
  }

  /**
   * Evaluate `fn(electron, ...args)` in the main process and return its (JSON-
   * serializable) result. `awaitPromise` supports async callbacks. A throw in the
   * main process becomes {@link ErrorCode.ELECTRON_MAIN_THREW}.
   */
  async executeMain(
    fnSource: string,
    args: unknown[],
    timeoutMs = DEFAULT_EXECUTE_TIMEOUT_MS
  ): Promise<unknown> {
    if (!this.#connected) throw this.#unavailable('Main-process bridge is not connected.');
    // Resolve the electron module inline via the inspector's CommandLineAPI
    // `require` (needs includeCommandLineAPI) and pass it as the callback's first
    // arg. Args ride as a JSON literal spread into the call; the caller validates
    // serializability first (EVAL_BAD_ARG), matching browser.evaluate().
    const expression = `(${fnSource})(require('electron'), ...${JSON.stringify(args)})`;
    const res = await this.#send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true, // resolve async callbacks before returning
        returnByValue: true,
        includeCommandLineAPI: true, // exposes `require` in the eval
      },
      timeoutMs
    );
    if (res.exceptionDetails) {
      const message =
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'unknown error';
      throw new CraftdriverError(
        ErrorCode.ELECTRON_MAIN_THREW,
        `electron.executeMain() callback threw in the main process: ${message}`,
        { detail: { host: this.#host, port: this.#port } }
      );
    }
    return deserializeResult(res.result);
  }

  async close(): Promise<void> {
    this.#connected = false;
    this.#failAllPending(new Error('main-process bridge closed'));
    const ws = this.#ws;
    this.#ws = undefined;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
      // Don't hang teardown on a half-open socket.
      setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1_000).unref?.();
    });
  }

  #send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<CdpResult> {
    return new Promise<CdpResult>((resolve, reject) => {
      const ws = this.#ws;
      if (!ws) {
        reject(this.#unavailable('Main-process bridge is not connected.'));
        return;
      }
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new CraftdriverError(
            ErrorCode.ELECTRON_MAIN_UNAVAILABLE,
            `Main-process command "${method}" timed out after ${timeoutMs}ms.`
          )
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          const p = this.#pending.get(id);
          if (p) {
            clearTimeout(p.timer);
            this.#pending.delete(id);
          }
          reject(this.#unavailable(`Failed to send "${method}" to the main process.`, err));
        }
      });
    });
  }

  #onMessage(data: WebSocket.RawData): void {
    let msg: {
      id?: number;
      result?: CdpResult;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // ignore non-JSON frames
    }
    if (typeof msg.id !== 'number') {
      // An inspector event (e.g. Runtime.consoleAPICalled), not a command reply.
      if (msg.method && this.#onEvent) this.#onEvent(msg.method, msg.params ?? {});
      return;
    }
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(msg.id);
    if (msg.error) {
      pending.reject(
        new CraftdriverError(
          ErrorCode.ELECTRON_MAIN_UNAVAILABLE,
          `Main-process inspector error: ${msg.error.message ?? 'unknown'}`
        )
      );
    } else {
      pending.resolve(msg.result ?? {});
    }
  }

  #failAllPending(error: Error): void {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }

  #httpJson(url: string, timeoutMs: number): Promise<InspectorTarget[]> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`inspector /json/list returned HTTP ${res.statusCode ?? 'unknown'}`));
          return;
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as InspectorTarget[]);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      });
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error(`inspector /json/list timed out after ${timeoutMs}ms`))
      );
      req.on('error', reject);
    });
  }

  #unavailable(message: string, cause?: unknown): CraftdriverError {
    return new CraftdriverError(ErrorCode.ELECTRON_MAIN_UNAVAILABLE, message, {
      cause,
      hint:
        'Enable main-process access with `electron: { mainProcess: true }`, and ensure the app ' +
        'build keeps the EnableNodeCliInspectArguments fuse enabled (the default).',
      detail: { host: this.#host, port: this.#port },
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deserializeResult(result: CdpResult['result']): unknown {
  if (!result || result.type === 'undefined') return undefined;
  if (result.subtype === 'null') return null;
  if (result.unserializableValue !== undefined) {
    throw nonSerializableResult(result, result.unserializableValue);
  }
  if (result.type === 'string' || result.type === 'boolean') return result.value;
  if (result.type === 'number') {
    if (typeof result.value === 'number' && Number.isFinite(result.value)) return result.value;
    throw nonSerializableResult(result);
  }
  if (result.type === 'object' && result.value !== undefined) return result.value;
  throw nonSerializableResult(result);
}

function nonSerializableResult(
  result: NonNullable<CdpResult['result']>,
  detailValue?: string
): CraftdriverError {
  const returnedType = result.subtype ?? result.type;
  const suffix = detailValue ? ` (${detailValue})` : '';
  return new CraftdriverError(
    ErrorCode.EVAL_BAD_ARG,
    `executeMain() returned ${returnedType}${suffix}, which is not JSON-serializable. ` +
      'Return a primitive, array, or plain object instead.',
    {
      detail: {
        returnedType,
        description: result.description,
        unserializableValue: result.unserializableValue,
      },
    }
  );
}
