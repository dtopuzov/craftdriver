/**
 * Transport-neutral output bounds for the agent surface.
 *
 * Bounded, token-efficient output is a product contract, not an MCP feature.
 * It was only ever enforced on the MCP envelope, so the same `eval` that
 * produced a 32 KB-capped MCP result produced a ~1 MB daemon response, read
 * into an unbounded client buffer, printed in full. The bound belongs where
 * the value is produced, so every transport inherits it.
 *
 * Truncation is always visible: a shortened value carries `truncated` and the
 * byte counts, so an agent can tell a short answer from a shortened one.
 * Cuts land on code-point boundaries — splitting a multi-byte sequence would
 * emit a replacement character, or an unparseable frame.
 */

/** Cap on a single command result. */
export const DEFAULT_MAX_RESULT_BYTES = 32 * 1024;

/** Cap on `--ephemeral` stdin, which is read whole into memory. */
export const MAX_STDIN_BYTES = 1024 * 1024;

/** Largest `--limit` a list-returning command will honour. */
export const MAX_LIST_LIMIT = 1000;

/**
 * Largest `--limit` a *character*-limited command will honour.
 *
 * Separate from the list cap because they count different things: `text`
 * takes a character budget whose default is already 2000, so clamping it to
 * the row cap silently halved it. The result is still bounded by
 * `resolveMaxResultBytes` regardless of what is asked for here.
 */
export const MAX_TEXT_CHARS = 100_000;

export function resolveMaxResultBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CRAFTDRIVER_MAX_RESULT_BYTES;
  if (!raw) return DEFAULT_MAX_RESULT_BYTES;
  const n = Number.parseInt(raw, 10);
  // A cap below the smallest useful payload would make every result a
  // truncation notice, so ignore nonsense rather than honouring it.
  return Number.isFinite(n) && n >= 1024 ? n : DEFAULT_MAX_RESULT_BYTES;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Truncate to at most `maxBytes` of UTF-8, never splitting a character.
 *
 * Iterates code points (so a surrogate pair is kept whole) and stops before
 * the budget is exceeded. A string already within budget is returned as-is.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(text) <= maxBytes) return text;

  let used = 0;
  let out = '';
  for (const char of text) {
    const size = utf8Bytes(char);
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

export interface BoundedValue {
  value: unknown;
  truncated: true;
  /** Bytes the full value would have occupied once serialized. */
  totalBytes: number;
  /** Bytes actually retained. */
  retainedBytes: number;
}

/**
 * Bound one command result value.
 *
 * A string is truncated in place, which keeps the common case (`eval`
 * returning a long string, `text` on a large element) readable. Anything else
 * is serialized and replaced by a bounded preview, because trimming an
 * arbitrary object structurally would produce something that still looks like
 * a complete answer.
 */
export function boundValue(value: unknown, maxBytes = resolveMaxResultBytes()): unknown | BoundedValue {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const total = utf8Bytes(value);
    if (total <= maxBytes) return value;
    const kept = truncateUtf8(value, maxBytes);
    return { value: kept, truncated: true, totalBytes: total, retainedBytes: utf8Bytes(kept) };
  }

  if (typeof value !== 'object') return value;

  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  const total = utf8Bytes(serialized);
  if (total <= maxBytes) return value;

  const preview = truncateUtf8(serialized, maxBytes);
  return {
    value: preview,
    truncated: true,
    totalBytes: total,
    retainedBytes: utf8Bytes(preview),
  };
}

/**
 * Clamp a caller-supplied list limit.
 *
 * A negative limit silently returned nothing and a huge one defeated the
 * paging that keeps list output bounded, so both are pulled into range rather
 * than rejected — the agent asked for a list, and one it can read is a better
 * answer than an error.
 */
export function clampLimit(raw: number, fallback: number, max = MAX_LIST_LIMIT): number {
  if (!Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  return Math.min(n, max);
}

/**
 * One bounded string result.
 *
 * `text`, `attr` and `value` all return a string that the page controls, and
 * all three reported it differently once bounding was added — a bare string
 * under budget, a nested object over it. This keeps the shape identical
 * either way, so a caller reads `.value` and checks `.truncated` without
 * having to type-test first.
 */
export interface BoundedString {
  value: string | null;
  truncated: boolean;
  /** Length in characters of the untruncated string. */
  total: number;
}

export interface BoundStringOptions {
  /** Transport-neutral byte ceiling. */
  maxBytes?: number;
  /** Optional caller-visible character limit, such as `text --limit`. */
  maxChars?: number;
}

export function boundString(raw: string | null, options: BoundStringOptions = {}): BoundedString {
  if (raw === null) return { value: null, truncated: false, total: 0 };
  const charLimited = options.maxChars !== undefined && raw.length > options.maxChars
    ? raw.slice(0, options.maxChars)
    : raw;
  const kept = truncateUtf8(charLimited, options.maxBytes ?? resolveMaxResultBytes());
  return { value: kept, truncated: kept.length < raw.length, total: raw.length };
}
