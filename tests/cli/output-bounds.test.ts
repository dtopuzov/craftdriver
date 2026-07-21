/**
 * Output bounds, enforced where values are produced rather than per transport.
 *
 * Bounded agent-facing output is a product claim, but it was only ever
 * enforced on the MCP envelope. The same `eval` that produced a 32 KB-capped
 * MCP result produced a roughly 1 MB daemon response, read into an unbounded
 * client buffer and printed in full — and MCP *failures* skipped the cap
 * entirely, so page-derived error text bypassed it.
 *
 * Truncation must stay visible: a shortened value carries its byte counts, so
 * an agent can tell a short answer from a shortened one.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  boundValue,
  boundString,
  clampLimit,
  truncateUtf8,
  utf8Bytes,
  DEFAULT_MAX_RESULT_BYTES,
  MAX_LIST_LIMIT,
  MAX_TEXT_CHARS,
} from '../../src/cli/bounds';
import { ArtifactStore, ArtifactQuotaError } from '../../src/cli/mcp/artifacts';
import { serializeToolFailure } from '../../src/cli/mcp/server';
import { CraftdriverError, ErrorCode } from '../../src/lib/errors';
import { toWireError } from '../../src/cli/daemon';

const artifactRoots: string[] = [];

afterEach(async () => {
  await Promise.all(artifactRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function artifactStore(limits: { maxArtifacts?: number; maxTotalBytes?: number }) {
  const root = await mkdtemp(join(tmpdir(), 'craftdriver-quota-test-'));
  artifactRoots.push(root);
  return new ArtifactStore(root, limits);
}

describe('boundValue', () => {
  it('passes a small value through untouched', () => {
    expect(boundValue('ok')).toBe('ok');
    expect(boundValue({ a: 1 })).toEqual({ a: 1 });
    expect(boundValue(null)).toBeNull();
    expect(boundValue(42)).toBe(42);
  });

  it('bounds the megabyte string an eval can return', () => {
    // The reproduction: `eval` handing back a large innerHTML.
    const huge = 'x'.repeat(1024 * 1024);
    const bounded = boundValue(huge) as Record<string, unknown>;

    expect(bounded.truncated).toBe(true);
    expect(bounded.totalBytes).toBe(1024 * 1024);
    expect(bounded.retainedBytes).toBeLessThanOrEqual(DEFAULT_MAX_RESULT_BYTES);
    expect(utf8Bytes(bounded.value as string)).toBeLessThanOrEqual(DEFAULT_MAX_RESULT_BYTES);
  });

  it('reports the full size so a shortened answer is distinguishable', () => {
    const bounded = boundValue('y'.repeat(100_000)) as Record<string, unknown>;
    expect(bounded.totalBytes).toBe(100_000);
    expect(bounded.retainedBytes).toBeLessThan(bounded.totalBytes as number);
  });

  it('bounds an oversized object rather than trimming it structurally', () => {
    // A structurally trimmed object still looks like a complete answer.
    const bounded = boundValue({ rows: Array.from({ length: 50_000 }, (_, i) => i) }) as
      Record<string, unknown>;
    expect(bounded.truncated).toBe(true);
    expect(typeof bounded.value).toBe('string');
  });

  it('honours an explicit budget', () => {
    const bounded = boundValue('z'.repeat(5000), 1024) as Record<string, unknown>;
    expect(utf8Bytes(bounded.value as string)).toBeLessThanOrEqual(1024);
  });
});

describe('truncateUtf8', () => {
  it('never splits a multi-byte character', () => {
    // Four-byte emoji against a budget that lands mid-character.
    const text = '😀😀😀';
    const cut = truncateUtf8(text, 6);
    expect(utf8Bytes(cut)).toBeLessThanOrEqual(6);
    expect(cut).toBe('😀');
    expect(cut).not.toContain('�');
  });

  it('returns a string already within budget unchanged', () => {
    expect(truncateUtf8('short', 1000)).toBe('short');
  });
});

describe('clampLimit', () => {
  it('pulls a negative limit up to something answerable', () => {
    // `--limit -5` silently returned nothing.
    expect(clampLimit(-5, 20)).toBe(1);
  });

  it('caps a huge limit rather than defeating paging', () => {
    expect(clampLimit(1e9, 20)).toBe(MAX_LIST_LIMIT);
  });

  it('falls back when the value is not a number', () => {
    expect(clampLimit(Number.NaN, 20)).toBe(20);
  });

  it('passes a sensible limit through', () => {
    expect(clampLimit(50, 20)).toBe(50);
  });

  it('does not impose the row cap on a character budget', () => {
    // `text` takes a character limit defaulting to 2000. Clamping it to the
    // list cap silently halved the documented default and capped any larger
    // request at 1000.
    expect(clampLimit(2000, 2000, MAX_TEXT_CHARS)).toBe(2000);
    expect(clampLimit(5000, 2000, MAX_TEXT_CHARS)).toBe(5000);
    expect(clampLimit(1e9, 2000, MAX_TEXT_CHARS)).toBe(MAX_TEXT_CHARS);
  });
});

describe('boundString', () => {
  it('keeps one shape whether or not the value was truncated', () => {
    const short = boundString('hello');
    const long = boundString('x'.repeat(100_000));

    // Same keys either way — a caller reads .value and checks .truncated
    // without type-testing first.
    expect(Object.keys(short).sort()).toEqual(Object.keys(long).sort());
    expect(short).toEqual({ value: 'hello', truncated: false, total: 5 });
    expect(long.truncated).toBe(true);
    expect(long.total).toBe(100_000);
    expect((long.value as string).length).toBeLessThan(100_000);
  });

  it('keeps an absent attribute null rather than an empty string', () => {
    // `attr` on a missing attribute must stay distinguishable from one set
    // to "".
    expect(boundString(null)).toEqual({ value: null, truncated: false, total: 0 });
  });

  it('applies a character request without bypassing the global byte ceiling', () => {
    const bounded = boundString('x'.repeat(100_000), { maxChars: MAX_TEXT_CHARS });
    expect(bounded.truncated).toBe(true);
    expect(bounded.total).toBe(100_000);
    expect(utf8Bytes(bounded.value as string)).toBeLessThanOrEqual(DEFAULT_MAX_RESULT_BYTES);
  });

  it('reports truncation when the caller asks for fewer characters', () => {
    expect(boundString('abcdefghij', { maxChars: 5 })).toEqual({
      value: 'abcde',
      truncated: true,
      total: 10,
    });
  });
});

describe('MCP failure results', () => {
  it('bounds an error carrying a large page-derived message', () => {
    // An assertion message quoting a whole element used to bypass the cap.
    const error = new CraftdriverError(ErrorCode.NO_MATCH, 'x'.repeat(200_000));
    const result = serializeToolFailure(error, 8 * 1024);

    expect(result.isError).toBe(true);
    expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(8 * 1024);
  });

  it('still reports the error code and reads as a failure', () => {
    const error = new CraftdriverError(ErrorCode.NO_MATCH, 'nothing matched #missing');
    const result = serializeToolFailure(error);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(ErrorCode.NO_MATCH);
  });
});

describe('CLI/daemon failure results', () => {
  it('bounds page-derived messages and structured details before transport', () => {
    const wire = toWireError(new CraftdriverError(
      ErrorCode.DRIVER_ERROR,
      'x'.repeat(200_000),
      { detail: { page: 'y'.repeat(200_000) } },
    ));
    expect(utf8Bytes(JSON.stringify(wire))).toBeLessThanOrEqual(DEFAULT_MAX_RESULT_BYTES);
    expect(wire.message.endsWith('…')).toBe(true);
    expect(wire.detail).toMatchObject({ truncated: true });
  });

  it('turns circular detail into a serializable diagnostic', () => {
    const detail: Record<string, unknown> = {};
    detail.self = detail;
    const wire = toWireError(new CraftdriverError(
      ErrorCode.DRIVER_ERROR,
      'boom',
      { detail },
    ));
    expect(() => JSON.stringify(wire)).not.toThrow();
    expect(wire.detail).toMatchObject({ truncated: true });
  });
});

describe('artifact store quota', () => {
  it('refuses a write that would exceed the total size budget', async () => {
    const store = await artifactStore({ maxTotalBytes: 16 });
    // Use a small injected budget; allocating 257 MiB made the unit test itself
    // a memory-pressure hazard while proving the same comparison.
    await expect(store.write('big.bin', Buffer.alloc(17)))
      .rejects.toBeInstanceOf(ArtifactQuotaError);
  });

  it('accounts browser-written screenshots by their actual size', async () => {
    const store = await artifactStore({ maxTotalBytes: 16 });
    const path = await store.allocate('screenshot.png');
    await writeFile(path, Buffer.alloc(17));

    await expect(store.commitAllocated(path)).rejects.toBeInstanceOf(ArtifactQuotaError);
    // The refused screenshot releases its count reservation, so the session is
    // not poisoned after one oversized capture.
    await expect(store.allocate('next.png')).resolves.toContain('next.png');
  });
});
