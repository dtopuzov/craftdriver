/**
 * Main-process console/error capture for Electron — the `browser.electron.mainLogs`
 * counterpart to the renderer's `browser.logs`. It buffers what the app's **main
 * process** writes to `console.*`, delivered over the same Node inspector socket as
 * `executeMain` via CDP `Runtime.consoleAPICalled` events (see ElectronMainBridge).
 *
 * Why console-based (measured against the real app, 2026-07-11): in the Electron
 * main process `Runtime.exceptionThrown` is *not* a reliable error signal — Electron
 * installs its own uncaught-exception handling, and unhandled promise rejections are
 * emitted by Node as `UnhandledPromiseRejectionWarning`s routed through
 * `console.error`. So `console.error(...)` (and those warnings) are captured as
 * error-level entries; any `exceptionThrown` that *does* arrive is surfaced too, as a
 * best-effort `type: 'exception'` entry.
 *
 * Capture is always-on once the session is launched with `electron.mainProcess: true`
 * (the bridge connects and enables the Runtime domain at launch), mirroring the
 * always-on renderer log capture.
 */
import { CraftdriverError, ErrorCode } from './errors.js';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from './timing.js';

/** Normalized level for a main-process log entry. */
export type ElectronMainLogLevel = 'log' | 'debug' | 'info' | 'warn' | 'error';

export interface ElectronMainLog {
  /** `console` for a `console.*` call; `exception` for an uncaught error the inspector reported. */
  type: 'console' | 'exception';
  /** Normalized level. `error` covers `console.error`/`console.assert` and every `exception`. */
  level: ElectronMainLogLevel;
  /** Human-readable, space-joined message text (arguments stringified like the console does). */
  text: string;
  /** Best-effort deserialized arguments: primitives by value, complex values as their description string. */
  args: unknown[];
  /** When the inspector reported the entry. */
  timestamp: Date;
  /** Raw CDP console method for `console` entries (`log`, `warning`, `error`, `trace`, …); absent for exceptions. */
  method?: string;
  /** Formatted call stack, when the inspector provided one. */
  stackTrace?: string;
}

export type ElectronMainLogHandler = (log: ElectronMainLog) => void;

/** Shapes of the two CDP Runtime events we ingest (only the fields we read). */
interface CdpRemoteObject { type: string; subtype?: string; value?: unknown; description?: string }
interface CdpStackTrace {
  callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }>;
}
export interface ConsoleApiCalledParams {
  type?: string;
  args?: CdpRemoteObject[];
  timestamp?: number;
  stackTrace?: CdpStackTrace;
}
export interface ExceptionThrownParams {
  timestamp?: number;
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
    stackTrace?: CdpStackTrace;
  };
}

const MAX_LOGS = 1000;

/** Map a CDP console `type` to a normalized level (aligned with @wdio/electron-service). */
function mapConsoleLevel(type: string | undefined): ElectronMainLogLevel {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
      return 'warn';
    case 'info':
      return 'info';
    case 'debug':
    case 'trace':
      return 'debug';
    case 'log':
      return 'log';
    default:
      return 'log';
  }
}

function deserializeArg(o: CdpRemoteObject): unknown {
  if (o.type === 'undefined') return undefined;
  if (o.subtype === 'null') return null;
  if (o.type === 'string' || o.type === 'number' || o.type === 'boolean') return o.value;
  // objects, functions, errors, bigint, …: the description is the portable, console-like form.
  return o.description ?? (o.subtype ? `[${o.subtype}]` : `[${o.type}]`);
}

function argToText(o: CdpRemoteObject): string {
  if (o.type === 'undefined') return 'undefined';
  if (o.subtype === 'null') return 'null';
  if (o.type === 'string' || o.type === 'number' || o.type === 'boolean') return String(o.value);
  return o.description ?? (o.subtype ? `[${o.subtype}]` : `[${o.type}]`);
}

function formatStackTrace(trace: CdpStackTrace | undefined): string | undefined {
  if (!trace?.callFrames?.length) return undefined;
  return trace.callFrames
    .map((f) => `  at ${f.functionName || '<anonymous>'} (${f.url ?? ''}:${f.lineNumber ?? 0}:${f.columnNumber ?? 0})`)
    .join('\n');
}

/**
 * Buffers and dispatches main-process log entries. Reachable via
 * `browser.electron.mainLogs`; its public surface mirrors the renderer
 * {@link LogMonitor} so console monitoring reads the same in both processes.
 */
