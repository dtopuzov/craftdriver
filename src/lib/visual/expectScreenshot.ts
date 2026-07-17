/**
 * The retrying visual assertion: read the baseline once, then poll the browser
 * until a screenshot matches or the monotonic deadline expires.
 *
 * The hot path is deliberately lazy. An exact byte match costs one screenshot
 * plus a `Buffer.equals` and never decodes. A static mismatch decodes the
 * expected and actual images once each, then subsequent polls only re-capture
 * and compare compressed bytes. Only changing content pays a decode per retry.
 * The diff image is allocated and encoded exactly once, after the final failure.
 *
 * Baselines are managed for the caller, WebdriverIO-style:
 *   - Missing baseline (ENOENT): capture until two consecutive frames settle,
 *     write it, pass. This is the default — no flag required.
 *   - Present but differs, with `update`: capture as usual and, only if the page
 *     never settles into a match, overwrite the baseline with the final actual
 *     and pass. A page that settles back into a match passes without rewriting.
 * A present-but-corrupt baseline, and any non-ENOENT read error, stay hard
 * configuration errors even under `update` — they are never overwritten.
 *
 * Every baseline write is atomic — the PNG is written to a temp file in the same
 * directory and renamed into place — so an interrupted run cannot corrupt a
 * committed baseline (this matters most under `update`, which replaces one).
 *
 * Timing (`now`) and delays (`sleep`) are injectable so retry behaviour can be
 * driven deterministically in tests without wall-clock waits.
 */

import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir as fsMkdir,
  rename as fsRename,
  unlink as fsUnlink,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { By } from '../by.js';
import { CraftdriverError, ErrorCode } from '../errors.js';
import { VISUAL_RETRY_INTERVAL_MS } from '../timing.js';
import type { DecodedImage, PngCodec } from './codec.js';
import { pngjsCodec } from './pngjsCodec.js';
import { validatePngHeaderAndSize } from './pngHeader.js';
import { compareDecoded, resolveCompareOptions } from './compare.js';
import { createDiff } from './diff.js';
import { VisualMismatchError } from './visualError.js';
import type { ExpectScreenshotOptions, ScreenshotMatchResult } from './types.js';

/** Capture one screenshot, bounding any internal visibility wait by `remainingMs`. */
export type CaptureFn = (remainingMs: number) => Promise<Buffer>;

export interface RunExpectScreenshotDeps {
  expectedPath: string;
  options: ExpectScreenshotOptions;
  /** The browser's live default timeout, used when `options.timeout` is unset. */
  defaultTimeout: number;
  capture: CaptureFn;
  /**
   * When true, a baseline that is present but never matches is overwritten with
   * the final actual instead of throwing. Missing-baseline creation is always on
   * and does not depend on this flag. Driven by
   * {@link shouldUpdateVisualBaselines} from the environment. Default false.
   */
  update?: boolean;
  // Injectable seams (default to real implementations).
  readFile?: (path: string) => Promise<Buffer>;
  writeFile?: (path: string, data: Buffer) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  mkdir?: (dir: string, opts: { recursive: true }) => Promise<unknown>;
  /** Human-readable one-liner reported when a baseline is created or updated. */
  report?: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  codec?: PngCodec;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const defaultReport = (message: string): void => {
  process.stderr.write(`[craftdriver] ${message}\n`);
};

function invalid(message: string, detail?: Record<string, unknown>): never {
  throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, message, detail ? { detail } : undefined);
}

function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Strictly interpret the `CRAFTDRIVER_UPDATE_VISUAL_BASELINES` environment
 * variable. Unset / empty / `false` → off; `true` → on (trimmed,
 * case-insensitive). Anything else throws `INVALID_ARGUMENT` rather than being
 * silently coerced — this flag mutates files on disk, so a typo must fail loud.
 */
export function shouldUpdateVisualBaselines(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  invalid(
    `CRAFTDRIVER_UPDATE_VISUAL_BASELINES must be "true" or "false" (or unset), got ${JSON.stringify(raw)}.`,
    { value: raw }
  );
}

