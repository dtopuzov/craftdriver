import { describe, it, expect } from 'vitest';
import { runExpectScreenshot } from '../src/lib/visual/expectScreenshot.js';
import { pngjsCodec } from '../src/lib/visual/pngjsCodec.js';
import { VisualMismatchError, CraftdriverError, ErrorCode } from '../src';
import type { DecodedImage } from '../src/lib/visual/codec.js';

// ── Fixtures & harness ───────────────────────────────────────────────────────

function image(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  return { width, height, data };
}

const png = (img: DecodedImage) => pngjsCodec.encode(img);
const solid = (w: number, h: number, r: number, g: number, b: number) => image(w, h, () => [r, g, b, 255]);

/** A codec that counts decode/encode calls but delegates to the real one. */
function countingCodec() {
  const state = { decodes: 0, encodes: 0 };
  return {
    state,
    codec: {
      decode: (b: Uint8Array) => { state.decodes++; return pngjsCodec.decode(b); },
      encode: (i: DecodedImage) => { state.encodes++; return pngjsCodec.encode(i); },
    },
  };
}

/** Deterministic clock: sleeps advance virtual time; captures do not. */
function fakeClock() {
  const state = { t: 0, sleeps: 0 };
  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => { state.t += ms; state.sleeps++; },
  };
}

