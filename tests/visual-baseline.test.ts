import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile as fsReadFile, writeFile as fsWriteFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runExpectScreenshot,
  shouldUpdateVisualBaselines,
} from '../src/lib/visual/expectScreenshot.js';
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

/** Deterministic clock: sleeps advance virtual time; captures do not. */
function fakeClock() {
  const state = { t: 0, sleeps: 0 };
  return { state, now: () => state.t, sleep: async (ms: number) => { state.t += ms; state.sleeps++; } };
}

function enoent(): NodeJS.ErrnoException {
  const err = new Error("ENOENT: no such file or directory, open 'baselines/home.png'") as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

/** Run the assertion with baseline-management seams recorded rather than real. */
async function run(opts: {
  /** Baseline bytes on disk. Omit → readFile throws ENOENT (missing baseline). */
  expected?: Buffer;
  /** Force readFile to throw this instead (e.g. a permissions error). */
  readError?: unknown;
  captures: Buffer[] | ((remaining: number) => Promise<Buffer>);
  update?: boolean;
  options?: Parameters<typeof runExpectScreenshot>[0]['options'];
  defaultTimeout?: number;
}) {
  const clock = fakeClock();
  const writes: { path: string; data: Buffer }[] = [];
  const mkdirs: string[] = [];
  const reports: string[] = [];
  const remainings: number[] = [];
  let captureIdx = 0;
  const capture =
    typeof opts.captures === 'function'
      ? opts.captures
      : async (remaining: number): Promise<Buffer> => {
          remainings.push(remaining);
          const seq = opts.captures as Buffer[];
          return seq[Math.min(captureIdx++, seq.length - 1)];
        };

  const promise = runExpectScreenshot({
    expectedPath: 'baselines/home.png',
    options: opts.options ?? {},
    defaultTimeout: opts.defaultTimeout ?? 200,
    capture,
    update: opts.update,
    readFile: async () => {
      if (opts.readError !== undefined) throw opts.readError;
      if (opts.expected === undefined) throw enoent();
      return opts.expected;
    },
    writeFile: async (path: string, data: Buffer) => { writes.push({ path, data: Buffer.from(data) }); },
    rename: async (from: string, to: string) => {
      // Model the atomic swap: bytes written to the temp file now live at `to`,
      // so assertions can keep addressing the final destination path.
      const w = [...writes].reverse().find((entry) => entry.path === from);
      if (w) w.path = to;
    },
    unlink: async () => {},
    mkdir: async (dir: string) => { mkdirs.push(dir); return undefined; },
    report: (message: string) => { reports.push(message); },
    now: clock.now,
    sleep: clock.sleep,
    codec: pngjsCodec,
  });

  return { promise, writes, mkdirs, reports, remainings, clock: clock.state };
}

// ── Env-var parser ───────────────────────────────────────────────────────────

describe('shouldUpdateVisualBaselines', () => {
  it('treats unset / empty / false (any case, trimmed) as off', () => {
    for (const raw of [undefined, '', 'false', 'FALSE', '  false  ', 'False']) {
      expect(shouldUpdateVisualBaselines(raw)).toBe(false);
    }
  });

  it('treats true (any case, trimmed) as on', () => {
    for (const raw of ['true', 'TRUE', '  true  ', 'True']) {
      expect(shouldUpdateVisualBaselines(raw)).toBe(true);
    }
  });

  it('rejects anything else with INVALID_ARGUMENT rather than coercing it', () => {
    for (const raw of ['1', '0', 'yes', 'no', 'on', 'off', 'y']) {
      let thrown: unknown;
      try { shouldUpdateVisualBaselines(raw); } catch (e) { thrown = e; }
      expect((thrown as CraftdriverError)?.code).toBe(ErrorCode.INVALID_ARGUMENT);
      expect((thrown as Error)?.message).toContain('CRAFTDRIVER_UPDATE_VISUAL_BASELINES');
    }
  });
});

// ── Creating a missing baseline (always on) ──────────────────────────────────

describe('expectScreenshot creates a missing baseline', () => {
  it('writes the settled capture, reports it, and passes as "created"', async () => {
    const shot = await png(solid(4, 4, 10, 20, 30));
    // Two identical frames settle on the second capture.
    const r = await run({ captures: [shot, shot] });
    const result = await r.promise;

    expect(result.baseline).toBe('created');
    expect(result.matches).toBe(true);
    expect(result.diffPixels).toBe(0);
    expect(result.expectedWidth).toBe(4);
    expect(result.actualHeight).toBe(4);
    expect(result.attempts).toBe(2);

    expect(r.mkdirs).toEqual(['baselines']);
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].path).toBe('baselines/home.png');
    expect(r.writes[0].data.equals(shot)).toBe(true);
    expect(r.reports).toEqual(['Created visual baseline: baselines/home.png']);
  });

  it('keeps re-capturing until two frames match, then writes the settled one', async () => {
    const a = await png(solid(6, 6, 0, 0, 0));
    const b = await png(solid(6, 6, 1, 2, 3));
    // a → b (changed) → b (settled): writes b, never a.
    const r = await run({ captures: [a, b, b], options: { timeout: 200, interval: 50 } });
    const result = await r.promise;

    expect(result.attempts).toBe(3);
    expect(r.writes[0].data.equals(b)).toBe(true);
    expect(r.writes[0].data.equals(a)).toBe(false);
  });

  it('writes the single immediate capture when timeout is 0 (no settling possible)', async () => {
    const shot = await png(solid(4, 4, 5, 5, 5));
    const r = await run({ captures: [shot], options: { timeout: 0 } });
    const result = await r.promise;

    expect(result.baseline).toBe('created');
    expect(result.attempts).toBe(1);
    expect(r.clock.sleeps).toBe(0);
    expect(r.writes[0].data.equals(shot)).toBe(true);
    // A single, deliberately-unsettled capture is still flagged — never silent.
    expect(r.reports[0]).toContain('did not settle');
  });

  it('passes the remaining assertion budget to each capture (bounds visibility waits)', async () => {
    const shot = await png(solid(4, 4, 0, 0, 0));
    const r = await run({ captures: [shot, shot], defaultTimeout: 200 });
    await r.promise;
    // First capture gets the full budget so a not-yet-visible element can appear.
    expect(r.remainings[0]).toBe(200);
  });

  it('writes the final frame and flags it when the page never settles before the deadline', async () => {
    // Every capture is a distinct image → no two consecutive frames ever match.
    let n = 0;
    const captures = async (): Promise<Buffer> => png(solid(4, 4, n++, 0, 0));
    const r = await run({ captures, options: { timeout: 200, interval: 50 } });
    const result = await r.promise;

    // A baseline is still created (a live-region page is otherwise un-baselineable),
    // but the report says it never settled so the frame gets reviewed.
    expect(result.baseline).toBe('created');
    expect(result.matches).toBe(true);
    expect(result.attempts).toBeGreaterThan(1);
    expect(r.writes).toHaveLength(1);
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]).toContain('did not settle');
  });

  it('does NOT auto-create on a non-ENOENT read error — it propagates untouched', async () => {
    const shot = await png(solid(4, 4, 0, 0, 0));
    const boom = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const r = await run({ readError: boom, captures: [shot], update: true });
    await expect(r.promise).rejects.toBe(boom);
    expect(r.writes).toHaveLength(0);
    expect(r.mkdirs).toHaveLength(0);
  });
});

