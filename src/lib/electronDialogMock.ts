import { CraftdriverError, ErrorCode } from './errors.js';

export type ElectronDialogMethod = 'showOpenDialog' | 'showSaveDialog' | 'showMessageBox';

/** Scripted result for Electron's asynchronous `dialog.showOpenDialog()`. */
export interface ElectronOpenDialogResult {
  canceled: boolean;
  filePaths: string[];
  bookmarks?: string[];
}

/** Scripted result for Electron's asynchronous `dialog.showSaveDialog()`. */
export interface ElectronSaveDialogResult {
  canceled: boolean;
  filePath: string;
  bookmark?: string;
}

/** Scripted result for Electron's asynchronous `dialog.showMessageBox()`. */
export interface ElectronMessageBoxResult {
  response: number;
  checkboxChecked: boolean;
}

export type ElectronDialogResult =
  | ElectronOpenDialogResult
  | ElectronSaveDialogResult
  | ElectronMessageBoxResult;

/** One native-dialog invocation. `options` excludes the optional parent window. */
export interface ElectronDialogCall {
  options: unknown;
}

interface MainExecutor {
  executeMain<T = unknown>(
    fn: (electron: unknown, ...args: unknown[]) => T | Promise<T>,
    ...args: unknown[]
  ): Promise<T>;
}

/** A native-dialog replacement returned by `browser.electron.mockDialog()`. */
export interface ElectronDialogMock {
  readonly method: ElectronDialogMethod;
  getCalls(): Promise<ElectronDialogCall[]>;
  getCallCount(): Promise<number>;
  clearCalls(): Promise<void>;
  restore(): Promise<void>;
}

/** Internal implementation; users receive the public interface above. */
export class ElectronDialogMockHandle implements ElectronDialogMock {
  readonly method: ElectronDialogMethod;
  readonly #id: string;
  readonly #executor: MainExecutor;
  readonly #onRestore: () => void;
  #restored = false;

  constructor(
    executor: MainExecutor,
    method: ElectronDialogMethod,
    id: string,
    onRestore: () => void
  ) {
    this.#executor = executor;
    this.method = method;
    this.#id = id;
    this.#onRestore = onRestore;
  }

  /** Return the JSON-safe options received by every call. */
  async getCalls(): Promise<ElectronDialogCall[]> {
    this.#assertActive();
    return this.#executor.executeMain(
      (_electron, method, id) => {
        const methodName = method as string;
        const mockId = id as string;
        const key = Symbol.for('craftdriver.electron.dialogMocks');
        const registry = (globalThis as unknown as Record<PropertyKey, unknown>)[key] as
          | Record<string, { id: string; calls: ElectronDialogCall[] }>
          | undefined;
        const entry = registry?.[methodName];
        if (!entry || entry.id !== mockId)
          throw new Error(`Dialog mock ${methodName} is no longer active.`);
        return entry.calls;
      },
      this.method,
      this.#id
    );
  }

  /** Return how many times the mocked dialog was called. */
  async getCallCount(): Promise<number> {
    return (await this.getCalls()).length;
  }

  /** Clear recorded calls without changing the scripted result. */
  async clearCalls(): Promise<void> {
    this.#assertActive();
    await this.#executor.executeMain(
      (_electron, method, id) => {
        const methodName = method as string;
        const mockId = id as string;
        const key = Symbol.for('craftdriver.electron.dialogMocks');
        const registry = (globalThis as unknown as Record<PropertyKey, unknown>)[key] as
          | Record<string, { id: string; calls: ElectronDialogCall[] }>
          | undefined;
        const entry = registry?.[methodName];
        if (!entry || entry.id !== mockId)
          throw new Error(`Dialog mock ${methodName} is no longer active.`);
        entry.calls.length = 0;
      },
      this.method,
      this.#id
    );
  }

  /** Restore Electron's original dialog function. Safe to call more than once. */
  async restore(): Promise<void> {
    if (this.#restored) return;
    await this.#executor.executeMain(
      (electron, method, id) => {
        const methodName = method as string;
        const mockId = id as string;
        const key = Symbol.for('craftdriver.electron.dialogMocks');
        const registry = (globalThis as unknown as Record<PropertyKey, unknown>)[key] as
          | Record<
              string,
              { id: string; original: (...args: unknown[]) => unknown; replacement: unknown }
            >
          | undefined;
        const entry = registry?.[methodName];
        if (!entry || entry.id !== mockId) return;
        const dialog = (electron as { dialog: Record<string, unknown> }).dialog;
        if (dialog[methodName] === entry.replacement) dialog[methodName] = entry.original;
        delete registry![methodName];
      },
      this.method,
      this.#id
    );
    this.#restored = true;
    this.#onRestore();
  }

  #assertActive(): void {
    if (this.#restored) {
      throw new CraftdriverError(
        ErrorCode.STATE_INVALID,
        `The ${this.method} dialog mock has already been restored.`
      );
    }
  }
}

export function validateDialogResult(
  method: ElectronDialogMethod,
  result: ElectronDialogResult
): void {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw invalidResult(method, 'result must be an object');
  }

  if (method === 'showOpenDialog') {
    const value = result as ElectronOpenDialogResult;
    if (
      typeof value.canceled !== 'boolean' ||
      !Array.isArray(value.filePaths) ||
      !value.filePaths.every((path) => typeof path === 'string') ||
      (value.bookmarks !== undefined &&
        (!Array.isArray(value.bookmarks) ||
          !value.bookmarks.every((bookmark) => typeof bookmark === 'string')))
    ) {
      throw invalidResult(method, 'expected { canceled: boolean, filePaths: string[] }');
    }
    return;
  }

  if (method === 'showSaveDialog') {
    const value = result as ElectronSaveDialogResult;
    if (
      typeof value.canceled !== 'boolean' ||
      typeof value.filePath !== 'string' ||
      (value.bookmark !== undefined && typeof value.bookmark !== 'string')
    ) {
      throw invalidResult(method, 'expected { canceled: boolean, filePath: string }');
    }
    return;
  }

  const value = result as ElectronMessageBoxResult;
  if (!Number.isInteger(value.response) || typeof value.checkboxChecked !== 'boolean') {
    throw invalidResult(method, 'expected { response: integer, checkboxChecked: boolean }');
  }
}

function invalidResult(method: ElectronDialogMethod, expected: string): CraftdriverError {
  return new CraftdriverError(
    ErrorCode.INVALID_ARGUMENT,
    `Invalid result for electron.mockDialog('${method}', result): ${expected}.`,
    { detail: { method } }
  );
}
