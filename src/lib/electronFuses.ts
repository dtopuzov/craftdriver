/**
 * Dependency-free reader for the Electron **fuse wire** — specifically the
 * `EnableNodeCliInspectArguments` fuse that main-process access
 * (`browser.electron.executeMain` / `mock` / `mockDialog` / `mainLogs`) needs. When
 * the main-process inspector can't be reached, this turns the generic "inspector
 * unreachable" into a precise "the fuse is disabled in this build."
 *
 * The wire format is @electron/fuses' own (verified against a real packaged app):
 * a 32-byte sentinel, then a 1-byte wire version, a 1-byte fuse count, then one
 * ASCII byte per fuse — `'0'` disabled, `'1'` enabled, `'r'` removed.
 * `EnableNodeCliInspectArguments` is fuse index 3. On macOS the wire lives in the
 * **Electron Framework**, not the app executable. We read the bytes directly rather
 * than take an `@electron/fuses` dependency (craftdriver keeps two runtime deps).
 *
 * Best-effort by design: any read/parse problem yields `'unknown'`, so this can only
 * ever *improve* a diagnostic, never invent or block one.
 */
import fs from 'node:fs';
import path from 'node:path';

/** @electron/fuses sentinel that precedes the fuse wire in a packaged binary. */
const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const FUSE_DISABLE = 0x30; // '0'
const FUSE_ENABLE = 0x31; // '1'
const FUSE_REMOVED = 0x72; // 'r'
/** Index of EnableNodeCliInspectArguments in the FuseV1 wire. */
const INSPECT_ARGS_INDEX = 3;

export type InspectFuseStatus = 'enabled' | 'disabled' | 'removed' | 'unknown';

/**
 * The binary that actually carries the fuse wire for a given app executable. On
 * macOS that's the Electron Framework inside the `.app`; elsewhere it's the
 * executable itself.
 */
export function fuseCarrierBinary(appBinaryPath: string): string {
  const FRAMEWORK = ['Frameworks', 'Electron Framework.framework', 'Electron Framework'];
  if (appBinaryPath.endsWith('.app')) {
    return path.join(appBinaryPath, 'Contents', ...FRAMEWORK);
  }
  if (appBinaryPath.includes('.app/') || appBinaryPath.includes(`.app${path.sep}`)) {
    // .../Contents/MacOS/<exe> -> .../Contents/Frameworks/Electron Framework.framework/…
    return path.resolve(appBinaryPath, '..', '..', ...FRAMEWORK);
  }
  return appBinaryPath;
}

/**
 * Read the `EnableNodeCliInspectArguments` fuse straight from the packaged binary.
 * Returns `'unknown'` for any older/unfused binary or on any read problem.
 */
export function readInspectArgumentsFuse(appBinaryPath: string | undefined): InspectFuseStatus {
  if (!appBinaryPath) return 'unknown';
  let fd: number | undefined;
  try {
    const binary = fuseCarrierBinary(appBinaryPath);
    if (!fs.existsSync(binary)) return 'unknown';
    fd = fs.openSync(binary, 'r');
    const sentinelPos = findSentinel(fd);
    if (sentinelPos === -1) return 'unknown';

    // After the sentinel: [version][count][fuse0][fuse1]… — read up to our fuse.
    const wire = Buffer.alloc(2 + INSPECT_ARGS_INDEX + 1);
    const read = fs.readSync(fd, wire, 0, wire.length, sentinelPos + SENTINEL.length);
    if (read < wire.length) return 'unknown';
    const count = wire[1];
    if (INSPECT_ARGS_INDEX >= count) return 'unknown';
    switch (wire[2 + INSPECT_ARGS_INDEX]) {
      case FUSE_ENABLE:
        return 'enabled';
      case FUSE_DISABLE:
        return 'disabled';
      case FUSE_REMOVED:
        return 'removed';
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Scan a file for the sentinel, returning its byte offset or -1. Chunked with an
 * overlap so a sentinel split across chunk boundaries is still found (the framework
 * binary can be hundreds of MB — never buffer the whole thing).
 */
function findSentinel(fd: number): number {
  const needle = Buffer.from(SENTINEL, 'binary');
  const overlap = needle.length - 1;
  const CHUNK = 1 << 20; // 1 MiB
  const buf = Buffer.alloc(CHUNK + overlap);
  let filePos = 0;
  let carry = 0; // bytes retained from the previous chunk's tail
  for (;;) {
    const read = fs.readSync(fd, buf, carry, CHUNK, filePos);
    if (read <= 0) return -1;
    const searchable = carry + read;
    const idx = buf.subarray(0, searchable).indexOf(needle);
    if (idx !== -1) return filePos - carry + idx;
    // Retain the last `overlap` bytes so a boundary-straddling match is caught next round.
    buf.copy(buf, 0, searchable - overlap, searchable);
    carry = overlap;
    filePos += read;
  }
}
