/**
 * Commands that succeed and still answer "no".
 *
 * Two commands report their answer through the exit status rather than by
 * throwing: `exists` matching nothing, and `a11y --check` finding violations.
 * Both are documented as exit 1, and both used to be invisible to anything
 * that only watched for a thrown error — so the same script passed through
 * `craftdriver run` and failed through `--ephemeral`.
 *
 * The rule lives here, in one place, because three surfaces need it and they
 * must not drift: the single-command exit code, the `--ephemeral` script, and
 * the `run` batch. It is deliberately *not* applied to MCP: there a read is
 * documented as answering rather than failing, and `browser_expect` is the
 * tool that returns a verdict.
 */
import { ErrorCode, type ErrorCodeValue } from '../lib/errors.js';

export interface NegativeVerdict {
  code: ErrorCodeValue;
  message: string;
  hint?: string;
}

/**
 * The failure a successful command's own result amounts to, or null.
 *
 * Phrased as an error rather than a boolean so a batch can report it in the
 * same shape as a thrown failure: an agent reading a step should not have to
 * learn a second way of being told that a step did not work out.
 */
export function negativeVerdict(cmd: string, result: unknown): NegativeVerdict | null {
  if (cmd === 'exists') {
    const r = result as { exists?: boolean } | null;
    if (!r || r.exists !== false) return null;
    return {
      code: ErrorCode.NO_MATCH,
      message: 'exists: no element matched',
      hint: 'the probe answered no; `--continue-on-error` runs the rest of the script anyway',
    };
  }
  // `a11y` is a report by default, so findings do not make the command fail.
  // `--check` explicitly opts into the assertion-like status while still
  // returning the actionable report.
  if (cmd === 'a11y') {
    const r = result as
      | { checked?: boolean; passed?: boolean; minImpact?: string; counts?: { violations?: number } }
      | null;
    if (!r || r.checked !== true || r.passed !== false) return null;
    const total = r.counts?.violations ?? 0;
    return {
      code: ErrorCode.EXPECT_MISMATCH,
      message:
        `a11y --check: ${total} ${r.minImpact ?? 'serious'}+ ` +
        `violation${total === 1 ? '' : 's'} remain`,
      hint: 'the report is in this step’s result; fix the violations or drop --check',
    };
  }
  return null;
}
