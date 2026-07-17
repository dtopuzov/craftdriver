/**
 * Lazy diff painting. Allocated and run exactly once, only after a visual
 * assertion has finally failed — never during retries. Reuses the comparison
 * loop in `./compare` with an output buffer so the painted diff and the counted
 * result use identical pixel semantics.
 */

import type { DecodedImage } from './codec.js';
import { compareDecoded, type ResolvedCompareOptions } from './compare.js';

/**
 * Produce a diagnostic diff image sized to the union of both inputs (top-left
 * aligned). Unchanged pixels appear as dimmed grayscale actual content,
 * counted differences as red, ignored anti-aliased pixels as yellow, and areas
 * present in only one image (dimension mismatch) as magenta.
 *
 * Argument order is `(actual, expected)` — see the note in `./types`.
 */
export function createDiff(
  actual: DecodedImage,
  expected: DecodedImage,
  opts: ResolvedCompareOptions
): DecodedImage {
  const width = Math.max(actual.width, expected.width);
  const height = Math.max(actual.height, expected.height);
  const data = new Uint8Array(width * height * 4);
  compareDecoded(actual, expected, opts, data);
  return { width, height, data };
}
