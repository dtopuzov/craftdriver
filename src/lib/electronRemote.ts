/**
 * `browser.electron` — the optional Electron **main-process** capability
 * namespace. Deliberately not an `ElectronApp` class: the renderer stays on the
 * ordinary `Browser` API; this adds only what the DOM surface can't reach.
 *
 * `executeMain(fn, ...args)` runs `fn(electron, ...args)` in the app's main
 * process (Node context, full `electron` module) and returns its JSON-
 * serializable result. It's named `executeMain` — not `execute` — so the process
 * boundary is loud at every call site: `browser.evaluate()` runs in the renderer,
 * `browser.electron.executeMain()` in the powerful main process. (WDIO calls this
 * `browser.electron.execute`; the rename is a one-time migration cost.)
 */
import { CraftdriverError, ErrorCode } from './errors.js';
import { ElectronMainBridge } from './electronMainBridge.js';
import {
  ElectronMainLogMonitor,
  type ConsoleApiCalledParams,
  type ExceptionThrownParams,
} from './electronMainLogs.js';
import {
  ElectronDialogMockHandle,
  type ElectronDialogMock,
  type ElectronDialogMethod,
  type ElectronMessageBoxResult,
  type ElectronOpenDialogResult,
  type ElectronSaveDialogResult,
  validateDialogResult,
} from './electronDialogMock.js';
import {
  ElectronMockHandle,
  type ElectronMock,
  validateMockTarget,
} from './electronMock.js';
import {
  executeDeeplinkCommand,
  getPlatformCommand,
  resolveDeeplinkUrl,
  validateDeeplinkUrl,
} from './electronDeeplink.js';
import { readInspectArgumentsFuse } from './electronFuses.js';

export interface ElectronMainConnectInfo {
  host: string;
  port: number;
}

/** Extra context ElectronRemote needs beyond the inspector endpoint. */
export interface ElectronRemoteOptions {
  /** The launched app's executable path — required to route deep links on Windows. */
  appBinaryPath?: string;
}

/** A function evaluated in the Electron main process; receives the `electron` module. */
export type MainProcessCallback<T> = (electron: unknown, ...args: unknown[]) => T | Promise<T>;

function assertJsonSerializable(value: unknown, path = 'arg', stack = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new CraftdriverError(
      ErrorCode.EVAL_BAD_ARG,
      `executeMain(fn, ...args): ${path} must be a finite JSON number.`,
      { detail: { path, argType: 'number' } }
    );
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) {
      throw new CraftdriverError(
        ErrorCode.EVAL_BAD_ARG,
        `executeMain(fn, ...args): ${path} contains a circular reference.`,
        { detail: { path, argType: 'array' } }
      );
    }
    stack.add(value);
    try {
      value.forEach((item, index) => assertJsonSerializable(item, `${path}[${index}]`, stack));
    } finally {
      stack.delete(value);
    }
    return;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CraftdriverError(
        ErrorCode.EVAL_BAD_ARG,
        `executeMain(fn, ...args): ${path} must be a plain JSON object.`,
        { detail: { path, argType: proto?.constructor?.name ?? 'object' } }
      );
    }
    const obj = value as Record<string, unknown>;
    if (stack.has(obj)) {
      throw new CraftdriverError(
        ErrorCode.EVAL_BAD_ARG,
        `executeMain(fn, ...args): ${path} contains a circular reference.`,
        { detail: { path, argType: 'object' } }
      );
    }
    stack.add(obj);
    try {
      for (const [key, item] of Object.entries(obj)) {
        assertJsonSerializable(item, `${path}.${key}`, stack);
      }
    } finally {
      stack.delete(obj);
    }
    return;
  }
  throw new CraftdriverError(
    ErrorCode.EVAL_BAD_ARG,
    `executeMain(fn, ...args): ${path} of type "${typeof value}" is not JSON-serializable.`,
    { detail: { path, argType: typeof value } }
  );
}

/**
 * Run code in the Electron main process via `browser.electron.executeMain`.
 * Named `executeMain` (not WDIO's `execute`) so the process boundary is loud:
 * `browser.evaluate()` is the renderer, `executeMain()` the main process.
 */
