import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { compareScreenshots, CraftdriverError, ErrorCode } from '../src';
import { pngjsCodec } from '../src/lib/visual/pngjsCodec.js';
import { compareDecoded, resolveCompareOptions } from '../src/lib/visual/compare.js';
import { createDiff } from '../src/lib/visual/diff.js';
import { validatePngHeaderAndSize } from '../src/lib/visual/pngHeader.js';
import { DEFAULT_MAX_IMAGE_PIXELS, DEFAULT_MAX_INPUT_BYTES } from '../src/lib/visual/types.js';
import type { DecodedImage } from '../src/lib/visual/codec.js';

// ── Fixture helpers ──────────────────────────────────────────────────────────

type Rgba = [number, number, number, number];

/** Build a decoded RGBA image; `fill(x, y)` returns the pixel. */
function makeImage(width: number, height: number, fill: (x: number, y: number) => Rgba): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

const solid =
  (r: number, g: number, b: number, a = 255) =>
  (): Rgba =>
    [r, g, b, a];

async function encode(image: DecodedImage): Promise<Buffer> {
  return pngjsCodec.encode(image);
}

/** Encode with an explicit pngjs colour type / bit depth / interlacing. */
function encodeWith(
  image: DecodedImage,
  opts: { colorType?: number; bitDepth?: number; interlace?: boolean }
): Buffer {
  const png = new PNG({
    width: image.width,
    height: image.height,
    colorType: opts.colorType,
    bitDepth: opts.bitDepth,
    interlace: opts.interlace,
    inputColorType: 6,
  });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png, {
    colorType: opts.colorType ?? 6,
    bitDepth: opts.bitDepth ?? 8,
    interlace: opts.interlace ?? false,
    inputColorType: 6,
  });
}

const LIMITS = { maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS, maxInputBytes: DEFAULT_MAX_INPUT_BYTES };

// ── Basic comparison ─────────────────────────────────────────────────────────

describe('compareScreenshots — basic', () => {
  it('identical pixels compare equal even across different PNG encodings', async () => {
    const img = makeImage(8, 8, (x, y) => [x * 20, y * 20, 100, 255]);
    const rgba = await encode(img);
    const rgb = encodeWith(img, { colorType: 2 });
    expect(rgba.equals(rgb)).toBe(false); // genuinely different bytes

    const result = await compareScreenshots(rgb, rgba);
    expect(result.matches).toBe(true);
    expect(result.diffPixels).toBe(0);
    expect(result.diffPercentage).toBe(0);
  });

  it('a clear difference fails with a nonzero count', async () => {
    const expected = await encode(makeImage(4, 4, solid(0, 0, 0)));
    const actual = await encode(makeImage(4, 4, solid(255, 255, 255)));
    const result = await compareScreenshots(actual, expected);
    expect(result.matches).toBe(false);
    expect(result.diffPixels).toBe(16);
    expect(result.diffPercentage).toBeCloseTo(100);
  });

  it('reports (actual, expected) dimensions in argument order', async () => {
    const expected = await encode(makeImage(4, 4, solid(0, 0, 0)));
    const actual = await encode(makeImage(6, 5, solid(0, 0, 0)));
    const result = await compareScreenshots(actual, expected);
    expect(result.expectedWidth).toBe(4);
    expect(result.expectedHeight).toBe(4);
    expect(result.actualWidth).toBe(6);
    expect(result.actualHeight).toBe(5);
    expect(result.dimensionMismatch).toBe(true);
    expect(result.matches).toBe(false);
  });
});

// ── pixelTolerance boundaries ────────────────────────────────────────────────

describe('pixelTolerance', () => {
  const delta = 5;

  async function pair() {
    const expected = await encode(makeImage(4, 4, solid(100, 100, 100)));
    const actual = await encode(makeImage(4, 4, solid(100 + delta, 100, 100)));
    return { expected, actual };
  }

  it('fails at delta - 1', async () => {
    const { expected, actual } = await pair();
    expect((await compareScreenshots(actual, expected, { pixelTolerance: delta - 1 })).matches).toBe(false);
  });

  it('passes at exactly delta (inclusive)', async () => {
    const { expected, actual } = await pair();
    expect((await compareScreenshots(actual, expected, { pixelTolerance: delta })).matches).toBe(true);
  });

  it('passes at delta + 1', async () => {
    const { expected, actual } = await pair();
    expect((await compareScreenshots(actual, expected, { pixelTolerance: delta + 1 })).matches).toBe(true);
  });
});