/** Run the retry helper with injected seams and a scripted capture sequence. */
async function run(opts: {
  expected: Buffer;
  captures: Buffer[] | ((remaining: number) => Promise<Buffer>);
  options?: Parameters<typeof runExpectScreenshot>[0]['options'];
  defaultTimeout?: number;
}) {
  const clock = fakeClock();
  const counter = countingCodec();
  let readCount = 0;
  let captureIdx = 0;
  const capture =
    typeof opts.captures === 'function'
      ? opts.captures
      : async (): Promise<Buffer> => {
          const seq = opts.captures as Buffer[];
          return seq[Math.min(captureIdx++, seq.length - 1)];
        };

  const promise = runExpectScreenshot({
    expectedPath: 'baseline.png',
    options: opts.options ?? {},
    defaultTimeout: opts.defaultTimeout ?? 200,
    capture,
    readFile: async () => { readCount++; return opts.expected; },
    now: clock.now,
    sleep: clock.sleep,
    codec: counter.codec,
  });

  return { promise, clock: clock.state, codec: counter.state, reads: () => readCount };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('expectScreenshot retry loop', () => {
  it('reads the expected file exactly once, even across many retries', async () => {
    const expected = await png(solid(4, 4, 0, 0, 0));
    const actual = await png(solid(4, 4, 255, 255, 255));
    const r = await run({ expected, captures: [actual], options: { timeout: 200 } });
    await r.promise.catch(() => {});
    expect(r.reads()).toBe(1);
  });

  it('exact first screenshot: one capture, zero decodes, zero encodes', async () => {
    const expected = await png(solid(4, 4, 10, 20, 30));
    const r = await run({ expected, captures: [expected] });
    const result = await r.promise;
    expect(result.matches).toBe(true);
    expect(result.attempts).toBe(1);
    expect(r.codec.decodes).toBe(0);
    expect(r.codec.encodes).toBe(0);
    expect(r.clock.sleeps).toBe(0);
  });

  it('pixel-equal but different-PNG first screenshot decodes expected and actual once each', async () => {
    const img = image(6, 6, (x, y) => [x * 30, y * 30, 90, 255]);
    const expected = await png(img);
    // Re-encode a byte-different but pixel-identical PNG by decoding+encoding a copy.
    const actual = await pngjsCodec.encode(await pngjsCodec.decode(expected));
    // sanity: ensure the bytes really differ so we don't hit the equals fast path
    const differ = expected.length !== actual.length || !expected.equals(actual);
    const r = await run({ expected, captures: [actual] });
    const result = await r.promise;
    expect(result.matches).toBe(true);
    if (differ) expect(r.codec.decodes).toBe(2);
  });

  it('static failure: repeated identical actual decodes expected+actual once total', async () => {
    const expected = await png(solid(10, 10, 0, 0, 0));
    const actual = await png(solid(10, 10, 255, 0, 0));
    const r = await run({ expected, captures: [actual], options: { timeout: 200, interval: 50 } });
    const err = await r.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VisualMismatchError);
    expect(r.codec.decodes).toBe(2); // one expected, one actual — rest hit the equals fast path
    expect(r.codec.encodes).toBe(1); // single final diff
    expect((err as VisualMismatchError).attempts).toBeGreaterThan(1);
  });

  it('changing failures: expected decodes once, each unique actual decodes once', async () => {
    const expected = await png(solid(8, 8, 0, 0, 0));
    // Unique actual per attempt (vary one pixel) so the equals fast path never hits.
    const captures = async (): Promise<Buffer> => png(image(8, 8, (x, y) => (x === 0 && y === 0 ? [tick, tick, tick, 255] : [255, 0, 0, 255])));
    let tick = 1;
    const wrapped = async (remaining: number) => { tick++; return captures(remaining); };
    const r = await run({ expected, captures: wrapped, options: { timeout: 200, interval: 50 } });
    const err = await r.promise.catch((e: unknown) => e);
    const attempts = (err as VisualMismatchError).attempts;
    expect(r.codec.decodes).toBe(1 + attempts); // expected once + each unique actual
    expect(r.codec.encodes).toBe(1);
  });

  it('a later match returns immediately and does not sleep again', async () => {
    const expected = await png(solid(4, 4, 0, 0, 0));
    const bad = await png(solid(4, 4, 255, 255, 255));
    const r = await run({ expected, captures: [bad, bad, expected], options: { timeout: 1000 } });
    const result = await r.promise;
    expect(result.matches).toBe(true);
    expect(result.attempts).toBe(3);
    expect(r.clock.sleeps).toBe(2); // slept after the two failures, not after the match
  });

  it('timeout 0 still attempts one screenshot then fails', async () => {
    const expected = await png(solid(4, 4, 0, 0, 0));
    const bad = await png(solid(4, 4, 255, 255, 255));
    const r = await run({ expected, captures: [bad], options: { timeout: 0 } });
    const err = await r.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VisualMismatchError);
    expect((err as VisualMismatchError).attempts).toBe(1);
    expect(r.clock.sleeps).toBe(0);
  });

  it('final failure exposes actual + diff PNG buffers and JSON-safe detail', async () => {
    const expected = await png(solid(6, 6, 0, 0, 0));
    const actual = await png(solid(6, 6, 255, 0, 0));
    const r = await run({ expected, captures: [actual], options: { timeout: 100 } });
    const err = (await r.promise.catch((e: unknown) => e)) as VisualMismatchError;
    expect(err.code).toBe(ErrorCode.VISUAL_MISMATCH);
    expect(err.actual.equals(actual)).toBe(true);
    const decodedDiff = await pngjsCodec.decode(err.diff);
    expect(decodedDiff.width).toBe(6);
    expect(err.detail).toMatchObject({ expectedPath: 'baseline.png', diffPixels: 36 });
    expect(() => JSON.stringify(err.detail)).not.toThrow();
  });

  it('dimension mismatch produces a typed error and a union-sized diff', async () => {
    const expected = await png(solid(4, 4, 0, 0, 0));
    const actual = await png(solid(6, 4, 0, 0, 0));
    const r = await run({ expected, captures: [actual], options: { timeout: 0 } });
    const err = (await r.promise.catch((e: unknown) => e)) as VisualMismatchError;
    expect(err.comparison.dimensionMismatch).toBe(true);
    const diff = await pngjsCodec.decode(err.diff);
    expect(diff.width).toBe(6);
    expect(err.message).toContain('dimensions differ');
  });

  it('capture/driver errors propagate instead of becoming a mismatch', async () => {
    const expected = await png(solid(4, 4, 0, 0, 0));
    const boom = new CraftdriverError(ErrorCode.DRIVER_ERROR, 'transport exploded');
    const r = await run({ expected, captures: async () => { throw boom; }, options: { timeout: 100 } });
    const err = await r.promise.catch((e: unknown) => e);
    expect(err).toBe(boom);
  });

  it('rejects an interval below 10 ms', async () => {
    const expected = await png(solid(4, 4, 0, 0, 0));
    const r = await run({ expected, captures: [expected], options: { interval: 5 } });
    const err = await r.promise.catch((e: unknown) => e);
    expect((err as CraftdriverError).code).toBe(ErrorCode.INVALID_ARGUMENT);
  });
});