export class ElectronRemote {
  #bridge?: ElectronMainBridge;
  readonly #connect?: ElectronMainConnectInfo;
  readonly #appBinaryPath?: string;
  #userDataDir?: string;
  readonly #mainLogs = new ElectronMainLogMonitor();
  readonly #dialogMocks = new Map<ElectronDialogMethod, ElectronDialogMock>();
  readonly #apiMocks = new Map<string, ElectronMock>();

  /** `connect` is undefined for non-Electron sessions or when `mainProcess` wasn't enabled. */
  constructor(connect?: ElectronMainConnectInfo, options?: ElectronRemoteOptions) {
    this.#connect = connect;
    this.#appBinaryPath = options?.appBinaryPath;
  }

  /**
   * Captured **main-process** console output and errors — the main-process
   * counterpart to `browser.logs`. Populated from launch when the session was
   * started with `electron: { mainProcess: true }` (empty otherwise). See
   * {@link ElectronMainLogMonitor}.
   *
   * ```ts
   * await browser.electron.executeMain((electron) => console.log('ready', electron.app.getName()));
   * const [entry] = browser.electron.mainLogs.getLogs();
   * ```
   */
  get mainLogs(): ElectronMainLogMonitor {
    return this.#mainLogs;
  }

  /**
   * Open the main-process bridge now (rather than lazily on first `executeMain`)
   * so `mainLogs` captures from launch. No-op without a main-process inspector;
   * best-effort — the caller (Browser.launch) swallows failures so a disabled
   * inspector fuse never breaks renderer automation.
   */
  async connect(): Promise<void> {
    if (!this.#connect) return;
    await this.#ensureConnected();
  }

  /**
   * Run `fn` in the Electron **main process**. `fn` receives the `electron`
   * module first, then your `args` (which must be JSON-serializable). The return
   * value is passed back by value, so it must be JSON-serializable too.
   *
   * ```ts
   * const version = await browser.electron.executeMain(
   *   (electron) => electron.app.getVersion(),
   * );
   * ```
   */
  async executeMain<T = unknown>(fn: MainProcessCallback<T>, ...args: unknown[]): Promise<T> {
    if (!this.#connect) {
      throw new CraftdriverError(
        ErrorCode.ELECTRON_MAIN_UNAVAILABLE,
        'Electron main-process access is not available for this session.',
        {
          hint:
            'Launch with `electron: { mainProcess: true }` to enable it. Browser sessions, and ' +
            'Electron launches without that flag, do not expose the main process.',
        }
      );
    }
    if (typeof fn !== 'function') {
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        'executeMain(fn, ...args): fn must be a function.'
      );
    }
    // Args cross the wire as a JSON literal. Validate recursively instead of
    // relying on JSON.stringify(), which silently turns values like undefined,
    // functions, Symbols, NaN, and Infinity into null inside arrays/objects.
    args.forEach((arg, index) => assertJsonSerializable(arg, `arg[${index}]`));

    const bridge = await this.#ensureConnected();
    return bridge.executeMain(fn.toString(), args) as Promise<T>;
  }

