/**
 * Cheap, allocation-bounding PNG validation performed *before* a buffer is
 * handed to pngjs.
 *
 * This is deliberately not a decoder. It reads only the 8-byte signature and
 * the fixed-layout IHDR chunk to learn the declared dimensions, so a
 * hostile/corrupt header cannot make the decoder allocate a huge RGBA array
 * before the real (CRC-checked) decode runs. Both limits are enforced with
 * overflow-safe arithmetic. The same checks apply to the baseline and to every
 * unique actual screenshot.
 */

import { CraftdriverError, ErrorCode } from '../errors.js';

/** 8-byte PNG magic signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Byte offset of the IHDR chunk's length field (immediately after the signature). */
const IHDR_LENGTH_OFFSET = 8;
/** IHDR chunk data is a fixed 13 bytes. */
const IHDR_DATA_LENGTH = 13;
/** Minimum bytes we must see to read the full IHDR: sig + len(4) + type(4) + data(13) + crc(4). */
const MIN_HEADER_BYTES = IHDR_LENGTH_OFFSET + 4 + 4 + IHDR_DATA_LENGTH + 4;

export interface PngSizeLimits {
  maxImagePixels: number;
  maxInputBytes: number;
}

/** Where this buffer came from, for a clearer error message. */
export type PngSource = 'baseline' | 'screenshot';

function fail(source: PngSource, message: string, detail?: Record<string, unknown>): never {
  throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, `${source} ${message}`, {
    detail: { source, ...detail },
  });
}

/**
 * Validate a compressed PNG's signature, IHDR, declared dimensions, and both
 * size limits. Returns the parsed dimensions so callers can reuse them. Throws
 * {@link CraftdriverError} with `INVALID_ARGUMENT` on any violation.
 */
export function validatePngHeaderAndSize(
  buffer: Uint8Array,
  limits: PngSizeLimits,
  source: PngSource
): { width: number; height: number } {
  if (buffer.length > limits.maxInputBytes) {
    fail(source, `PNG is ${buffer.length} bytes, exceeding the ${limits.maxInputBytes}-byte limit.`, {
      inputBytes: buffer.length,
      maxInputBytes: limits.maxInputBytes,
    });
  }

  if (buffer.length < MIN_HEADER_BYTES) {
    fail(source, 'PNG is too small to contain a valid header.', { inputBytes: buffer.length });
  }

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(source, 'buffer is not a PNG (bad signature).');
  }

  const ihdrLength = buf.readUInt32BE(IHDR_LENGTH_OFFSET);
  const ihdrType = buf.toString('ascii', IHDR_LENGTH_OFFSET + 4, IHDR_LENGTH_OFFSET + 8);
  if (ihdrType !== 'IHDR' || ihdrLength !== IHDR_DATA_LENGTH) {
    fail(source, 'PNG has an invalid IHDR chunk.', { ihdrType, ihdrLength });
  }

  const dataOffset = IHDR_LENGTH_OFFSET + 8;
  const width = buf.readUInt32BE(dataOffset);
  const height = buf.readUInt32BE(dataOffset + 4);

  if (width === 0 || height === 0) {
    fail(source, `PNG has zero dimension (${width}x${height}).`, { width, height });
  }

  // Overflow-safe: compare against the limit using division so width*height
  // never overflows a JS safe integer for adversarial 2^32-scale dimensions.
  if (width > limits.maxImagePixels || height > limits.maxImagePixels / width) {
    fail(
      source,
      `PNG is ${width}x${height} pixels, exceeding the ${limits.maxImagePixels}-pixel limit.`,
      { width, height, pixels: width * height, maxImagePixels: limits.maxImagePixels }
    );
  }

  return { width, height };
}
