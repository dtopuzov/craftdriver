/**
 * One batch of already-known commands, run in one dispatcher trip.
 *
 * Measured motivation: five operations against a warm daemon cost 2.05 s as
 * five `craftdriver` invocations and ~0.45 s in one process, of which 256 ms
 * is browser work. The rest is Node boot and module load, repeated per
 * command. A batch pays that once.
 *
 * This module owns the *contract*, not a second implementation of anything:
 * a step is an ordinary dispatcher command, so a batch adds no execution
 * surface that a single command does not already have. There is deliberately
 * no equivalent of Playwright's `browser_run_code_unsafe` here — nothing in a
 * batch reaches the driver process.
 *
 * The properties that keep a batch from collapsing the evidence along with the
 * round trips live in {@link AgentSession.runBatch}: one session queue slot,
 * stop at the first failure, per-step ok/duration, one final observation, and
 * no retry or substitution of a selector — ever.
 */
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import { boundValue, truncateUtf8, utf8Bytes } from './bounds.js';
import { formatLogTripwire, type LogTripwire } from './journal.js';

/** One command in a batch, already parsed and validated by its surface. */
export interface BatchStep {
  cmd: string;
  args: Record<string, unknown>;
}

export interface BatchRequest {
  steps: BatchStep[];
  /**
   * Run the remaining steps after one fails. Off by default, for the reason
   * `--ephemeral` stops: a script whose third step failed has left the page in
   * a state the fourth was never written for, and the output then reads like
   * an application answer rather than the selector failure it is.
   */
  continueOnError?: boolean;
  /** The one post-batch observation, if any. Never one per step. */
  observe?: 'page' | 'delta';
  /**
   * Treat a command that answered "no" as a failed step — `exists` matching
   * nothing, a failed `a11y --check`.
   *
   * Set by the CLI, where those two are documented to exit 1 and a script is
   * documented to stop at the first command that fails; without it the same
   * script passed as a batch and failed as an `--ephemeral` run. Left off for
   * MCP, where a read is documented to answer rather than fail and
   * `browser_expect` is the tool that returns a verdict.
   */
  stopOnVerdict?: boolean;
}

/** The wire shape `toWireError` produces; repeated here to avoid a cycle. */
export interface BatchStepError {
  code: string;
  message: string;
  hint?: string;
  detail?: Record<string, unknown>;
  recoverySnapshot?: string;
}

export interface BatchStepResult {
  /** Zero-based position in the submitted step list. */
  index: number;
  cmd: string;
  ok: boolean;
  durationMs: number;
  result?: unknown;
  error?: BatchStepError;
  /** The result or the error was shortened to keep the batch within budget. */
  truncated?: true;
}

export interface BatchPageInfo {
  url: string;
  title: string;
  documentId: string;
  revision: number;
  documentChange: 'unknown' | 'same' | 'changed';
}

export interface BatchOutcome {
  /** True only when every submitted step ran and succeeded. */
  ok: boolean;
  steps: BatchStepResult[];
  ran: number;
  /** Steps never attempted because an earlier one failed. */
  skipped: number;
  /** Index of the first failure, when there was one. */
  failedStep?: number;
  /** The single observation, when one was requested and taken. */
  delta?: string;
  page?: BatchPageInfo;
  /**
   * Whether any step made the application log an error, and the cursor that
   * reads them. Present whenever an observation was requested — a batch that
   * skipped its snapshot still answers this, because it costs no round trip.
   */
  logs?: LogTripwire;
}

/**
 * Upper bound on steps in one batch.
 *
 * A batch is for operations the caller already knows; past a couple of dozen
 * it is a script, and a script that cannot be interrupted for a look at the
 * page is the failure mode batching is supposed to avoid.
 */
export const MAX_BATCH_STEPS = 25;

/** Cap on one step's result, so a `snapshot` mid-batch cannot dominate. */
export const MAX_STEP_RESULT_BYTES = 8 * 1024;