// ── Global thresholds ────────────────────────────────────────────────────────

describe('global thresholds', () => {
  // 10x10 image, exactly 5 differing pixels.
  async function fiveDiffs() {
    const expected = await encode(makeImage(10, 10, solid(0, 0, 0)));
    let n = 0;
    const actual = await encode(
      makeImage(10, 10, () => (n++ < 5 ? [255, 255, 255, 255] : [0, 0, 0, 255]))
    );
    return { expected, actual };
  }

  it('with no limits, any diff fails', async () => {
    const { expected, actual } = await fiveDiffs();
    expect((await compareScreenshots(actual, expected)).matches).toBe(false);
  });

  it('maxDiffPixels is inclusive', async () => {
    const { expected, actual } = await fiveDiffs();
    expect((await compareScreenshots(actual, expected, { maxDiffPixels: 4 })).matches).toBe(false);
    expect((await compareScreenshots(actual, expected, { maxDiffPixels: 5 })).matches).toBe(true);
  });

  it('maxDiffPercentage is inclusive (5/100 = 5%)', async () => {
    const { expected, actual } = await fiveDiffs();
    expect((await compareScreenshots(actual, expected, { maxDiffPercentage: 4.99 })).matches).toBe(false);
    expect((await compareScreenshots(actual, expected, { maxDiffPercentage: 5 })).matches).toBe(true);
  });

  it('when both are supplied, both must pass', async () => {
    const { expected, actual } = await fiveDiffs();
    expect(
      (await compareScreenshots(actual, expected, { maxDiffPixels: 5, maxDiffPercentage: 4 })).matches
    ).toBe(false);
    expect(
      (await compareScreenshots(actual, expected, { maxDiffPixels: 4, maxDiffPercentage: 5 })).matches
    ).toBe(false);
    expect(
      (await compareScreenshots(actual, expected, { maxDiffPixels: 5, maxDiffPercentage: 5 })).matches
    ).toBe(true);
  });

  it('crossed dimensions count the true union, not the bounding box', async () => {
    // actual 4x2, expected 2x4 → overlap 2x2; the bottom-right 2x2 corner is in
    // NEITHER image and must not be counted. Same solid colour so overlap matches.
    const expected = await encode(makeImage(2, 4, solid(0, 0, 0)));
    const actual = await encode(makeImage(4, 2, solid(0, 0, 0)));
    const result = await compareScreenshots(actual, expected);
    // union = 4*2 + 2*4 - 2*2 = 12; diffs = only-in-one = 12 - 4 = 8.
    expect(result.diffPixels).toBe(8);
    expect(result.diffPercentage).toBeCloseTo((8 / 12) * 100, 4);
    expect(result.dimensionMismatch).toBe(true);
  });

  it('dimension mismatch cannot be tolerated away', async () => {
    const expected = await encode(makeImage(4, 4, solid(0, 0, 0)));
    const actual = await encode(makeImage(5, 4, solid(0, 0, 0)));
    const result = await compareScreenshots(actual, expected, {
      maxDiffPixels: 1_000_000,
      maxDiffPercentage: 100,
    });
    expect(result.matches).toBe(false);
    expect(result.dimensionMismatch).toBe(true);
  });
});

// ── Transparency / white compositing ─────────────────────────────────────────

describe('transparency', () => {
  it('fully transparent pixels with different hidden RGB compare equal', async () => {
    const expected = await encode(makeImage(4, 4, solid(255, 0, 0, 0)));
    const actual = await encode(makeImage(4, 4, solid(0, 0, 255, 0)));
    expect((await compareScreenshots(actual, expected)).matches).toBe(true);
  });

  it('a transparent pixel differs from the same colour opaque (composited over white)', async () => {
    const expected = await encode(makeImage(4, 4, solid(0, 0, 0, 0))); // → white
    const actual = await encode(makeImage(4, 4, solid(0, 0, 0, 255))); // black
    expect((await compareScreenshots(actual, expected)).matches).toBe(false);
  });
});