  /**
   * Replace any `electron.<api>.<fn>` **main-process** method with a scripted
   * return value and call recorder. The general primitive behind the typed
   * {@link mockDialog} convenience — reach for it for `shell.openExternal`,
   * `app.getPath`, `safeStorage.encryptString`, and other Electron APIs.
   *
   * The app is not modified: the replacement lives in its main process for this
   * session and is restored by `mock.restore()` or `browser.quit()`. The scripted
   * value is returned **as-is** (not wrapped in a Promise), so it works for both
   * synchronous methods and `await`ed asynchronous ones. Provide the resolved
   * value for an async method; recorded call args and the return value must be
   * JSON-serializable.
   *
   * ```ts
   * const openExternal = await browser.electron.mock('shell', 'openExternal', true);
   * await browser.click(By.testId('open-docs'));
   * expect(await openExternal.getCalls()).toEqual([{ args: ['https://example.com/docs'] }]);
   * ```
   */
  async mock(api: string, fn: string, returnValue?: unknown): Promise<ElectronMock> {
    validateMockTarget(api, fn);
    const key = `${api}.${fn}`;
    if (this.#apiMocks.has(key)) {
      throw new CraftdriverError(
        ErrorCode.STATE_INVALID,
        `electron.${key} is already mocked. Restore that mock before replacing it.`
      );
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // `undefined` can't cross executeMain's JSON-arg validation, so carry a
    // presence flag and a JSON-safe placeholder; the callback restores undefined.
    const hasResult = returnValue !== undefined;
    await this.executeMain(
      (electron, apiName, funcName, mockId, resultPresent, scriptedResult) => {
        const registryKey = Symbol.for('craftdriver.electron.apiMocks');
        const globals = globalThis as unknown as Record<PropertyKey, unknown>;
        const registry = (globals[registryKey] ??= Object.create(null)) as Record<
          string,
          {
            id: unknown;
            original: (...args: unknown[]) => unknown;
            calls: Array<{ args: unknown[] }>;
            result: unknown;
            replacement?: (...args: unknown[]) => unknown;
          }
        >;
        const entryKey = `${apiName as string}.${funcName as string}`;
        if (registry[entryKey]) throw new Error(`Mock ${entryKey} is already active.`);

        const namespace = (electron as Record<string, Record<string, unknown>>)[apiName as string];
        if (!namespace || typeof namespace !== 'object') {
          throw new Error(`electron.${apiName as string} is not available in this Electron build.`);
        }
        const original = namespace[funcName as string];
        if (typeof original !== 'function') {
          throw new Error(`electron.${entryKey} is not a function in this Electron build.`);
        }

        const jsonSafe = (value: unknown, seen = new WeakSet<object>()): unknown => {
          if (value === null || typeof value === 'string' || typeof value === 'boolean')
            return value;
          if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
          if (typeof value !== 'object') return `[${typeof value}]`;
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
          try {
            if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null) {
              return `[${proto?.constructor?.name ?? 'Object'}]`;
            }
            const copy: Record<string, unknown> = {};
            for (const [name, item] of Object.entries(value)) copy[name] = jsonSafe(item, seen);
            return copy;
          } finally {
            seen.delete(value);
          }
        };

        const entry = {
          id: mockId,
          original: original as (...args: unknown[]) => unknown,
          calls: [] as Array<{ args: unknown[] }>,
          result: resultPresent ? scriptedResult : undefined,
          replacement: undefined as ((...args: unknown[]) => unknown) | undefined,
        };
        const replacement = (...args: unknown[]) => {
          entry.calls.push({ args: args.map((a) => jsonSafe(a)) });
          // Return a fresh clone so a caller mutating the result can't corrupt the
          // scripted value for later calls. Returned as-is (sync), so both sync and
          // awaited-async callers see the value.
          return entry.result === undefined ? undefined : JSON.parse(JSON.stringify(entry.result));
        };
        entry.replacement = replacement;
        registry[entryKey] = entry;
        namespace[funcName as string] = replacement;
      },
      api,
      fn,
      id,
      hasResult,
      hasResult ? returnValue : null
    );

    const mock = new ElectronMockHandle(this, api, fn, id, () => {
      this.#apiMocks.delete(key);
    });
    this.#apiMocks.set(key, mock);
    return mock;
  }

