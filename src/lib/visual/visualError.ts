/**
 * Typed failure for a visual assertion.
 *
 * JavaScript cannot both throw and return a normal value, so the final actual
 * screenshot and generated diff PNG travel on the error as `Buffer`
 * properties, while a JSON-serializable summary lives in `detail` for agents.
 */

import { CraftdriverError, ErrorCode } from '../errors.js';
import type { VisualComparisonResult } from './types.js';

export interface VisualMismatchInfo {
  expectedPath: string;
  timeout: number;
  attempts: number;
  elapsedMs: number;
  comparison: VisualComparisonResult;
}

function buildMessage(info: VisualMismatchInfo): string {
  const { comparison, timeout, attempts } = info;
  if (comparison.dimensionMismatch) {
    return (
      `Screenshot did not match after ${timeout} ms: dimensions differ ` +
      `(expected ${comparison.expectedWidth}x${comparison.expectedHeight}, ` +
      `actual ${comparison.actualWidth}x${comparison.actualHeight}) across ${attempts} attempts`
    );
  }
  const pixels = comparison.diffPixels.toLocaleString('en-US');
  const pct = comparison.diffPercentage.toFixed(4);
  return `Screenshot did not match after ${timeout} ms: ${pixels} pixels differed (${pct}%) across ${attempts} attempts`;
}

/**
 * Thrown by `browser.expectScreenshot()` when no screenshot matched the
 * baseline before the timeout. Carries the final actual and diff PNG buffers
 * plus the comparison summary; `code` is `VISUAL_MISMATCH`.
 */
export class VisualMismatchError extends CraftdriverError {
  /** Final browser screenshot (compressed PNG). */
  readonly actual: Buffer;
  /** Final generated diff (compressed PNG). */
  readonly diff: Buffer;
  readonly comparison: VisualComparisonResult;
  readonly attempts: number;
  readonly elapsedMs: number;

  constructor(actual: Buffer, diff: Buffer, info: VisualMismatchInfo) {
    super(ErrorCode.VISUAL_MISMATCH, buildMessage(info), {
      detail: {
        expectedPath: info.expectedPath,
        timeout: info.timeout,
        attempts: info.attempts,
        elapsedMs: info.elapsedMs,
        diffPixels: info.comparison.diffPixels,
        diffPercentage: info.comparison.diffPercentage,
        ignoredAntialiasPixels: info.comparison.ignoredAntialiasPixels,
        expectedWidth: info.comparison.expectedWidth,
        expectedHeight: info.comparison.expectedHeight,
        actualWidth: info.comparison.actualWidth,
        actualHeight: info.comparison.actualHeight,
        dimensionMismatch: info.comparison.dimensionMismatch,
      },
      hint: 'Inspect error.actual and error.diff (PNG buffers) to see the regression. If the change is intentional, re-run with CRAFTDRIVER_UPDATE_VISUAL_BASELINES=true to overwrite the baseline.',
    });
    this.name = 'VisualMismatchError';
    this.actual = actual;
    this.diff = diff;
    this.comparison = info.comparison;
    this.attempts = info.attempts;
    this.elapsedMs = info.elapsedMs;
  }
}