// ── PNG colour-type / bit-depth / interlace corpus ───────────────────────────

describe('decode corpus', () => {
  const img = makeImage(6, 4, (x, y) => [x * 40, y * 60, 128, 255]);

  it('grayscale (colorType 0) decodes and matches its RGBA twin', async () => {
    const gray = makeImage(6, 4, (x) => [x * 40, x * 40, x * 40, 255]);
    const grayPng = encodeWith(gray, { colorType: 0 });
    const rgbaPng = await encode(gray);
    expect((await compareScreenshots(grayPng, rgbaPng)).matches).toBe(true);
  });

  it('16-bit input decodes and normalizes to 8-bit', async () => {
    // pngjs 16-bit output reinterprets png.data as Uint16 samples, so build a
    // faithful 16-bit image where each 8-bit value v maps to 0xVVVV (v * 257),
    // which the decoder downscales back to v.
    const png8 = await encode(img);
    const samples = new Uint16Array(img.width * img.height * 4);
    for (let i = 0; i < img.data.length; i++) samples[i] = img.data[i] * 257;
    const png16bit = new PNG({ width: img.width, height: img.height, colorType: 6, bitDepth: 16 });
    png16bit.data = Buffer.from(samples.buffer);
    const png16 = PNG.sync.write(png16bit, { colorType: 6, bitDepth: 16, inputColorType: 6, inputHasAlpha: true });
    expect((await compareScreenshots(png16, png8)).matches).toBe(true);
  });

  it('interlaced (Adam7) input decodes and matches non-interlaced', async () => {
    const interlaced = encodeWith(img, { colorType: 6, interlace: true });
    const plain = await encode(img);
    expect((await compareScreenshots(interlaced, plain)).matches).toBe(true);
  });
});

// ── Option validation ────────────────────────────────────────────────────────

describe('option validation (never clamps)', () => {
  const buf = () => encode(makeImage(2, 2, solid(0, 0, 0)));

  async function rejects(options: Parameters<typeof compareScreenshots>[2]) {
    const b = await buf();
    const err = await compareScreenshots(b, b, options).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CraftdriverError);
    expect((err as CraftdriverError).code).toBe(ErrorCode.INVALID_ARGUMENT);
  }

  it('rejects non-integer pixelTolerance', () => rejects({ pixelTolerance: 1.5 }));
  it('rejects pixelTolerance > 255', () => rejects({ pixelTolerance: 256 }));
  it('rejects negative pixelTolerance', () => rejects({ pixelTolerance: -1 }));
  it('rejects non-integer maxDiffPixels', () => rejects({ maxDiffPixels: 2.5 }));
  it('rejects negative maxDiffPixels', () => rejects({ maxDiffPixels: -1 }));
  it('rejects maxDiffPercentage > 100', () => rejects({ maxDiffPercentage: 101 }));
  it('rejects negative maxDiffPercentage', () => rejects({ maxDiffPercentage: -0.1 }));
  it('rejects non-finite maxImagePixels', () => rejects({ maxImagePixels: Number.NaN }));
  it('rejects a non-boolean ignoreAntialiasing', () =>
    // A JSON caller's "false" string must not silently enable AA ignoring.
    rejects({ ignoreAntialiasing: 'false' as unknown as boolean }));
});

describe('compareScreenshots identical-buffer fast path', () => {
  it('returns a match for identical bytes without decoding', async () => {
    // A valid header but CRC-corrupt body: decoding would throw. Passing the
    // same buffer as both args must still succeed via the byte-equality path.
    const full = await encode(makeImage(8, 8, solid(10, 20, 30)));
    const corrupt = Buffer.from(full);
    corrupt[corrupt.length - 12] ^= 0xff; // break IDAT CRC, keep the header valid
    const result = await compareScreenshots(corrupt, corrupt);
    expect(result.matches).toBe(true);
    expect(result.diffPixels).toBe(0);
    expect(result.expectedWidth).toBe(8);
    expect(result.actualHeight).toBe(8);

    // Sanity: a non-identical corrupt buffer does reach the decoder and throws.
    await expect(compareScreenshots(corrupt, full)).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENT,
    });
  });
});