export class ElectronMainLogMonitor {
  #logs: ElectronMainLog[] = [];
  #handlers = new Set<ElectronMainLogHandler>();
  #errorHandlers = new Set<ElectronMainLogHandler>();

  /** Feed a CDP `Runtime.consoleAPICalled` event. */
  ingestConsoleEvent(params: ConsoleApiCalledParams): void {
    const args = params.args ?? [];
    this.#record({
      type: 'console',
      level: mapConsoleLevel(params.type),
      text: args.map(argToText).join(' '),
      args: args.map(deserializeArg),
      timestamp: params.timestamp ? new Date(params.timestamp) : new Date(),
      method: params.type,
      stackTrace: formatStackTrace(params.stackTrace),
    });
  }

  /** Feed a CDP `Runtime.exceptionThrown` event (best-effort in Electron main). */
  ingestExceptionEvent(params: ExceptionThrownParams): void {
    const details = params.exceptionDetails;
    const text = details?.exception?.description ?? details?.text ?? 'uncaught exception';
    this.#record({
      type: 'exception',
      level: 'error',
      text,
      args: [],
      timestamp: params.timestamp ? new Date(params.timestamp) : new Date(),
      stackTrace: formatStackTrace(details?.stackTrace),
    });
  }

  /** All captured entries (console + exceptions), oldest first. */
  getLogs(): ElectronMainLog[] {
    return [...this.#logs];
  }

  /** Only error-level entries: `console.error`/`console.assert` and every reported exception. */
  getErrors(): ElectronMainLog[] {
    return this.#logs.filter((l) => l.level === 'error');
  }

  /** Drop everything captured so far. */
  clearLogs(): void {
    this.#logs = [];
  }

  /** Subscribe to every entry. Returns an unsubscribe function. */
  onLog(handler: ElectronMainLogHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Subscribe to error-level entries only. Returns an unsubscribe function. */
  onError(handler: ElectronMainLogHandler): () => void {
    this.#errorHandlers.add(handler);
    return () => this.#errorHandlers.delete(handler);
  }

  /** Resolve with the first entry matching `predicate` (checked against already-buffered entries first). */
  waitForLog(
    predicate: (log: ElectronMainLog) => boolean,
    timeout = DEFAULT_NAVIGATION_TIMEOUT_MS,
  ): Promise<ElectronMainLog> {
    return this.#waitFor(this.#logs, this.onLog.bind(this), predicate, timeout, 'log');
  }

  /** Resolve with the first error-level entry matching `predicate` (default: any error). */
  waitForError(
    predicate: (log: ElectronMainLog) => boolean = () => true,
    timeout = DEFAULT_NAVIGATION_TIMEOUT_MS,
  ): Promise<ElectronMainLog> {
    return this.#waitFor(this.getErrors(), this.onError.bind(this), predicate, timeout, 'error');
  }

  /** Throw if any error-level entry was captured — a fail-fast assertion for tests. */
  assertNoErrors(): void {
    const errors = this.getErrors();
    if (errors.length > 0) {
      throw new CraftdriverError(
        ErrorCode.ELECTRON_MAIN_THREW,
        `Electron main process reported ${errors.length} error(s):\n${errors.map((e) => e.text).join('\n')}`,
      );
    }
  }

  #record(log: ElectronMainLog): void {
    this.#logs.push(log);
    if (this.#logs.length > MAX_LOGS) this.#logs.shift();
    this.#notify(this.#handlers, log);
    if (log.level === 'error') this.#notify(this.#errorHandlers, log);
  }

  #notify(handlers: Set<ElectronMainLogHandler>, log: ElectronMainLog): void {
    for (const handler of handlers) {
      try {
        handler(log);
      } catch {
        // A subscriber's own failure must never break capture or other subscribers.
      }
    }
  }

  #waitFor(
    buffered: ElectronMainLog[],
    subscribe: (h: ElectronMainLogHandler) => () => void,
    predicate: (log: ElectronMainLog) => boolean,
    timeout: number,
    kind: 'log' | 'error',
  ): Promise<ElectronMainLog> {
    const existing = buffered.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new CraftdriverError(
          ErrorCode.TIMEOUT,
          `Timed out after ${timeout}ms waiting for a matching Electron main-process ${kind}.`,
        ));
      }, timeout);
      const unsubscribe = subscribe((log) => {
        if (!predicate(log)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(log);
      });
    });
  }
}