  /**
   * Open a custom-protocol **deep link** (`myapp://…`) against the running app,
   * exactly as the OS would when another app or the browser hands off the URL —
   * so your app's real `open-url` (macOS) / `second-instance` (Windows, Linux)
   * handler runs. Fire-and-forget: it resolves once the OS launcher is spawned;
   * assert the effect through your app afterwards (e.g. `waitForLog`, a renderer
   * assertion, or `executeMain`).
   *
   * Your app must register the protocol (`app.setAsDefaultProtocolClient(...)`)
   * and take the single-instance lock. On Windows and Linux a raw deep link would
   * spawn a *second* instance; craftdriver appends the running app's user-data dir
   * as a `userData` query parameter so the second instance can route the URL to
   * the test instance (auto-detected via the main process when available).
   *
   * ```ts
   * await browser.electron.triggerDeeplink('myapp://open?file=test.txt');
   * const entry = await browser.electron.mainLogs.waitForLog((l) => l.text.includes('open-url'));
   * ```
   */
  async triggerDeeplink(url: string): Promise<void> {
    const platform = process.platform;
    // Validate before any detection work so a bad URL fails fast and identically
    // on every platform.
    validateDeeplinkUrl(url);

    // Windows/Linux need the running app's user-data dir to route the URL to this
    // instance; detect it once (best-effort) via the main process, then cache it.
    let userDataDir = this.#userDataDir;
    if (!userDataDir && (platform === 'win32' || platform === 'linux') && this.#connect) {
      try {
        userDataDir = await this.executeMain(
          (electron) =>
            (electron as { app: { getPath(name: string): string } }).app.getPath('userData')
        );
        this.#userDataDir = userDataDir;
      } catch {
        // Fall through: without it the deep link may open a fresh instance. The
        // command still runs; the caller's post-assertion will reveal a miss.
      }
    }

    const finalUrl = resolveDeeplinkUrl(url, platform, userDataDir);
    const { command, args } = getPlatformCommand(finalUrl, platform, this.#appBinaryPath);
    await executeDeeplinkCommand(command, args);
  }

  /**
   * Replace an asynchronous native Electron dialog with a deterministic result.
   * The app is not modified: the replacement lives in its main process for this
   * session and is restored by `mock.restore()` or `browser.quit()`.
   */
  async mockDialog(
    method: 'showOpenDialog',
    result: ElectronOpenDialogResult
  ): Promise<ElectronDialogMock>;
  async mockDialog(
    method: 'showSaveDialog',
    result: ElectronSaveDialogResult
  ): Promise<ElectronDialogMock>;
  async mockDialog(
    method: 'showMessageBox',
    result: ElectronMessageBoxResult
  ): Promise<ElectronDialogMock>;
  async mockDialog(
    method: ElectronDialogMethod,
    result: ElectronOpenDialogResult | ElectronSaveDialogResult | ElectronMessageBoxResult
  ): Promise<ElectronDialogMock> {
    if (!['showOpenDialog', 'showSaveDialog', 'showMessageBox'].includes(method)) {
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `Unsupported Electron dialog method "${String(method)}".`,
        {
          hint: 'Use showOpenDialog, showSaveDialog, or showMessageBox.',
          detail: { method },
        }
      );
    }
    validateDialogResult(method, result);
    if (this.#dialogMocks.has(method)) {
      throw new CraftdriverError(
        ErrorCode.STATE_INVALID,
        `electron.dialog.${method} is already mocked. Restore that mock before replacing it.`
      );
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.executeMain(
      (electron, dialogMethod, mockId, scriptedResult) => {
        const methodName = dialogMethod as ElectronDialogMethod;
        const key = Symbol.for('craftdriver.electron.dialogMocks');
        const globals = globalThis as unknown as Record<PropertyKey, unknown>;
        const registry = (globals[key] ??= Object.create(null)) as Record<
          string,
          {
            id: unknown;
            original: (...args: unknown[]) => unknown;
            calls: Array<{ options: unknown }>;
            result: unknown;
            replacement?: (...args: unknown[]) => Promise<unknown>;
          }
        >;
        if (registry[methodName]) throw new Error(`Dialog mock ${methodName} is already active.`);

        const dialog = (electron as { dialog: Record<string, (...args: unknown[]) => unknown> })
          .dialog;
        const original = dialog[methodName];
        if (typeof original !== 'function') {
          throw new Error(`electron.dialog.${methodName} is not available in this Electron build.`);
        }

        const entry: {
          id: unknown;
          original: (...args: unknown[]) => unknown;
          calls: Array<{ options: unknown }>;
          result: unknown;
          replacement?: (...args: unknown[]) => Promise<unknown>;
        } = {
          id: mockId,
          original,
          calls: [],
          result: scriptedResult,
          replacement: undefined,
        };
        const jsonSafe = (value: unknown, seen = new WeakSet<object>()): unknown => {
          if (value === null || typeof value === 'string' || typeof value === 'boolean')
            return value;
          if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
          if (typeof value !== 'object') return `[${typeof value}]`;
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
          try {
            if (Array.isArray(value)) return value.map((item) => jsonSafe(item, seen));
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null) {
              return `[${proto?.constructor?.name ?? 'Object'}]`;
            }
            const copy: Record<string, unknown> = {};
            for (const [name, item] of Object.entries(value)) copy[name] = jsonSafe(item, seen);
            return copy;
          } finally {
            seen.delete(value);
          }
        };
        const replacement = (...args: unknown[]) => {
          const options = args.length > 1 ? args[1] : args[0];
          entry.calls.push({ options: jsonSafe(options) });
          return Promise.resolve(JSON.parse(JSON.stringify(entry.result)));
        };
        entry.replacement = replacement;
        registry[methodName] = entry;
        dialog[methodName] = replacement;
      },
      method,
      id,
      result
    );

    const mock = new ElectronDialogMockHandle(this, method, id, () => {
      this.#dialogMocks.delete(method);
    });
    this.#dialogMocks.set(method, mock);
    return mock;
  }

