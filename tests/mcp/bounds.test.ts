/**
 * Total response bounds.
 *
 * The defect these exist for: `content` was spilled to a 514-byte preview
 * while the same value rode along in full as `structuredContent`, so a 50 KB
 * eval produced a 50,571-byte response that *looked* bounded. The tests below
 * pin that measured regression directly; no separate release repro is needed.
 */
import { describe, it, expect } from 'vitest';
import {
  boundToolResult,
  boundStructured,
  truncateUtf8,
  utf8Bytes,
  resolveMaxResponseBytes,
  DEFAULT_MAX_RESPONSE_BYTES,
} from '../../src/cli/mcp/bounds.js';

const bytes = (value: unknown): number => utf8Bytes(JSON.stringify(value));

describe('utf8-safe truncation', () => {
  it('keeps a string already within budget untouched', () => {
    expect(truncateUtf8('hello', 100)).toBe('hello');
  });

  it('never splits a multi-byte character', () => {
    // Each é is 2 bytes; a byte-offset slice at 5 would cut one in half.
    const text = 'ééééé';
    const out = truncateUtf8(text, 5);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(5);
    expect(out).toBe('éé');
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('never splits a surrogate pair', () => {
    // Emoji are 4 UTF-8 bytes and 2 UTF-16 code units; a naive slice(0, 1)
    // would yield a lone surrogate and serialize as a replacement character.
    const text = '👍👍👍';
    const out = truncateUtf8(text, 7);
    expect(out).toBe('👍');
    expect([...out]).toHaveLength(1);
    expect(out).not.toContain('�');
  });

  it('returns empty rather than a broken character for a tiny budget', () => {
    expect(truncateUtf8('👍', 3)).toBe('');
    expect(truncateUtf8('abc', 0)).toBe('');
  });

  it('round-trips through a UTF-8 buffer unchanged', () => {
    const out = truncateUtf8('naïve 👍 café ünïcøde', 20);
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });
});

describe('bounding a structured value', () => {
  it('reports what it dropped', () => {
    const big = { result: 'X'.repeat(50_000) };
    const out = boundStructured(big, 1_000);

    expect(out.truncated).toBe(true);
    expect(out.totalBytes).toBeGreaterThan(50_000);
    expect(out.previewBytes).toBeLessThanOrEqual(1_000);
    // A short answer and a shortened one must not look alike.
    expect(out.preview.length).toBeGreaterThan(0);
  });

  it('survives a circular value instead of throwing mid-response', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => boundStructured(circular, 100)).not.toThrow();
  });
});

describe('bounding a complete tool result', () => {
  const smallResult = {
    content: [{ type: 'text' as const, text: 'ok' }],
    structuredContent: { result: { ok: true } },
  };

  it('leaves a small result exactly as it was', () => {
    expect(boundToolResult(smallResult, DEFAULT_MAX_RESPONSE_BYTES)).toEqual(smallResult);
  });

  // The headline regression.
  it('bounds the whole response, not just the content blocks', () => {
    const payload = 'X'.repeat(50_000);
    const unbounded = {
      content: [{ type: 'text' as const, text: 'preview…\n(full output: /tmp/a.json, 50000 bytes)' }],
      structuredContent: { result: payload },
    };
    expect(bytes(unbounded)).toBeGreaterThan(50_000);

    const out = boundToolResult(unbounded, DEFAULT_MAX_RESPONSE_BYTES);
    expect(bytes(out)).toBeLessThanOrEqual(DEFAULT_MAX_RESPONSE_BYTES);
    // The value is not duplicated: the full payload is gone from the wire.
    expect(JSON.stringify(out)).not.toContain(payload);
    expect(out.structuredContent).toMatchObject({ truncated: true });
  });

  it('keeps the artifact pointer in content rather than the bulk', () => {
    const out = boundToolResult(
      {
        content: [{ type: 'text' as const, text: 'head…\n(full output: /tmp/big.json, 50000 bytes)' }],
        structuredContent: { result: 'Y'.repeat(50_000) },
      },
      DEFAULT_MAX_RESPONSE_BYTES,
    );
    // Dropping the pointer while keeping the bulk would be exactly backwards.
    expect(out.content[0].text).toContain('/tmp/big.json');
  });

  it('trims content blocks when structured bounding is not enough', () => {
    const out = boundToolResult(
      {
        content: [
          { type: 'text' as const, text: 'A'.repeat(40_000) },
          { type: 'text' as const, text: 'B'.repeat(40_000) },
        ],
        structuredContent: { result: 'C'.repeat(40_000) },
      },
      8_000,
    );

    expect(bytes(out)).toBeLessThanOrEqual(8_000);
    // A shortened block must never read as a complete one.
    expect(out.content.some((b) => b.text?.includes('truncated'))).toBe(true);
  });

  it('trims the trailing block before the primary result', () => {
    const out = boundToolResult(
      {
        content: [
          { type: 'text' as const, text: 'PRIMARY-' + 'A'.repeat(5_000) },
          { type: 'text' as const, text: 'DELTA-' + 'B'.repeat(40_000) },
        ],
      },
      8_000,
    );
    // The agent's primary answer survives longer than a trailing diff.
    expect(out.content[0].text).toContain('PRIMARY-');
  });

  it('produces valid UTF-8 even when cutting through emoji', () => {
    const out = boundToolResult(
      {
        content: [{ type: 'text' as const, text: '👍'.repeat(10_000) }],
        structuredContent: { result: '👍'.repeat(10_000) },
      },
      4_000,
    );
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('�');
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it('handles a result with no structuredContent', () => {
    const out = boundToolResult(
      { content: [{ type: 'text' as const, text: 'Z'.repeat(40_000) }] },
      4_000,
    );
    expect(bytes(out)).toBeLessThanOrEqual(4_000);
  });
});

describe('the cap is configurable but not sabotage-able', () => {
  it('defaults when unset', () => {
    expect(resolveMaxResponseBytes({})).toBe(DEFAULT_MAX_RESPONSE_BYTES);
  });

  it('honours a sensible override', () => {
    expect(resolveMaxResponseBytes({ CRAFTDRIVER_MCP_MAX_RESPONSE_BYTES: '8192' })).toBe(8192);
  });

  it.each([['0'], ['-1'], ['512'], ['nonsense'], ['']])(
    'ignores %s, which would make every response a truncation notice',
    (value) => {
      expect(
        resolveMaxResponseBytes({ CRAFTDRIVER_MCP_MAX_RESPONSE_BYTES: value }),
      ).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    },
  );
});