/**
 * Cap on the per-step payloads of the whole batch — results *and* errors.
 *
 * Below the daemon's 1 MiB frame limit on purpose: an oversized frame is
 * replaced wholesale with an error, which would discard the batch *after* its
 * browser work was done. Trimming late payloads keeps every step's ok/duration
 * and the failure's code and message, which is the part an agent cannot
 * reconstruct.
 */
export const MAX_BATCH_RESULT_BYTES = 32 * 1024;

/**
 * Room always left for a failure, however little budget is left.
 *
 * A step that failed with no readable reason is worse than a truncated one:
 * the code and the first part of the message are what an agent acts on. This
 * is the one thing allowed past the budget, which is what makes
 * {@link MAX_BATCH_FRAME_BYTES} larger than {@link MAX_BATCH_RESULT_BYTES}.
 */
const MIN_ERROR_BYTES = 512;

/**
 * Longest command name a step may carry.
 *
 * Command names are short words; the cap exists because `cmd` is echoed back
 * in every step result, so an untrusted socket peer could otherwise make the
 * *response* enormous with names the dispatcher would only reject.
 */
export const MAX_STEP_CMD_CHARS = 64;

/**
 * Worst-case serialized cost of `index`, `cmd`, `ok`, `durationMs` and the
 * JSON around them. `cmd` is measured at its escape-worst — a control
 * character costs six bytes as `\u00XX` — because the ceiling below has to
 * hold for input nobody friendly wrote.
 */
const STEP_ENVELOPE_BYTES = MAX_STEP_CMD_CHARS * 6 + 96;

/**
 * The real ceiling on the steps of a rendered batch: the budget, plus the
 * floor every step keeps even after the budget is gone.
 *
 * Measured against *serialized* bytes throughout, which is the only figure the
 * daemon's frame limit cares about — a message of quotes costs two bytes per
 * character on the wire, and a bound computed on raw text is therefore not a
 * bound at all. An order of magnitude under the 1 MiB frame limit, which is
 * the property that matters: a batch must never be discarded after it has run.
 */
export const MAX_BATCH_FRAME_BYTES =
  MAX_BATCH_RESULT_BYTES + MAX_BATCH_STEPS * (MIN_ERROR_BYTES + STEP_ENVELOPE_BYTES);

/**
 * Commands that cannot be a batch step, and why.
 *
 * Named rather than derived from the dispatcher's command list: the dispatcher
 * already rejects anything it does not implement, so the only interesting set
 * is the one that would dispatch fine and still be wrong.
 */
const NOT_BATCHABLE: Record<string, string> = {
  quit: 'it closes the browser the remaining steps need',
  run: 'a batch cannot contain a batch',
  init: 'it installs project files and never touches the browser',
  mcp: 'it starts a server',
};

/** Reject a step that must not run inside a batch. Returns the reason, or null. */
export function batchRejection(cmd: string): string | null {
  if (NOT_BATCHABLE[cmd]) return NOT_BATCHABLE[cmd];
  // `daemon:*` and `session:*` address the daemon or the registry, not the
  // session's browser; the daemon answers them without a queue slot at all.
  if (cmd.includes(':')) return 'it addresses the daemon rather than the page';
  if (cmd.startsWith('__')) return 'it is not a command';
  return null;
}

/**
 * Validate an untrusted step list — a socket peer or MCP client, not the CLI.
 *
 * Throws `INVALID_ARGUMENT` before any browser work, so a malformed batch
 * costs nothing.
 */