  async #ensureConnected(): Promise<ElectronMainBridge> {
    if (!this.#bridge) {
      const bridge = new ElectronMainBridge(this.#connect!.host, this.#connect!.port);
      try {
        await bridge.connect();
        // Route CDP Runtime events into the log monitor, then enable the domain.
        // Order matters: the listener must be armed before Runtime.enable so the
        // inspector's replayed console backlog is captured, not dropped.
        bridge.onEvent((method, params) => {
          if (method === 'Runtime.consoleAPICalled') {
            this.#mainLogs.ingestConsoleEvent(params as ConsoleApiCalledParams);
          } else if (method === 'Runtime.exceptionThrown') {
            this.#mainLogs.ingestExceptionEvent(params as ExceptionThrownParams);
          }
        });
        await bridge.enableRuntime();
      } catch (error) {
        await bridge.close().catch(() => {});
        throw this.#enrichUnreachable(error);
      }
      this.#bridge = bridge;
    }
    return this.#bridge;
  }

  /**
   * When the main-process inspector is unreachable, read the app's
   * `EnableNodeCliInspectArguments` fuse: if it's provably disabled/removed, upgrade
   * the generic "inspector unreachable" into a precise, actionable error. Any other
   * status (enabled, or unreadable) leaves the original error — which already names
   * the fuse as the likely cause — untouched.
   */
  #enrichUnreachable(error: unknown): unknown {
    if (!CraftdriverError.is(error, ErrorCode.ELECTRON_MAIN_UNAVAILABLE)) return error;
    const status = readInspectArgumentsFuse(this.#appBinaryPath);
    if (status !== 'disabled' && status !== 'removed') return error;
    return new CraftdriverError(
      ErrorCode.ELECTRON_MAIN_UNAVAILABLE,
      `This Electron build has the EnableNodeCliInspectArguments fuse ${status}, so its main ` +
        'process cannot be reached — browser.electron.executeMain / mock / mockDialog / mainLogs ' +
        'are unavailable. Renderer automation is unaffected.',
      {
        cause: error,
        hint:
          'Package a test build with the EnableNodeCliInspectArguments fuse enabled (the default) ' +
          'before code signing; a disabled fuse cannot be changed after signing.',
        detail: {
          fuse: 'EnableNodeCliInspectArguments',
          fuseStatus: status,
          appBinaryPath: this.#appBinaryPath,
        },
      }
    );
  }

  /** Close the underlying inspector connection. Called from `Browser.quit()`. */
  async close(): Promise<void> {
    for (const mock of [...this.#dialogMocks.values(), ...this.#apiMocks.values()]) {
      await mock.restore().catch(() => {});
    }
    this.#dialogMocks.clear();
    this.#apiMocks.clear();
    const bridge = this.#bridge;
    this.#bridge = undefined;
    await bridge?.close();
  }
}
