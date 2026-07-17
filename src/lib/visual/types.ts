/**
 * Public and internal types for visual screenshot assertions.
 *
 * The `(actual, expected)` argument order is used consistently across every
 * public and internal helper (`compareScreenshots`, `compareDecoded`,
 * `createDiff`). Both buffers share a type, so reversing the order would be a
 * silent bug — never deviate from it.
 */

import type { By } from '../by.js';

/**
 * Default upper bound on decoded image size, in pixels, enforced before RGBA
 * allocation. RGBA is ≥4 bytes/pixel, so expected + actual + final raw diff is
 * ~240 MB of raw arrays at this limit before compressed buffers and pngjs
 * working memory — and parallel assertions multiply that. Raise it explicitly
 * for unusually long full-page screenshots; lower it when many workers run
 * concurrently. A 100M default would permit ≥1.2 GB and is not a real guard.
 */
export const DEFAULT_MAX_IMAGE_PIXELS = 20_000_000;

/** Default upper bound on a compressed PNG input buffer, in bytes (50 MiB). */
export const DEFAULT_MAX_INPUT_BYTES = 50 * 1024 * 1024;

/**
 * Mutually exclusive capture scope forwarded to `browser.screenshot()`.
 * `fullPage` and `selector` cannot be combined (enforced by the union here and
 * re-checked at runtime for JavaScript callers).
 */
export type VisualScreenshotOptions =
  | { fullPage: true; selector?: never }
  | { selector: string | By; fullPage?: false }
  | { fullPage?: false; selector?: never };

/** Policies applied to a single buffer-to-buffer comparison. */
export interface ScreenshotCompareOptions {
  /** Inclusive maximum difference for each visible RGB channel. Integer 0..255. Default: 0. */
  pixelTolerance?: number;

  /** Maximum counted different pixels. Non-negative integer. */
  maxDiffPixels?: number;

  /** Maximum counted different pixels as a percentage of all pixels. 0..100. */
  maxDiffPercentage?: number;

  /** Exclude pixels classified as anti-aliasing from diff totals. Default: false. */
  ignoreAntialiasing?: boolean;

  /** Reject images above this decoded size before allocation. Default: 20 million pixels. */
  maxImagePixels?: number;

  /** Reject compressed PNG input above this size. Default: 50 MiB. */
  maxInputBytes?: number;
}

/** Options for the retrying `browser.expectScreenshot()` assertion. */
export interface ExpectScreenshotOptions extends ScreenshotCompareOptions {
  /** Overall retry time in ms. Defaults to the browser's default timeout (5000 ms). */
  timeout?: number;

  /** Delay between failed attempts in ms. Integer >= 10. Default: 50. */
  interval?: number;

  /** Mutually exclusive capture scope passed to `browser.screenshot()`. */
  screenshot?: VisualScreenshotOptions;
}

/** Result of one buffer-to-buffer comparison. */
export interface VisualComparisonResult {
  matches: boolean;
  diffPixels: number;
  /** Raw, unrounded value in 0..100. */
  diffPercentage: number;
  ignoredAntialiasPixels: number;
  expectedWidth: number;
  expectedHeight: number;
  actualWidth: number;
  actualHeight: number;
  dimensionMismatch: boolean;
}

/** Result of a successful `browser.expectScreenshot()` assertion. */
export interface ScreenshotMatchResult extends VisualComparisonResult {
  attempts: number;
  elapsedMs: number;

  /**
   * How the on-disk baseline was resolved:
   * - `'matched'` — an existing baseline was compared and passed.
   * - `'created'` — no baseline existed; the captured screenshot was written as
   *   the new baseline (always on; the diff fields are zero).
   * - `'updated'` — an existing baseline differed and was overwritten with the
   *   captured screenshot (only under `CRAFTDRIVER_UPDATE_VISUAL_BASELINES=true`;
   *   the diff fields describe state relative to the new baseline, i.e. zero —
   *   the magnitude of the accepted change is reported to stderr).
   */
  baseline: 'matched' | 'created' | 'updated';
}
