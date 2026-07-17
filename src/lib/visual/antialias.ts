/**
 * Optional anti-aliasing detector.
 *
 * The `antialiased()` / `hasManySiblings()` neighbourhood heuristic below is
 * adapted from Pixelmatch (https://github.com/mapbox/pixelmatch) by Vladimir
 * Agafonkin, which itself implements the anti-aliasing detection from:
 *
 *   V. Vysniauskas, "Anti-aliased pixel and intensity slope detector", 2009.
 *
 * Pixelmatch is distributed under the ISC License:
 *
 *   Copyright (c) 2019, Mapbox
 *
 *   Permission to use, copy, modify, and/or distribute this software for any
 *   purpose with or without fee is hereby granted, provided that the above
 *   copyright notice and this permission notice appear in all copies.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 *   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 *   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 *   SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 *   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 *   OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 *   CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * Adaptations from the original: brightness deltas and sibling equality use
 * white-composited visible colour (see `./pixelMath`) instead of Pixelmatch's
 * checkerboard blend, and all neighbour reads are byte-indexed so no 4-byte
 * `Uint32Array` alignment is assumed of the codec output.
 */

import { brightnessDelta, visibleEqual } from './pixelMath.js';

/**
 * Determine whether the pixel at (x1, y1) in `data` looks like anti-aliasing,
 * cross-checked against `other`. A pixel is a candidate when it has a bright and
 * a dark neighbour (an intensity slope) and the extreme neighbour has many
 * identical siblings in both images.
 *
 * `width`/`height` bound the compared region (the overlap of the two images);
 * `stride`/`otherStride` are the true row widths used to byte-index `data` and
 * `other` respectively. These differ only on a dimension mismatch — indexing a
 * buffer at anything but its own row width reads the wrong pixels. For equal
 * dimensions all three widths coincide and behaviour is unchanged.
 */
function antialiased(
  data: Uint8Array,
  x1: number,
  y1: number,
  width: number,
  height: number,
  stride: number,
  other: Uint8Array,
  otherStride: number
): boolean {
  const x0 = Math.max(x1 - 1, 0);
  const y0 = Math.max(y1 - 1, 0);
  const x2 = Math.min(x1 + 1, width - 1);
  const y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * stride + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;

  let min = 0;
  let max = 0;
  let minX = -1;
  let minY = -1;
  let maxX = -1;
  let maxY = -1;

  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;

      const delta = brightnessDelta(data, pos, (y * stride + x) * 4);

      if (delta === 0) {
        zeroes++;
        // If a pixel has many equal-brightness siblings it is not an edge.
        if (zeroes > 2) return false;
      } else if (delta < min) {
        min = delta;
        minX = x;
        minY = y;
      } else if (delta > max) {
        max = delta;
        maxX = x;
        maxY = y;
      }
    }
  }

  // Need both a darker and a brighter neighbour to form an intensity slope.
  if (min === 0 || max === 0) return false;

  return (
    (hasManySiblings(data, minX, minY, width, height, stride) &&
      hasManySiblings(other, minX, minY, width, height, otherStride)) ||
    (hasManySiblings(data, maxX, maxY, width, height, stride) &&
      hasManySiblings(other, maxX, maxY, width, height, otherStride))
  );
}

/**
 * Whether the pixel at (x1, y1) shares its visible colour with ≥3 neighbours.
 * `width`/`height` bound the compared region; `stride` is `data`'s true row
 * width used for byte indexing (see {@link antialiased}).
 */
function hasManySiblings(
  data: Uint8Array,
  x1: number,
  y1: number,
  width: number,
  height: number,
  stride: number
): boolean {
  const x0 = Math.max(x1 - 1, 0);
  const y0 = Math.max(y1 - 1, 0);
  const x2 = Math.min(x1 + 1, width - 1);
  const y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * stride + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;

  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      if (visibleEqual(data, pos, (y * stride + x) * 4)) {
        zeroes++;
        if (zeroes > 2) return true;
      }
    }
  }
  return false;
}

/**
 * Whether the pixel at (x, y) is anti-aliasing in either image (Pixelmatch's
 * symmetric check). Callers should only invoke this for pixels that already
 * failed the colour-tolerance test.
 *
 * `width`/`height` bound the compared region (the overlap); `actualWidth` and
 * `expectedWidth` are each buffer's own row width for byte indexing, which
 * differ from the overlap only on a dimension mismatch.
 */
export function isAntialiased(
  actual: Uint8Array,
  expected: Uint8Array,
  x: number,
  y: number,
  actualWidth: number,
  expectedWidth: number,
  width: number,
  height: number
): boolean {
  return (
    antialiased(actual, x, y, width, height, actualWidth, expected, expectedWidth) ||
    antialiased(expected, x, y, width, height, expectedWidth, actual, actualWidth)
  );
}
