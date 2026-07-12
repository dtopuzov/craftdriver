import { CraftdriverError, ErrorCode } from './errors.js';

/** One recorded invocation of a mocked Electron main-process method. */
export interface ElectronMockCall {
  /** The (JSON-safe) arguments the app passed to the mocked method. */
  args: unknown[];
}

interface MainExecutor {
  executeMain<T = unknown>(
    fn: (electron: unknown, ...args: unknown[]) => T | Promise<T>,
    ...args: unknown[]
  ): Promise<T>;
}

/**
 * A replacement for a single `electron.<api>.<fn>` main-process method, returned
 * by `browser.electron.mock()`. Records every call, returns a scripted value, and
 * restores the original method on `restore()` or `browser.quit()`.
 *
 * This is the general primitive behind the typed `mockDialog()` convenience: use
 * it for any `electron` module method (`app.getPath`, `shell.openExternal`,
 * `safeStorage.encryptString`, …) whose real behavior you want to replace during a
 * test.
 */
export interface ElectronMock {
  /** The `electron` module namespace, e.g. `'app'`, `'shell'`, `'dialog'`. */
  readonly api: string;
  /** The method name on that namespace, e.g. `'getPath'`, `'openExternal'`. */
  readonly fn: string;
  /** Every recorded call, oldest first. Args are JSON-safe copies. */
  getCalls(): Promise<ElectronMockCall[]>;
  /** How many times the mocked method was called. */
  getCallCount(): Promise<number>;
  /** Re-script the value the mocked method returns from now on. */
  mockReturnValue(value: unknown): Promise<void>;
  /** Clear recorded calls without changing the scripted return value. */
  clearCalls(): Promise<void>;
  /** Restore the original method. Safe to call more than once. */
  restore(): Promise<void>;
}

/** Symbol under which every active mock's state lives in the main process. */
const REGISTRY_SYMBOL_KEY = 'craftdriver.electron.apiMocks';

/** Internal implementation; users receive the public {@link ElectronMock} interface. */
export class ElectronMockHandle implements ElectronMock {
  readonly api: string;
  readonly fn: string;
  readonly #key: string;
  readonly #id: string;
  readonly #executor: MainExecutor;
  readonly #onRestore: () => void;
  #restored = false;

  constructor(
    executor: MainExecutor,
    api: string,
    fn: string,
    id: string,
    onRestore: () => void
  ) {
    this.#executor = executor;
    this.api = api;
    this.fn = fn;
    this.#key = `${api}.${fn}`;
    this.#id = id;
    this.#onRestore = onRestore;
  }

  async getCalls(): Promise<ElectronMockCall[]> {
    this.#assertActive();
    return this.#executor.executeMain(
      (_electron, registryKey, entryKey, id) => {
        const key = Symbol.for(registryKey as string);
        const registry = (globalThis as unknown as Record<PropertyKey, unknown>)[key] as
          | Record<string, { id: string; calls: ElectronMockCall[] }>
          | undefined;
        const entry = registry?.[entryKey as string];
        if (!entry || entry.id !== id)
          throw new Error(`Mock ${entryKey} is no longer active.`);
        return entry.calls;
      },
      REGISTRY_SYMBOL_KEY,
      this.#key,
      this.#id
    );
  }

  async getCallCount(): Promise<number> {
    return (await this.getCalls()).length;
  }

  async mockReturnValue(value: unknown): Promise<void> {
    this.#assertActive();
    // `value` rides across the wire as an executeMain arg (validated JSON-safe there).
    // `undefined` can't cross that validation, so carry a presence flag and let the
    // callback restore undefined — makes mockReturnValue(undefined) work too.
    const hasValue = value !== undefined;
    await this.#executor.executeMain(
      (_electron, registryKey, entryKey, id, present, next) => {
        const key = Symbol.for(registryKey as string);
        const registry = (globalThis as unknown as Record<PropertyKey, unknown>)[key] as
          | Record<string, { id: string; result: unknown }>
          | undefined;
        const entry = registry?.[entryKey as string];
        if (!entry || entry.id !== id)
          throw new Error(`Mock ${entryKey} is no longer active.`);
        entry.result = present ? next : undefined;
      },
      REGISTRY_SYMBOL_KEY,
      this.#key,
      this.#id,
      hasValue,
      hasValue ? value : null
    );
  }

  async clearCalls(): Promise<void> {
    this.#assertActive();
    await this.#executor.executeMain(
      (_electron, registryKey, entryKey, id) => {
        const key = Symbol.for(registryKey as string);
        const registry = (globalThis as unknown as Record<PropertyKey, unknown>)[key] as
          | Record<string, { id: string; calls: ElectronMockCall[] }>
          | undefined;
        const entry = registry?.[entryKey as string];
        if (!entry || entry.id !== id)
          throw new Error(`Mock ${entryKey} is no longer active.`);
        entry.calls.length = 0;
      },
      REGISTRY_SYMBOL_KEY,
      this.#key,
      this.#id
    );
  }

  async restore(): Promise<void> {
    if (this.#restored) return;
    await this.#executor.executeMain(
      (electron, registryKey, apiName, funcName, id) => {
        const entryKey = `${apiName as string}.${funcName as string}`;
        const key = Symbol.for(registryKey as string);
        const registry = (globalThis as unknown as Record<PropertyKey, unknown>)[key] as
          | Record<
              string,
              { id: string; original: (...args: unknown[]) => unknown; replacement: unknown }
            >
          | undefined;
        const entry = registry?.[entryKey];
        if (!entry || entry.id !== id) return;
        const api = (electron as Record<string, Record<string, unknown>>)[apiName as string];
        if (api && api[funcName as string] === entry.replacement)
          api[funcName as string] = entry.original;
        delete registry![entryKey];
      },
      REGISTRY_SYMBOL_KEY,
      this.api,
      this.fn,
      this.#id
    );
    this.#restored = true;
    this.#onRestore();
  }

  #assertActive(): void {
    if (this.#restored) {
      throw new CraftdriverError(
        ErrorCode.STATE_INVALID,
        `The electron.${this.#key} mock has already been restored.`
      );
    }
  }
}

/** Reject obviously wrong `api`/`fn` before touching the main process. */
export function validateMockTarget(api: string, fn: string): void {
  if (typeof api !== 'string' || api.length === 0) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      'electron.mock(api, fn): api must be a non-empty string (e.g. "app", "shell", "dialog").'
    );
  }
  if (typeof fn !== 'string' || fn.length === 0) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `electron.mock('${api}', fn): fn must be a non-empty string (e.g. "getPath", "openExternal").`
    );
  }
}

/** The `Symbol.for` key string, exported so {@link ElectronRemote} can install the registry. */
export const ELECTRON_MOCK_REGISTRY_KEY = REGISTRY_SYMBOL_KEY;
