/**
 * Stable, machine-readable error codes for the public craftdriver API.
 *
 * Agents (CLI, MCP, in-process recovery loops) match on `code`, not on
 * prose. Every public throw site should produce a `CraftdriverError`
 * carrying one of these codes plus optional `detail`.
 *
 * Codes are documented in [docs/error-codes.md](../../docs/error-codes.md).
 * Never repurpose a code; add a new one instead.
 */
export const ErrorCode = {
  /** Selector matched zero elements at t=0. Fix the selector. */
  NO_MATCH: 'NO_MATCH',
  /** Selector matched, but element never became visible within timeout. */
  TIMEOUT_WAITING_VISIBLE: 'TIMEOUT_WAITING_VISIBLE',
  /** Element visible, but never reached requested state (enabled, checked, attached/detached, hidden). */
  TIMEOUT_WAITING_STATE: 'TIMEOUT_WAITING_STATE',
  /** Page never reached the requested load state within timeout. */
  TIMEOUT_WAITING_LOAD: 'TIMEOUT_WAITING_LOAD',
  /** Network idle / specific request / response not seen within timeout. */
  TIMEOUT_WAITING_NETWORK: 'TIMEOUT_WAITING_NETWORK',
  /** Dialog of the requested type did not appear within timeout. */
  TIMEOUT_WAITING_DIALOG: 'TIMEOUT_WAITING_DIALOG',
  /** Generic timeout where no more specific code applies. */
  TIMEOUT: 'TIMEOUT',
  /** An `expect(...)` assertion failed after auto-waiting. */
  EXPECT_MISMATCH: 'EXPECT_MISMATCH',
  /** Accessibility audit returned one or more violations. */
  A11Y_VIOLATIONS: 'A11Y_VIOLATIONS',
  /** evaluate() callback threw inside the page. */
  EVAL_THREW: 'EVAL_THREW',
  /** Argument passed to evaluate() / addInitScript() was not JSON-serializable. */
  EVAL_BAD_ARG: 'EVAL_BAD_ARG',
  /** Caller passed an invalid argument (bad enum value, wrong shape, etc.). */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  /** Feature exists but is not available on this browser/transport (e.g. Chromium-only over Firefox). */
  UNSUPPORTED: 'UNSUPPORTED',
  /** Method called in an invalid state (e.g. `clock.tick()` before `install()`). */
  STATE_INVALID: 'STATE_INVALID',
  /** Driver-level / transport-level failure surfaced to the caller. */
  DRIVER_ERROR: 'DRIVER_ERROR',
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;
export type ErrorCodeValue = (typeof ErrorCode)[ErrorCodeName];

export interface CraftdriverErrorOptions {
  /** Structured, JSON-serializable context for agents. */
  detail?: Record<string, unknown>;
  /** Optional underlying cause (preserved as `error.cause`). */
  cause?: unknown;
  /** Optional one-line remediation hint shown after the message. */
  hint?: string;
}

/**
 * Base class for every error thrown from the public API.
 *
 * - `code` is the stable machine identifier (see `ErrorCode`).
 * - `detail` is a JSON-serializable object with structured context
 *   (selector, timeout, candidates, etc.). Agents read this directly.
 * - `hint` is a one-line remediation suggestion. Optional.
 *
 * `instanceof Error` remains `true`; existing catch sites keep working.
 */
export class CraftdriverError extends Error {
  readonly code: ErrorCodeValue;
  readonly detail?: Record<string, unknown>;
  readonly hint?: string;

  constructor(code: ErrorCodeValue, message: string, options?: CraftdriverErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'CraftdriverError';
    this.code = code;
    if (options?.detail) this.detail = options.detail;
    if (options?.hint) this.hint = options.hint;
  }

  /** Type guard: does this error carry the given code? */
  static is(err: unknown, code?: ErrorCodeValue): err is CraftdriverError {
    if (!(err instanceof CraftdriverError)) return false;
    return code === undefined || err.code === code;
  }
}

type CapturedStack = { stack?: string };

function captureStack(callerFn: Function): CapturedStack {
  const captured: CapturedStack = {};
  if (Error.captureStackTrace) {
    Error.captureStackTrace(captured, callerFn);
  } else {
    captured.stack = new Error().stack;
  }
  return captured;
}

function applyCapturedStack(err: unknown, captured: CapturedStack): void {
  if (!(err instanceof Error) || !captured.stack) return;

  const frames = captured.stack.split('\n').slice(1);
  err.stack = [`${err.name}: ${err.message}`, ...frames].join('\n');
}

export async function withApiCallStack<T>(
  callerFn: Function,
  action: () => Promise<T>
): Promise<T> {
  const captured = captureStack(callerFn);
  try {
    return await action();
  } catch (err) {
    applyCapturedStack(err, captured);
    throw err;
  }
}