/** Validate the retry-specific options (compare options are validated separately). */
function resolveRetryOptions(
  options: ExpectScreenshotOptions,
  defaultTimeout: number
): { timeout: number; interval: number } {
  const timeout = options.timeout ?? defaultTimeout;
  if (!Number.isFinite(timeout) || timeout < 0) {
    invalid(`timeout must be a finite number >= 0, got ${timeout}.`, { timeout });
  }

  const interval = options.interval ?? VISUAL_RETRY_INTERVAL_MS;
  if (!Number.isInteger(interval) || interval < 10) {
    invalid(`interval must be an integer >= 10 ms, got ${interval}.`, { interval });
  }

  // Validate the capture scope's shape for JavaScript callers (TS already
  // constrains it): correct field types, then the fullPage/selector exclusion.
  const scope = options.screenshot;
  if (scope !== undefined) {
    if (typeof scope !== 'object' || scope === null) {
      invalid('screenshot must be an object with { fullPage } or { selector }.');
    }
    const hasFullPage = 'fullPage' in scope && scope.fullPage !== undefined;
    const hasSelector = 'selector' in scope && (scope as { selector?: unknown }).selector !== undefined;
    if (hasFullPage && typeof (scope as { fullPage?: unknown }).fullPage !== 'boolean') {
      invalid('screenshot.fullPage must be a boolean.');
    }
    if (hasSelector) {
      const selector = (scope as { selector?: unknown }).selector;
      if (typeof selector !== 'string' && !(selector instanceof By)) {
        invalid('screenshot.selector must be a string or a By locator.');
      }
    }
    if (hasFullPage && (scope as { fullPage?: unknown }).fullPage === true && hasSelector) {
      invalid('screenshot.fullPage and screenshot.selector are mutually exclusive.');
    }
  }

  return { timeout, interval };
}

/** A monotonic deadline built once, queried throughout a run. */
function makeClock(now: () => number, timeout: number) {
  const start = now();
  const deadline = start + timeout;
  return {
    elapsed: (): number => now() - start,
    remaining: (): number => Math.max(0, deadline - now()),
    expired: (): boolean => now() >= deadline,
  };
}

