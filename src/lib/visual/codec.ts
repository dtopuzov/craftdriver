/**
 * Internal codec boundary for visual testing.
 *
 * All PNG-library-specific code lives behind this interface so the rest of the
 * visual pipeline works on normalized, decoded RGBA pixels and never sees the
 * concrete codec (currently pngjs). Keeping the seam narrow means a future codec
 * can be evaluated without touching the comparison, diff, or retry code, and no
 * codec type is ever exposed on the public API.
 */

/** A decoded image normalized to a fresh 8-bit RGBA byte view. */
export interface DecodedImage {
  width: number;
  height: number;
  /** Row-major RGBA, exactly `width * height * 4` bytes. */
  data: Uint8Array;
}

/** Minimal decode/encode contract implemented by {@link pngjsCodec}. */
export interface PngCodec {
  /** Decode a compressed PNG to normalized 8-bit RGBA. */
  decode(buffer: Uint8Array): Promise<DecodedImage>;
  /** Encode normalized 8-bit RGBA back to a compressed PNG. */
  encode(image: DecodedImage): Promise<Buffer>;
}