export function validateBatchSteps(raw: unknown): BatchStep[] {
  if (!Array.isArray(raw)) {
    throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, 'batch: steps must be an array');
  }
  if (raw.length === 0) {
    throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, 'batch: no steps to run');
  }
  if (raw.length > MAX_BATCH_STEPS) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `batch: too many steps (${raw.length}; max ${MAX_BATCH_STEPS})`,
      { hint: 'split the flow, and look at the page between the halves' }
    );
  }
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `batch: step ${index + 1} must be an object`
      );
    }
    const step = entry as { cmd?: unknown; args?: unknown };
    if (typeof step.cmd !== 'string' || step.cmd.length === 0) {
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `batch: step ${index + 1} is missing "cmd"`
      );
    }
    // Every step echoes its `cmd` back. Without a cap, a peer that only ever
    // gets `unknown command` back can still choose the size of the response.
    if (step.cmd.length > MAX_STEP_CMD_CHARS) {
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `batch: step ${index + 1} "cmd" is ${step.cmd.length} characters ` +
          `(max ${MAX_STEP_CMD_CHARS}); command names are single words`
      );
    }
    const reason = batchRejection(step.cmd);
    if (reason) {
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `batch: "${step.cmd}" cannot run inside a batch — ${reason}`
      );
    }
    if (step.args !== undefined && (typeof step.args !== 'object' || step.args === null)) {
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `batch: step ${index + 1} "args" must be an object`
      );
    }
    return { cmd: step.cmd, args: (step.args as Record<string, unknown> | undefined) ?? {} };
  });
}

/** Normalize an untrusted observation request. */
export function validateBatchObserve(raw: unknown): 'page' | 'delta' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw !== 'page' && raw !== 'delta') {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `batch: observe must be "page" or "delta", got ${JSON.stringify(raw)}`
    );
  }
  return raw;
}

/**
 * Trim step results to the batch budget, in place of the caller's array.
 *
 * Earlier steps keep their results; later ones lose the value but never the
 * `ok`, `durationMs` or the failure's `code` and message — those are what the
 * agent cannot reconstruct from the page, and they are small.
 *
 * Errors are trimmed as well as results, and are not a rounding error: one
 * failure can carry a 12 KiB recovery snapshot plus a bounded message, hint
 * and detail, so `--continue-on-error` over 25 failing steps could otherwise
 * build a response an order of magnitude past this budget — and past the
 * daemon's frame limit, which discards the whole batch *after* its browser
 * work is done. The earliest failures get first call on the budget, which is
 * usually the only one there is; a single error large enough to exhaust the
 * budget on its own is trimmed like any other.
 *
 * Every measurement here is of serialized bytes. Raw text is not a bound on
 * the frame: a message of quotes doubles when it is JSON-encoded, and control
 * characters sextuple.
 */
export function boundBatchSteps(steps: BatchStepResult[]): BatchStepResult[] {
  let used = 0;
  return steps.map((step) => {
    used += serializedBytes({
      index: step.index,
      cmd: step.cmd,
      ok: step.ok,
      durationMs: step.durationMs,
      truncated: true,
    });
    let out = step;
    if (step.error) {
      const bounded = boundStepError(step.error, MAX_BATCH_RESULT_BYTES - used);
      used += bounded.bytes;
      if (bounded.error !== step.error) {
        out = { ...step, error: bounded.error, truncated: true as const };
      }
    }
    if (out.result === undefined) return out;

    const bounded = boundValue(out.result, MAX_STEP_RESULT_BYTES);
    const shortened = bounded !== out.result;
    const size = serializedBytes(bounded);
    if (used + size > MAX_BATCH_RESULT_BYTES) {
      used = MAX_BATCH_RESULT_BYTES;
      return {
        ...out,
        result: `(result omitted — batch exceeded ${MAX_BATCH_RESULT_BYTES} bytes)`,
        truncated: true as const,
      };
    }
    used += size;
    return shortened ? { ...out, result: bounded, truncated: true as const } : out;
  });
}

/**
 * Fit one step error into `budget`, dropping the parts an agent misses least
 * first: the recovery snapshot (largest, and only useful for the failure the
 * caller is about to retry), then the detail, then the hint.
 */
