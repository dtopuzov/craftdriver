/**
 * Per-channel comparison and threshold policy over decoded RGBA images.
 *
 * This is small, dependency-free code over fixed-length arrays — deliberately
 * owned rather than delegated, unlike the PNG parser. The same loop both counts
 * differences (normal retries) and, when handed an optional diff output buffer,
 * paints the diagnostic image (final failure only), so the two can never
 * disagree about which pixels differ.
 */

import { CraftdriverError, ErrorCode } from '../errors.js';
import type { DecodedImage } from './codec.js';
import { pngjsCodec } from './pngjsCodec.js';
import { validatePngHeaderAndSize } from './pngHeader.js';
import { isAntialiased } from './antialias.js';
import { blendOverWhite, rgb2y, visibleRgb } from './pixelMath.js';
import {
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_INPUT_BYTES,
  type ScreenshotCompareOptions,
  type VisualComparisonResult,
} from './types.js';

/** Diagnostic diff colours. */
const RED = [255, 0, 0, 255] as const;
const YELLOW = [255, 255, 0, 255] as const;
const MAGENTA = [255, 0, 255, 255] as const;
/** How much of the actual image bleeds through as dimmed grayscale context. */
const GRAY_ALPHA = 0.1;

/** Options after validation and default resolution. */
export interface ResolvedCompareOptions {
  pixelTolerance: number;
  maxDiffPixels: number | undefined;
  maxDiffPercentage: number | undefined;
  ignoreAntialiasing: boolean;
  maxImagePixels: number;
  maxInputBytes: number;
}

function invalid(message: string, detail?: Record<string, unknown>): never {
  throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, message, detail ? { detail } : undefined);
}

function requireInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) invalid(`${name} must be an integer, got ${value}.`, { [name]: value });
}

/** Validate and default the comparison options. Never clamps — bad input throws. */
export function resolveCompareOptions(options: ScreenshotCompareOptions = {}): ResolvedCompareOptions {
  const pixelTolerance = options.pixelTolerance ?? 0;
  requireInteger(pixelTolerance, 'pixelTolerance');
  if (pixelTolerance < 0 || pixelTolerance > 255) {
    invalid(`pixelTolerance must be within 0..255, got ${pixelTolerance}.`, { pixelTolerance });
  }

  let maxDiffPixels: number | undefined;
  if (options.maxDiffPixels !== undefined) {
    requireInteger(options.maxDiffPixels, 'maxDiffPixels');
    if (options.maxDiffPixels < 0) {
      invalid(`maxDiffPixels must be >= 0, got ${options.maxDiffPixels}.`, { maxDiffPixels: options.maxDiffPixels });
    }
    maxDiffPixels = options.maxDiffPixels;
  }

  let maxDiffPercentage: number | undefined;
  if (options.maxDiffPercentage !== undefined) {
    if (!Number.isFinite(options.maxDiffPercentage) || options.maxDiffPercentage < 0 || options.maxDiffPercentage > 100) {
      invalid(`maxDiffPercentage must be within 0..100, got ${options.maxDiffPercentage}.`, {
        maxDiffPercentage: options.maxDiffPercentage,
      });
    }
    maxDiffPercentage = options.maxDiffPercentage;
  }

  const maxImagePixels = options.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS;
  requireInteger(maxImagePixels, 'maxImagePixels');
  if (maxImagePixels < 1) invalid(`maxImagePixels must be >= 1, got ${maxImagePixels}.`, { maxImagePixels });

  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  requireInteger(maxInputBytes, 'maxInputBytes');
  if (maxInputBytes < 1) invalid(`maxInputBytes must be >= 1, got ${maxInputBytes}.`, { maxInputBytes });

  if (options.ignoreAntialiasing !== undefined && typeof options.ignoreAntialiasing !== 'boolean') {
    // A JSON/JavaScript caller passing "false" (a truthy string) must not
    // silently enable AA ignoring and hide regressions.
    invalid(`ignoreAntialiasing must be a boolean, got ${typeof options.ignoreAntialiasing}.`);
  }

  return {
    pixelTolerance,
    maxDiffPixels,
    maxDiffPercentage,
    ignoreAntialiasing: options.ignoreAntialiasing ?? false,
    maxImagePixels,
    maxInputBytes,
  };
}

function draw(output: Uint8Array, pos: number, rgba: readonly number[]): void {
  output[pos] = rgba[0];
  output[pos + 1] = rgba[1];
  output[pos + 2] = rgba[2];
  output[pos + 3] = rgba[3];
}

/** Dimmed grayscale of the actual pixel — context in the diff artifact. */
function drawContext(output: Uint8Array, outPos: number, actual: Uint8Array, srcPos: number): void {
  const a = actual[srcPos + 3];
  const [r, g, b] = [0, 1, 2].map((i) => actual[srcPos + i]);
  const val = blendOverWhite(rgb2y(r, g, b), GRAY_ALPHA * a);
  draw(output, outPos, [val, val, val, 255]);
}