export async function runExpectScreenshot(deps: RunExpectScreenshotDeps): Promise<ScreenshotMatchResult> {
  const { expectedPath, options, defaultTimeout, capture } = deps;
  const update = deps.update ?? false;
  const readFile = deps.readFile ?? fsReadFile;
  const writeFile = deps.writeFile ?? fsWriteFile;
  const rename = deps.rename ?? fsRename;
  const unlink = deps.unlink ?? fsUnlink;
  const mkdir = deps.mkdir ?? fsMkdir;
  const report = deps.report ?? defaultReport;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? realSleep;
  const codec = deps.codec ?? pngjsCodec;

  const compareOpts = resolveCompareOptions(options);
  const { timeout, interval } = resolveRetryOptions(options, defaultTimeout);
  const limits = { maxImagePixels: compareOpts.maxImagePixels, maxInputBytes: compareOpts.maxInputBytes };

  /**
   * Write a baseline atomically: the PNG is written in full to a uniquely-named
   * temporary file in the destination's own directory, then renamed over the
   * destination. A crash, disk error, or partial write therefore never leaves a
   * truncated or half-updated committed baseline — the old file survives intact.
   * On any failure the temp file is best-effort removed and the error rethrown.
   */
  const writeBaselineAtomically = async (destination: string, data: Buffer): Promise<void> => {
    const tmp = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, destination);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  };

  /**
   * No baseline on disk yet: capture until two consecutive frames are
   * byte-identical (or the timeout elapses) so we don't enshrine a mid-animation
   * frame, then write that settled capture as the new baseline and pass.
   */
  const createMissingBaseline = async (): Promise<ScreenshotMatchResult> => {
    const clock = makeClock(now, timeout);
    let settled: Buffer | undefined;
    let settledDims: { width: number; height: number } | undefined;
    let attempts = 0;
    let didSettle = false;

    for (;;) {
      const buffer = await capture(clock.remaining());
      attempts++;
      const dims = validatePngHeaderAndSize(buffer, limits, 'screenshot');
      const isSettled = settled !== undefined && settled.equals(buffer);
      settled = buffer;
      settledDims = dims;
      if (isSettled) {
        didSettle = true;
        break;
      }
      if (clock.expired()) break;
      await sleep(Math.min(interval, clock.remaining()));
    }

    await mkdir(dirname(expectedPath), { recursive: true });
    await writeBaselineAtomically(expectedPath, settled!);
    // Warn on every unsettled write — including `timeout: 0`, which deliberately
    // takes a single capture — so an arbitrary frame is never written silently.
    // We still create the baseline (a page with a live region would otherwise be
    // impossible to baseline); the message just flags the frame for review.
    report(
      didSettle
        ? `Created visual baseline: ${expectedPath}`
        : `Created visual baseline (page did not settle within ${timeout}ms — review it before committing): ${expectedPath}`
    );
    return {
      matches: true,
      diffPixels: 0,
      diffPercentage: 0,
      ignoredAntialiasPixels: 0,
      expectedWidth: settledDims!.width,
      expectedHeight: settledDims!.height,
      actualWidth: settledDims!.width,
      actualHeight: settledDims!.height,
      dimensionMismatch: false,
      attempts,
      elapsedMs: clock.elapsed(),
      baseline: 'created',
    };
  };

  // Read + validate the baseline once, before the deadline starts, so `timeout`
  // measures browser stabilization time rather than disk latency. A missing file
  // is the create signal; any other read error stays a caller-facing failure.
  let expectedBuffer: Buffer;
  try {
    expectedBuffer = await readFile(expectedPath);
  } catch (err) {
    if (!isFileNotFound(err)) throw err;
    return createMissingBaseline();
  }
  const expectedDims = validatePngHeaderAndSize(expectedBuffer, limits, 'baseline');

  const clock = makeClock(now, timeout);

  let expectedImage: DecodedImage | undefined;
  let previousActualBuffer: Buffer | undefined;
  let previousActualImage: DecodedImage | undefined;
  let previousComparison: ScreenshotMatchResult | undefined;
  let attempts = 0;

  for (;;) {
    const actualBuffer = await capture(clock.remaining());
    attempts++;

    // Fast path 1: identical PNG bytes necessarily means identical pixels.
    if (expectedBuffer.length === actualBuffer.length && expectedBuffer.equals(actualBuffer)) {
      return {
        matches: true,
        diffPixels: 0,
        diffPercentage: 0,
        ignoredAntialiasPixels: 0,
        expectedWidth: expectedDims.width,
        expectedHeight: expectedDims.height,
        actualWidth: expectedDims.width,
        actualHeight: expectedDims.height,
        dimensionMismatch: false,
        attempts,
        elapsedMs: clock.elapsed(),
        baseline: 'matched',
      };
    }

    // Fast path 2: an unchanged failed screenshot has the same comparison result.
    if (previousActualBuffer?.equals(actualBuffer)) {
      if (clock.expired()) break;
      await sleep(Math.min(interval, clock.remaining()));
      continue;
    }

    validatePngHeaderAndSize(actualBuffer, limits, 'screenshot');
    expectedImage ??= await codec.decode(expectedBuffer);
    const actualImage = await codec.decode(actualBuffer);
    const comparison = compareDecoded(actualImage, expectedImage, compareOpts);

    if (comparison.matches) {
      return { ...comparison, attempts, elapsedMs: clock.elapsed(), baseline: 'matched' };
    }

    // Retain only the most recent failed attempt — never every retry image.
    previousActualBuffer = actualBuffer;
    previousActualImage = actualImage;
    previousComparison = { ...comparison, attempts, elapsedMs: clock.elapsed(), baseline: 'matched' };

    if (clock.expired()) break;
    await sleep(Math.min(interval, clock.remaining()));
  }

  // The page never settled into a match. Either accept the new rendering by
  // overwriting the baseline (update mode), or fail with the diff.
  if (update) {
    await writeBaselineAtomically(expectedPath, previousActualBuffer!);
    report(
      `Updated visual baseline: ${expectedPath} ` +
        `(${previousComparison!.diffPixels} px, ${previousComparison!.diffPercentage.toFixed(2)}% changed)`
    );
    return {
      matches: true,
      diffPixels: 0,
      diffPercentage: 0,
      ignoredAntialiasPixels: 0,
      expectedWidth: previousComparison!.actualWidth,
      expectedHeight: previousComparison!.actualHeight,
      actualWidth: previousComparison!.actualWidth,
      actualHeight: previousComparison!.actualHeight,
      dimensionMismatch: false,
      attempts,
      elapsedMs: clock.elapsed(),
      baseline: 'updated',
    };
  }

  // Final failure: reuse the retained decoded images, paint the diff once, encode once.
  const rawDiff = createDiff(previousActualImage!, expectedImage!, compareOpts);
  const diff = await codec.encode(rawDiff);
  throw new VisualMismatchError(previousActualBuffer!, diff, {
    expectedPath,
    timeout,
    attempts,
    elapsedMs: clock.elapsed(),
    comparison: previousComparison!,
  });
}