function boundStepError(
  error: BatchStepError,
  budget: number
): { error: BatchStepError; bytes: number } {
  const { recoverySnapshot: _snap, detail: _detail, hint: _hint, ...bare } = error;
  const candidates: BatchStepError[] = [
    error,
    { ...bare, ...(error.hint ? { hint: error.hint } : {}), ...(error.detail ? { detail: error.detail } : {}) },
    { ...bare, ...(error.hint ? { hint: error.hint } : {}) },
    bare,
  ];
  for (const candidate of candidates) {
    const bytes = serializedBytes(candidate);
    if (bytes <= budget) return { error: candidate, bytes };
  }
  // Even the bare error does not fit. Keep the code and as much of the message
  // as the floor allows — a failure an agent cannot read is worse than a
  // truncated one — and let that floor be the single thing allowed past the
  // budget, which is what `MAX_BATCH_FRAME_BYTES` accounts for.
  const target = Math.max(MIN_ERROR_BYTES, budget);
  const truncatedError = {
    ...bare,
    message: shrinkToSerialized(error.message, target - serializedBytes({ ...bare, message: '…' })),
  };
  return { error: truncatedError, bytes: serializedBytes(truncatedError) };
}

/**
 * Longest prefix of `text` whose *serialized* form fits `maxBytes`.
 *
 * `truncateUtf8` bounds raw UTF-8, which JSON encoding can multiply by six, so
 * it cannot be the last word on a wire budget. Searched on the character count
 * rather than scaled from the overshoot: the two are not proportional — a
 * prefix already shorter than the raw budget does not shrink when the budget
 * is nudged — and a search that stalls silently returns nothing at all, which
 * is how a 32 KiB error message became an ellipsis.
 *
 * Cuts land on code points, so a surrogate pair is never split.
 */
function shrinkToSerialized(text: string, maxBytes: number): string {
  const marker = '…';
  if (serializedBytes(marker) > maxBytes) return '';
  const chars = [...text];
  let kept = 0;
  let high = chars.length;
  while (kept < high) {
    const mid = Math.ceil((kept + high) / 2);
    if (serializedBytes(chars.slice(0, mid).join('') + marker) <= maxBytes) kept = mid;
    else high = mid - 1;
  }
  return chars.slice(0, kept).join('') + marker;
}

function serializedBytes(value: unknown): number {
  return utf8Bytes(safeSerialize(value));
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** One line per step, for the CLI's pretty mode and the MCP text block. */
export function renderBatchOutcome(outcome: BatchOutcome): string {
  const width = String(outcome.steps.length).length;
  const lines = outcome.steps.map((step) => {
    const number = String(step.index + 1).padStart(width);
    const mark = step.ok ? '✓' : '✗';
    const head = `${number} ${mark} ${step.cmd}  ${step.durationMs}ms`;
    if (step.ok) {
      const summary = summarizeStepResult(step.result);
      return summary ? `${head}  ${summary}` : head;
    }
    const error = step.error;
    return [
      head,
      `    error: ${error?.message ?? 'failed'}`,
      `    code:  ${error?.code ?? ErrorCode.DRIVER_ERROR}`,
      ...(error?.hint ? [`    hint:  ${error.hint}`] : []),
    ].join('\n');
  });

  if (outcome.skipped > 0) {
    // Out of everything *submitted*, not out of what ran — `steps` holds only
    // the ones that got as far as executing, so counting them made a batch of
    // five that stopped at two report "step 2 of 2".
    const submitted = outcome.ran + outcome.skipped;
    lines.push(
      `stopped at step ${(outcome.failedStep ?? 0) + 1} of ${submitted}; ` +
        `${outcome.skipped} later ${outcome.skipped === 1 ? 'step' : 'steps'} not run`
    );
  }
  if (outcome.delta) lines.push('', outcome.delta);
  if (outcome.page) lines.push('', `page: ${outcome.page.title} — ${outcome.page.url}`);
  if (outcome.logs) lines.push(formatLogTripwire(outcome.logs));
  if (outcome.steps.find((s) => !s.ok)?.error?.recoverySnapshot) {
    lines.push('', 'recovery snapshot:', outcome.steps.find((s) => !s.ok)!.error!.recoverySnapshot!);
  }
  return lines.join('\n');
}

/** A short, one-line trace of what a step returned. Never the whole value. */
function summarizeStepResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  const text = typeof result === 'string' ? result : safeSerialize(result);
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 80 ? oneLine : truncateUtf8(oneLine, 77) + '…';
}