// ── Updating an existing baseline (opt-in) ───────────────────────────────────

describe('expectScreenshot updates an existing baseline only when asked', () => {
  it('passes as "matched" and never writes when the baseline matches', async () => {
    const shot = await png(solid(4, 4, 7, 7, 7));
    const r = await run({ expected: shot, captures: [shot], update: true });
    const result = await r.promise;
    expect(result.baseline).toBe('matched');
    expect(r.writes).toHaveLength(0);
    expect(r.reports).toHaveLength(0);
  });

  it('overwrites a differing baseline with the final actual and passes as "updated"', async () => {
    const base = await png(solid(8, 8, 0, 0, 0));
    const changed = await png(solid(8, 8, 255, 0, 0));
    const r = await run({ expected: base, captures: [changed], update: true, options: { timeout: 100 } });
    const result = await r.promise;

    expect(result.baseline).toBe('updated');
    expect(result.matches).toBe(true);
    expect(result.diffPixels).toBe(0); // state relative to the new baseline
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0].data.equals(changed)).toBe(true);
    expect(r.mkdirs).toHaveLength(0); // the directory already exists
    expect(r.reports[0]).toContain('Updated visual baseline: baselines/home.png');
    expect(r.reports[0]).toContain('changed');
  });

  it('does NOT rewrite when a differing page settles back into a match under update mode', async () => {
    const base = await png(solid(4, 4, 0, 0, 0));
    const bad = await png(solid(4, 4, 255, 255, 255));
    // bad, bad, then matches base → returns "matched" with no baseline churn.
    const r = await run({ expected: base, captures: [bad, bad, base], update: true, options: { timeout: 1000 } });
    const result = await r.promise;
    expect(result.baseline).toBe('matched');
    expect(r.writes).toHaveLength(0);
    expect(r.reports).toHaveLength(0);
  });

  it('updates on a dimension mismatch too (writes the new-sized actual)', async () => {
    const base = await png(solid(4, 4, 0, 0, 0));
    const resized = await png(solid(6, 4, 0, 0, 0));
    const r = await run({ expected: base, captures: [resized], update: true, options: { timeout: 0 } });
    const result = await r.promise;
    expect(result.baseline).toBe('updated');
    expect(result.expectedWidth).toBe(6);
    expect(r.writes[0].data.equals(resized)).toBe(true);
  });

  it('still throws VisualMismatchError on a mismatch when update mode is off', async () => {
    const base = await png(solid(6, 6, 0, 0, 0));
    const changed = await png(solid(6, 6, 255, 0, 0));
    const r = await run({ expected: base, captures: [changed], options: { timeout: 50 } });
    await expect(r.promise).rejects.toBeInstanceOf(VisualMismatchError);
    expect(r.writes).toHaveLength(0);
  });

  it('never overwrites a present-but-corrupt baseline, even under update mode', async () => {
    const shot = await png(solid(4, 4, 0, 0, 0));
    const corrupt = Buffer.from('this is not a PNG at all, just some bytes here padding padding');
    const r = await run({ expected: corrupt, captures: [shot], update: true, options: { timeout: 0 } });
    const err = (await r.promise.catch((e: unknown) => e)) as CraftdriverError;
    expect(err.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(err.detail).toMatchObject({ source: 'baseline' });
    expect(r.writes).toHaveLength(0);
  });

  it('a failed atomic replace leaves the committed baseline byte-for-byte intact', async () => {
    // Real filesystem: only the rename (the atomic swap) fails. The temp file is
    // fully written, then the swap errors — the original baseline must survive.
    const dir = await mkdtemp(join(tmpdir(), 'craftdriver-atomic-'));
    try {
      const path = join(dir, 'home.png');
      const original = await png(solid(4, 4, 1, 2, 3));
      await fsWriteFile(path, original);
      const changed = await png(solid(4, 4, 9, 9, 9));

      const boom = new Error('rename failed mid-swap');
      await expect(
        runExpectScreenshot({
          expectedPath: path,
          options: { timeout: 0 },
          defaultTimeout: 0,
          capture: async () => changed,
          update: true,
          rename: async () => {
            throw boom;
          },
          report: () => {},
          codec: pngjsCodec,
        })
      ).rejects.toBe(boom);

      // The committed baseline is unchanged…
      expect((await fsReadFile(path)).equals(original)).toBe(true);
      // …and the temp file was cleaned up, leaving only the baseline behind.
      expect(await readdir(dir)).toEqual(['home.png']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
