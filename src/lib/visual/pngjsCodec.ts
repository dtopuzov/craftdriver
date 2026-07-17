/**
 * Isolated pngjs adapter — the single place that touches the CommonJS-shaped
 * `pngjs` API. The rest of craftdriver is ESM and works only with the
 * promise-based {@link PngCodec} and normalized {@link DecodedImage} defined in
 * `./codec`; pngjs types never leak past this file.
 *
 * Decode and encode both use pngjs's asynchronous stream APIs (`parse` /
 * `pack`) rather than the synchronous variants, so a large image cannot block
 * the event loop inside a single call. CRC checking is left at pngjs's default
 * (enabled) so corrupt chunks are rejected rather than silently decoded.
 *
 * Maintenance risk (recorded, not hidden): `pngjs@7.0.0` is pinned exactly. It
 * had no reported npm/OSV advisory as of 2026-07-17, but that is a timestamped
 * check, not proof of safety — its last release was 2023 and it publishes no
 * security policy. It relies on Node's built-in `zlib`, so keeping Node patched
 * is part of the posture. CI runs `npm audit --omit=dev`; this seam is kept
 * narrow (see `./codec`) so the codec can be replaced without touching callers
 * if the project goes unmaintained or an advisory lands.
 */

import { PNG } from 'pngjs';
import { CraftdriverError, ErrorCode } from '../errors.js';
import type { DecodedImage, PngCodec } from './codec.js';

function wrapDecodeError(cause: unknown): CraftdriverError {
  return new CraftdriverError(ErrorCode.INVALID_ARGUMENT, 'Failed to decode PNG image.', {
    cause,
    hint: 'The buffer is not a valid PNG, or its chunks failed CRC validation.',
  });
}

/**
 * Decode a compressed PNG buffer to a fresh, tightly-packed 8-bit RGBA view.
 *
 * pngjs always normalizes palette/grayscale/16-bit/interlaced inputs to 8-bit
 * RGBA in `png.data`, but that buffer may be a view into a larger pool. We copy
 * into a right-sized `Uint8Array` so downstream code can rely on
 * `data.length === width * height * 4` and on a predictable backing buffer.
 */
function decode(buffer: Uint8Array): Promise<DecodedImage> {
  return new Promise<DecodedImage>((resolve, reject) => {
    const png = new PNG();
    const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    png.parse(input, (err, decoded) => {
      if (err || !decoded) {
        reject(wrapDecodeError(err ?? new Error('pngjs produced no image')));
        return;
      }
      const { width, height } = decoded;
      const expected = width * height * 4;
      const data = new Uint8Array(expected);
      data.set(decoded.data.subarray(0, expected));
      resolve({ width, height, data });
    });
  });
}

/** Encode normalized 8-bit RGBA back to a compressed PNG buffer. */
function encode(image: DecodedImage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const png = new PNG({ width: image.width, height: image.height });
    // pngjs owns a Buffer at png.data of the right length; fill it in place.
    png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    const chunks: Buffer[] = [];
    png
      .pack()
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', (err: unknown) =>
        reject(
          new CraftdriverError(ErrorCode.DRIVER_ERROR, 'Failed to encode diff PNG image.', {
            cause: err,
          })
        )
      );
  });
}

export const pngjsCodec: PngCodec = { decode, encode };
