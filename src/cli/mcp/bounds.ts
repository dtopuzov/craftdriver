/**
 * Total response bounds for MCP tool results.
 *
 * Spilling a large `content` block to an artifact bounds what the *model*
 * reads, but not what crosses the wire: the same value was still attached in
 * full as `structuredContent`, so a 50 KB eval produced a 50,571-byte response
 * with a 514-byte preview in front of it. Bounding one half of the payload
 * while duplicating the other in full is worse than not bounding at all,
 * because it looks bounded.
 *
 * So the cap here is on the **complete serialized response**, and the rules
 * are:
 *
 * - **Never duplicate a large value.** If the preview already describes it,
 *   `structuredContent` carries metadata and a bounded preview, not the value.
 * - **Truncation is always visible.** `truncated`, `totalBytes` and the
 *   retained byte count are part of the payload, so an agent can tell a short
 *   answer from a shortened one.
 * - **Never emit invalid UTF-8.** Cutting at a byte offset can split a
 *   multi-byte sequence or a surrogate pair and produce a replacement
 *   character — or an unparseable frame. Truncation happens on code-point
 *   boundaries.
 */

import { utf8Bytes, truncateUtf8 } from '../bounds.js';

/** Cap on one complete serialized `tools/call` result. */
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;

export function resolveMaxResponseBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CRAFTDRIVER_MCP_MAX_RESPONSE_BYTES;
  if (!raw) return DEFAULT_MAX_RESPONSE_BYTES;
  const n = Number.parseInt(raw, 10);
  // A cap below the smallest useful envelope would make every response a
  // truncation notice, so ignore nonsense rather than honouring it.
  return Number.isFinite(n) && n >= 1024 ? n : DEFAULT_MAX_RESPONSE_BYTES;
}

// The byte-counting and code-point-safe truncation primitives are shared with
// the transport-neutral bound in `../bounds.js`; re-exported here so the MCP
// module stays the single import for callers working on its envelope.
export { utf8Bytes, truncateUtf8 } from '../bounds.js';

/** Serialized size of a value as it would appear in the response. */
function serializedBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return utf8Bytes(JSON.stringify(value) ?? '');
  } catch {
    // Circular or otherwise unserializable: treat as over budget so the
    // caller replaces it rather than throwing while building a response.
    return Number.POSITIVE_INFINITY;
  }
}

export interface BoundedStructured {
  truncated: true;
  /** Bytes the full value would have occupied. */
  totalBytes: number;
  /** Bytes actually retained in `preview`. */
  previewBytes: number;
  preview: string;
}

/**
 * Replace an oversized structured value with a bounded, self-describing
 * preview.
 */
export function boundStructured(value: unknown, budgetBytes: number): BoundedStructured {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  const preview = truncateUtf8(serialized, Math.max(budgetBytes, 0));
  return {
    truncated: true,
    totalBytes: utf8Bytes(serialized),
    previewBytes: utf8Bytes(preview),
    preview,
  };
}

/**
 * The minimum shape this needs. Kept structural and generic so the caller's
 * richer `ContentBlock`/`ToolCallResult` types pass through unchanged rather
 * than being widened to a local copy.
 */
interface BoundableResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * Bound a complete tool result to `maxBytes` of serialized JSON.
 *
 * Order matters. `structuredContent` is reduced first because `content` is
 * what the agent actually reads and has usually already been spilled to an
 * artifact with a path in it — dropping that first would take away the pointer
 * to the full data while keeping the bulk. Only if the result is still over
 * budget are content blocks trimmed, newest-last, each keeping a marker so a
 * shortened block never reads as a complete one.
 */
export function boundToolResult<T extends BoundableResult>(result: T, maxBytes: number): T {
  if (serializedBytes(result) <= maxBytes) return result;

  const bounded = { ...result } as T;

  if (bounded.structuredContent !== undefined) {
    // Leave room for the content blocks and the envelope; a quarter of the
    // budget is enough for a preview to be useful without crowding out the
    // text the agent reads.
    const structuredBudget = Math.floor(maxBytes / 4);
    bounded.structuredContent = boundStructured(bounded.structuredContent, structuredBudget);
  }

  if (serializedBytes(bounded) <= maxBytes) return bounded;

  // Still over: trim the text blocks. Work from the last block backwards, so
  // the primary result survives longer than a trailing snapshot diff.
  const blocks = bounded.content.map((block) => ({ ...block })) as T['content'];
  const marker = '\n… (truncated)';
  const over = (): number => serializedBytes({ ...bounded, content: blocks }) - maxBytes;

  for (let i = blocks.length - 1; i >= 0; i--) {
    if (over() <= 0) break;
    const block = blocks[i];
    if (typeof block.text !== 'string') continue;

    const original = block.text;
    let keep = Math.max(0, utf8Bytes(original) - over() - utf8Bytes(marker));
    // Converge rather than assuming one pass lands under the cap: JSON
    // escaping makes the serialized size exceed the raw byte count (a newline
    // is one byte but two characters once escaped), so a single subtraction
    // reliably overshoots by a little.
    for (let guard = 0; guard < 8; guard++) {
      block.text = keep > 0 ? truncateUtf8(original, keep) + marker : marker;
      const excess = over();
      if (excess <= 0 || keep === 0) break;
      keep = Math.max(0, keep - excess);
    }
  }
  bounded.content = blocks;

  return bounded;
}