// ── Input limits enforced before decode ──────────────────────────────────────

describe('input limits', () => {
  it('rejects a compressed buffer above maxInputBytes', async () => {
    const b = await encode(makeImage(2, 2, solid(0, 0, 0)));
    const err = await compareScreenshots(b, b, { maxInputBytes: 10 }).catch((e: unknown) => e);
    expect((err as CraftdriverError).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });

  it('rejects an image above maxImagePixels before allocation', async () => {
    const b = await encode(makeImage(100, 100, solid(0, 0, 0)));
    const err = await compareScreenshots(b, b, { maxImagePixels: 100 }).catch((e: unknown) => e);
    expect((err as CraftdriverError).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });

  it('validatePngHeaderAndSize parses declared dimensions', async () => {
    const b = await encode(makeImage(7, 3, solid(0, 0, 0)));
    expect(validatePngHeaderAndSize(b, LIMITS, 'baseline')).toEqual({ width: 7, height: 3 });
  });

  it('rejects a non-PNG buffer', () => {
    const err = (() => {
      try {
        validatePngHeaderAndSize(Buffer.alloc(64, 1), LIMITS, 'screenshot');
      } catch (e) {
        return e;
      }
    })();
    expect((err as CraftdriverError).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });
});

// ── Corrupt input ────────────────────────────────────────────────────────────

describe('corrupt input', () => {
  it('rejects a truncated PNG', async () => {
    const full = await encode(makeImage(8, 8, solid(10, 20, 30)));
    const truncated = full.subarray(0, full.length - 20);
    const err = await compareScreenshots(truncated, full).catch((e: unknown) => e);
    expect((err as CraftdriverError).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });

  it('rejects a PNG with a corrupted chunk (CRC failure)', async () => {
    const full = await encode(makeImage(8, 8, solid(10, 20, 30)));
    const corrupt = Buffer.from(full);
    // Flip a byte inside the IDAT data (well past the header) to break its CRC.
    corrupt[corrupt.length - 12] ^= 0xff;
    const err = await compareScreenshots(corrupt, full).catch((e: unknown) => e);
    expect((err as CraftdriverError).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });
});

// ── Diff image semantics ─────────────────────────────────────────────────────

describe('diff image', () => {
  it('paints counted differences red and round-trips through the codec', async () => {
    const expected = makeImage(4, 4, solid(0, 0, 0));
    const actual = makeImage(4, 4, (x, y) => (x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const opts = resolveCompareOptions();
    const diff = createDiff(actual, expected, opts);
    expect(diff.width).toBe(4);
    expect(diff.height).toBe(4);
    // Top-left pixel is the only difference → opaque red.
    expect([...diff.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);

    const roundTrip = await pngjsCodec.decode(await pngjsCodec.encode(diff));
    expect([...roundTrip.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it('paints only-in-one-image regions magenta on dimension mismatch', () => {
    const expected = makeImage(2, 2, solid(0, 0, 0));
    const actual = makeImage(4, 2, solid(0, 0, 0));
    const diff = createDiff(actual, expected, resolveCompareOptions());
    expect(diff.width).toBe(4);
    // Column 3 (x=3, y=0) exists only in `actual` → magenta.
    const i = (0 * 4 + 3) * 4;
    expect([...diff.data.subarray(i, i + 4)]).toEqual([255, 0, 255, 255]);
  });

  it('leaves the neither-image corner transparent for crossed dimensions', () => {
    // actual 4x2, expected 2x4 → the (x=3, y=3) corner is in neither image.
    const expected = makeImage(2, 4, solid(0, 0, 0));
    const actual = makeImage(4, 2, solid(0, 0, 0));
    const diff = createDiff(actual, expected, resolveCompareOptions());
    expect(diff.width).toBe(4);
    expect(diff.height).toBe(4);
    const corner = (3 * 4 + 3) * 4;
    expect([...diff.data.subarray(corner, corner + 4)]).toEqual([0, 0, 0, 0]);
  });
});

// ── Anti-aliasing detection ──────────────────────────────────────────────────

describe('anti-aliasing', () => {
  const W = 20;
  const H = 20;

  // A vertical edge: black left, white right, with one grey AA column at x=9.
  const edge = (aa: number) =>
    makeImage(W, H, (x) => {
      if (x < 9) return [0, 0, 0, 255];
      if (x === 9) return [aa, aa, aa, 255];
      return [255, 255, 255, 255];
    });

  it('ignores an edge that differs only in anti-alias blending', () => {
    const expected = edge(128);
    const actual = edge(120); // only the AA column differs, by 8
    const off = compareDecoded(actual, expected, resolveCompareOptions());
    expect(off.matches).toBe(false);
    expect(off.diffPixels).toBe(H);

    const on = compareDecoded(actual, expected, resolveCompareOptions({ ignoreAntialiasing: true }));
    expect(on.matches).toBe(true);
    expect(on.diffPixels).toBe(0);
    expect(on.ignoredAntialiasPixels).toBe(H);
  });

  it('does NOT ignore a real solid block change (missing glyph / layout shift)', () => {
    const expected = edge(128);
    // Stamp a solid 6x6 black block into the white region — a genuine regression.
    const actual = makeImage(W, H, (x, y) => {
      if (x >= 13 && x < 19 && y >= 6 && y < 12) return [0, 0, 0, 255];
      if (x < 9) return [0, 0, 0, 255];
      if (x === 9) return [128, 128, 128, 255];
      return [255, 255, 255, 255];
    });
    const on = compareDecoded(actual, expected, resolveCompareOptions({ ignoreAntialiasing: true }));
    expect(on.matches).toBe(false);
    // The interior of the block cannot be explained as edge smoothing.
    expect(on.diffPixels).toBeGreaterThanOrEqual(16);
  });

  it('does not double-count AA pixels already within pixelTolerance', () => {
    const on = compareDecoded(
      edge(120),
      edge(128),
      resolveCompareOptions({ ignoreAntialiasing: true, pixelTolerance: 8 })
    );
    expect(on.diffPixels).toBe(0);
    expect(on.ignoredAntialiasPixels).toBe(0); // within tolerance → never a candidate
  });

  it('indexes each buffer at its own stride on a dimension mismatch', () => {
    // A diagonal grey ramp: bright upper-right, dark lower-left, an anti-aliased
    // band along the diagonal. `actual` is 4×4, `expected` a 3×4 crop shifted 8
    // levels darker so the overlap genuinely differs. The AA detector must index
    // `actual` at its own width (4), not the overlap width (3) — otherwise every
    // row after the first is read misaligned and the diagonal edge stops looking
    // like anti-aliasing. There is no large flat region to paper over the bug.
    const ramp = (shift: number) => (x: number, y: number): Rgba => {
      const v = Math.max(0, Math.min(255, (x - y + 1) * 100) - shift);
      return [v, v, v, 255];
    };
    const actual = makeImage(4, 4, ramp(0));
    const expected = makeImage(3, 4, ramp(8));

    const on = compareDecoded(actual, expected, resolveCompareOptions({ ignoreAntialiasing: true }));

    expect(on.dimensionMismatch).toBe(true);
    // Correct per-image strides classify 5 overlap edge pixels as anti-aliasing;
    // the old shared-overlap stride found none (and counted them all as diffs).
    expect(on.ignoredAntialiasPixels).toBe(5);
    expect(on.diffPixels).toBe(5); // 4 magenta (extra column) + 1 genuine red
  });
});

// ── Unaligned codec output ───────────────────────────────────────────────────

describe('alignment safety', () => {
  it('compares an unaligned Uint8Array view without assuming Uint32 alignment', () => {
    const base = makeImage(4, 4, (x, y) => [x * 30, y * 30, 60, 255]);
    // Build an intentionally unaligned view: offset by 1 byte in a larger buffer.
    const backing = new Uint8Array(base.data.length + 1);
    backing.set(base.data, 1);
    const unaligned: DecodedImage = {
      width: 4,
      height: 4,
      data: backing.subarray(1),
    };
    expect(unaligned.data.byteOffset % 4).not.toBe(0);
    const result = compareDecoded(unaligned, base, resolveCompareOptions({ ignoreAntialiasing: true }));
    expect(result.matches).toBe(true);
  });
});
