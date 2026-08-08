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
  /** The result was shortened to keep the batch within its byte budget. */
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
 * Cap on the results of the whole batch.
 *
 * Below the daemon's 1 MiB frame limit on purpose: an oversized frame is
 * replaced wholesale with an error, which would discard the batch *after* its
 * browser work was done. Trimming late results keeps every step's ok/duration
 * and the failure, which is the part an agent cannot reconstruct.
 */
export const MAX_BATCH_RESULT_BYTES = 32 * 1024;

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
 * `ok`, `durationMs` or `error` — those are what the agent cannot reconstruct
 * from the page, and they are small.
 */
export function boundBatchSteps(steps: BatchStepResult[]): BatchStepResult[] {
  let used = 0;
  return steps.map((step) => {
    if (step.error) used += utf8Bytes(safeSerialize(step.error));
    if (step.result === undefined) return step;

    const bounded = boundValue(step.result, MAX_STEP_RESULT_BYTES);
    const shortened = bounded !== step.result;
    const size = utf8Bytes(safeSerialize(bounded));
    if (used + size > MAX_BATCH_RESULT_BYTES) {
      used = MAX_BATCH_RESULT_BYTES;
      return {
        ...step,
        result: `(result omitted — batch exceeded ${MAX_BATCH_RESULT_BYTES} bytes)`,
        truncated: true as const,
      };
    }
    used += size;
    return shortened ? { ...step, result: bounded, truncated: true as const } : step;
  });
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
    lines.push(
      `stopped at step ${(outcome.failedStep ?? 0) + 1} of ${outcome.steps.length}; ` +
        `${outcome.skipped} later ${outcome.skipped === 1 ? 'step' : 'steps'} not run`
    );
  }
  if (outcome.delta) lines.push('', outcome.delta);
  if (outcome.page) lines.push('', `page: ${outcome.page.title} — ${outcome.page.url}`);
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
