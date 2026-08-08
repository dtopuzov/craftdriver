/**
 * One failure shape for every agent transport.
 *
 * The daemon socket, the CLI's own output and a batch step all report a
 * failure the same way: a stable `code`, a bounded message, and the hint,
 * detail and recovery snapshot the error carried. Kept in its own module so
 * the session can produce one without importing the daemon.
 *
 * Everything here is bounded. An error message quotes page-derived text — a
 * selector, an element, a driver's stack dump — so an unbounded failure is a
 * page-controlled payload on the wire.
 */
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import { truncateUtf8, utf8Bytes } from './bounds.js';

export interface WireError {
  code: string;
  message: string;
  hint?: string;
  detail?: Record<string, unknown>;
  recoverySnapshot?: string;
}

const MAX_ERROR_MESSAGE_BYTES = 16 * 1024;
const MAX_ERROR_HINT_BYTES = 4 * 1024;
const MAX_ERROR_DETAIL_BYTES = 8 * 1024;
const MAX_ERROR_RECOVERY_BYTES = 12 * 1024;

function boundErrorText(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const marker = '…';
  return truncateUtf8(text, maxBytes - utf8Bytes(marker)) + marker;
}

function stripDriverStacks(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new TypeError('circular error detail');
  seen.add(value);
  if (Array.isArray(value)) return value.map((child) => stripDriverStacks(child, seen));
  const compact: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase() === 'stacktrace' || key.toLowerCase() === 'stack') continue;
    compact[key] = stripDriverStacks(child, seen);
  }
  return compact;
}

function boundErrorDetail(detail: Record<string, unknown>): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(stripDriverStacks(detail));
  } catch {
    return { truncated: true, preview: '[unserializable error detail]' };
  }
  if (utf8Bytes(serialized) <= MAX_ERROR_DETAIL_BYTES) {
    const parsed = JSON.parse(serialized) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  }
  const preview = truncateUtf8(serialized, MAX_ERROR_DETAIL_BYTES);
  return {
    truncated: true,
    totalBytes: utf8Bytes(serialized),
    retainedBytes: utf8Bytes(preview),
    preview,
  };
}

export function toWireError(err: unknown): WireError {
  if (err instanceof CraftdriverError) {
    const out: WireError = {
      code: err.code,
      message: boundErrorText(err.message, MAX_ERROR_MESSAGE_BYTES),
    };
    if (err.hint) out.hint = boundErrorText(err.hint, MAX_ERROR_HINT_BYTES);
    if (err.detail) out.detail = boundErrorDetail(err.detail);
    if (err.recoverySnapshot) {
      out.recoverySnapshot = boundErrorText(err.recoverySnapshot, MAX_ERROR_RECOVERY_BYTES);
    }
    return out;
  }
  if (err instanceof Error) {
    return {
      code: ErrorCode.DRIVER_ERROR,
      message: boundErrorText(err.message, MAX_ERROR_MESSAGE_BYTES),
    };
  }
  return {
    code: ErrorCode.DRIVER_ERROR,
    message: boundErrorText(String(err), MAX_ERROR_MESSAGE_BYTES),
  };
}
