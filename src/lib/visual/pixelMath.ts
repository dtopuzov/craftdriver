/**
 * Low-level per-pixel math shared by the comparison loop and the anti-alias
 * detector. Kept in its own module so `compare.ts` and `antialias.ts` can both
 * use it without an import cycle.
 *
 * Every visible-colour computation composites over a **white** background. Two
 * fully transparent pixels therefore composite to white and compare equal, and
 * hidden RGB bytes under alpha zero never influence the result. This is the
 * single documented background used everywhere: ordinary comparison, sibling
 * equality, and the anti-alias brightness heuristic. If any of them used a
 * different background they would disagree about transparent pixels.
 */

/** Composite one 0..255 channel with 0..255 alpha over a white background. */
export function blendOverWhite(channel: number, alpha: number): number {
  // 255 + (channel - 255) * (alpha / 255): alpha 255 → channel, alpha 0 → white.
  return 255 + ((channel - 255) * alpha) / 255;
}

/** ITU-R BT.601 luma of an already-composited RGB triple. */
export function rgb2y(r: number, g: number, b: number): number {
  return r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
}

/** Read a pixel's white-composited visible RGB into `out` (length ≥ 3). */
export function visibleRgb(data: Uint8Array, pos: number, out: number[]): void {
  const a = data[pos + 3];
  if (a === 255) {
    out[0] = data[pos];
    out[1] = data[pos + 1];
    out[2] = data[pos + 2];
  } else {
    out[0] = blendOverWhite(data[pos], a);
    out[1] = blendOverWhite(data[pos + 1], a);
    out[2] = blendOverWhite(data[pos + 2], a);
  }
}

/**
 * Brightness (luma) delta between two pixels of the same image, both composited
 * over white. This is Pixelmatch's `colorDelta(..., yOnly=true)` with
 * `checkerboard: false`, i.e. white compositing to match craftdriver's contract.
 */
export function brightnessDelta(data: Uint8Array, pos1: number, pos2: number): number {
  const a1 = data[pos1 + 3];
  const a2 = data[pos2 + 3];
  const r1 = a1 === 255 ? data[pos1] : blendOverWhite(data[pos1], a1);
  const g1 = a1 === 255 ? data[pos1 + 1] : blendOverWhite(data[pos1 + 1], a1);
  const b1 = a1 === 255 ? data[pos1 + 2] : blendOverWhite(data[pos1 + 2], a1);
  const r2 = a2 === 255 ? data[pos2] : blendOverWhite(data[pos2], a2);
  const g2 = a2 === 255 ? data[pos2 + 1] : blendOverWhite(data[pos2 + 1], a2);
  const b2 = a2 === 255 ? data[pos2 + 2] : blendOverWhite(data[pos2 + 2], a2);
  return rgb2y(r1, g1, b1) - rgb2y(r2, g2, b2);
}

/**
 * Whether two pixels have the same white-composited visible colour. Used for
 * sibling counting in the AA heuristic — deliberately compares visible colour,
 * not the raw RGBA bytes, so transparent pixels with differing hidden RGB still
 * count as identical siblings.
 */
export function visibleEqual(data: Uint8Array, pos1: number, pos2: number): boolean {
  const a1 = data[pos1 + 3];
  const a2 = data[pos2 + 3];
  if (a1 === 255 && a2 === 255) {
    return (
      data[pos1] === data[pos2] &&
      data[pos1 + 1] === data[pos2 + 1] &&
      data[pos1 + 2] === data[pos2 + 2]
    );
  }
  return (
    blendOverWhite(data[pos1], a1) === blendOverWhite(data[pos2], a2) &&
    blendOverWhite(data[pos1 + 1], a1) === blendOverWhite(data[pos2 + 1], a2) &&
    blendOverWhite(data[pos1 + 2], a1) === blendOverWhite(data[pos2 + 2], a2)
  );
}