/**
 * Compare two decoded images. Counts `diffPixels` / `ignoredAntialiasPixels`
 * and, when `output` (a union-sized RGBA buffer) is supplied, paints the diff.
 *
 * Argument order is `(actual, expected)` — see the note in `./types`.
 */
export function compareDecoded(
  actual: DecodedImage,
  expected: DecodedImage,
  opts: ResolvedCompareOptions,
  output?: Uint8Array
): VisualComparisonResult {
  const dimensionMismatch = actual.width !== expected.width || actual.height !== expected.height;
  // Diff canvas is the bounding box; both images are anchored at (0, 0).
  const canvasWidth = Math.max(actual.width, expected.width);
  const canvasHeight = Math.max(actual.height, expected.height);
  const overlapWidth = Math.min(actual.width, expected.width);
  const overlapHeight = Math.min(actual.height, expected.height);
  // Counts/percentage are over the *union* of the two top-left rectangles —
  // the bounding-box corner present in neither image is excluded.
  const totalPixels =
    actual.width * actual.height +
    expected.width * expected.height -
    overlapWidth * overlapHeight;

  const va: number[] = [0, 0, 0];
  const ve: number[] = [0, 0, 0];
  const tol = opts.pixelTolerance;

  let diffPixels = 0;
  let ignoredAntialiasPixels = 0;

  for (let y = 0; y < canvasHeight; y++) {
    for (let x = 0; x < canvasWidth; x++) {
      const outPos = (y * canvasWidth + x) * 4;
      const inActual = x < actual.width && y < actual.height;
      const inExpected = x < expected.width && y < expected.height;

      // Present in neither image (the bounding-box corner): leave it
      // transparent in the diff and don't count it.
      if (!inActual && !inExpected) continue;

      if (!(inActual && inExpected)) {
        // Present in only one image (dimension mismatch): always a difference.
        diffPixels++;
        if (output) draw(output, outPos, MAGENTA);
        continue;
      }

      const aPos = (y * actual.width + x) * 4;
      const ePos = (y * expected.width + x) * 4;
      visibleRgb(actual.data, aPos, va);
      visibleRgb(expected.data, ePos, ve);

      const equal =
        Math.abs(va[0] - ve[0]) <= tol &&
        Math.abs(va[1] - ve[1]) <= tol &&
        Math.abs(va[2] - ve[2]) <= tol;

      if (equal) {
        if (output) drawContext(output, outPos, actual.data, aPos);
        continue;
      }

      if (
        opts.ignoreAntialiasing &&
        isAntialiased(actual.data, expected.data, x, y, actual.width, expected.width, overlapWidth, overlapHeight)
      ) {
        ignoredAntialiasPixels++;
        if (output) draw(output, outPos, YELLOW);
        continue;
      }

      diffPixels++;
      if (output) draw(output, outPos, RED);
    }
  }

  const diffPercentage = totalPixels === 0 ? 0 : (diffPixels / totalPixels) * 100;

  let matches: boolean;
  if (dimensionMismatch) {
    matches = false;
  } else if (opts.maxDiffPixels === undefined && opts.maxDiffPercentage === undefined) {
    matches = diffPixels === 0;
  } else {
    matches =
      (opts.maxDiffPixels === undefined || diffPixels <= opts.maxDiffPixels) &&
      (opts.maxDiffPercentage === undefined || diffPercentage <= opts.maxDiffPercentage);
  }

  return {
    matches,
    diffPixels,
    diffPercentage,
    ignoredAntialiasPixels,
    expectedWidth: expected.width,
    expectedHeight: expected.height,
    actualWidth: actual.width,
    actualHeight: actual.height,
    dimensionMismatch,
  };
}

/**
 * Compare two compressed PNG buffers without disk access, browser capture,
 * retries, or throwing on a normal mismatch. Applies the same byte/pixel input
 * limits as the retrying assertion.
 *
 * Argument order is `(actual, expected)` — see the note in `./types`.
 */
export async function compareScreenshots(
  actual: Buffer,
  expected: Buffer,
  options?: ScreenshotCompareOptions
): Promise<VisualComparisonResult> {
  const opts = resolveCompareOptions(options);
  const limits = { maxImagePixels: opts.maxImagePixels, maxInputBytes: opts.maxInputBytes };
  const { width, height } = validatePngHeaderAndSize(expected, limits, 'baseline');
  validatePngHeaderAndSize(actual, limits, 'screenshot');

  // Fast path: identical compressed bytes necessarily mean identical pixels, so
  // there is nothing to decode. Mirrors the retrying assertion's fast path.
  if (actual.length === expected.length && actual.equals(expected)) {
    return {
      matches: true,
      diffPixels: 0,
      diffPercentage: 0,
      ignoredAntialiasPixels: 0,
      expectedWidth: width,
      expectedHeight: height,
      actualWidth: width,
      actualHeight: height,
      dimensionMismatch: false,
    };
  }

  const [actualImage, expectedImage] = await Promise.all([
    pngjsCodec.decode(actual),
    pngjsCodec.decode(expected),
  ]);
  return compareDecoded(actualImage, expectedImage, opts);
}
