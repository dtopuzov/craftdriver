/**
 * Unit tests for the dependency-free Electron fuse reader behind the
 * "the EnableNodeCliInspectArguments fuse is disabled" diagnostic. Builds synthetic
 * binaries carrying the @electron/fuses wire and checks the parse, the chunk-boundary
 * scan, and the macOS Electron-Framework path resolution. When a real packaged app is
 * available (CRAFTDRIVER_ELECTRON_APP) it also confirms a live read returns 'enabled'.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fuseCarrierBinary, readInspectArgumentsFuse } from '../src/lib/electronFuses';

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const INSPECT_INDEX = 3;
const FUSE_COUNT = 8;

/** Build a fuse wire with EnableNodeCliInspectArguments set to `state` ('0'|'1'|'r'). */
function fuseWire(state: '0' | '1' | 'r'): Buffer {
  const fuses = Buffer.alloc(FUSE_COUNT, '1'); // default everything enabled
  fuses[INSPECT_INDEX] = state.charCodeAt(0);
  return Buffer.concat([
    Buffer.from(SENTINEL, 'binary'),
    Buffer.from([1]), // wire version
    Buffer.from([FUSE_COUNT]), // fuse count
    fuses,
  ]);
}

const tmpFiles: string[] = [];
function writeBinary(prefix: Buffer, wire: Buffer, suffix = Buffer.alloc(0)): string {
  const p = path.join(os.tmpdir(), `craftdriver-fuse-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, Buffer.concat([prefix, wire, suffix]));
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpFiles.splice(0)) fs.rmSync(p, { force: true });
});

describe('readInspectArgumentsFuse', () => {
  it('reads enabled / disabled / removed from the wire', () => {
    expect(readInspectArgumentsFuse(writeBinary(Buffer.from('ELF junk'), fuseWire('1')))).toBe(
      'enabled'
    );
    expect(readInspectArgumentsFuse(writeBinary(Buffer.from('ELF junk'), fuseWire('0')))).toBe(
      'disabled'
    );
    expect(readInspectArgumentsFuse(writeBinary(Buffer.from('ELF junk'), fuseWire('r')))).toBe(
      'removed'
    );
  });

  it('finds a sentinel that straddles the 1 MiB chunk boundary', () => {
    // Push the sentinel so it starts a few bytes before an exact 1 MiB offset, forcing
    // the scanner's overlap-retention path.
    const pad = (1 << 20) - 5;
    expect(readInspectArgumentsFuse(writeBinary(Buffer.alloc(pad, 0x41), fuseWire('0')))).toBe(
      'disabled'
    );
  });

  it("returns 'unknown' for a binary with no fuse wire", () => {
    expect(readInspectArgumentsFuse(writeBinary(Buffer.alloc(2048, 0x00), Buffer.alloc(0)))).toBe(
      'unknown'
    );
  });

  it("returns 'unknown' when the fuse count is shorter than the inspect index", () => {
    const shortWire = Buffer.concat([
      Buffer.from(SENTINEL, 'binary'),
      Buffer.from([1]),
      Buffer.from([2]), // only 2 fuses — index 3 is out of range
      Buffer.from('11', 'binary'),
    ]);
    expect(readInspectArgumentsFuse(writeBinary(Buffer.alloc(8), shortWire))).toBe('unknown');
  });

  it("returns 'unknown' for a missing path or file", () => {
    expect(readInspectArgumentsFuse(undefined)).toBe('unknown');
    expect(readInspectArgumentsFuse('/no/such/binary')).toBe('unknown');
  });
});

describe('fuseCarrierBinary', () => {
  it('resolves the Electron Framework for a macOS .app', () => {
    expect(fuseCarrierBinary('/A/My.app')).toBe(
      '/A/My.app/Contents/Frameworks/Electron Framework.framework/Electron Framework'
    );
  });

  it('resolves the framework from an executable inside the .app', () => {
    expect(fuseCarrierBinary('/A/My.app/Contents/MacOS/My')).toBe(
      '/A/My.app/Contents/Frameworks/Electron Framework.framework/Electron Framework'
    );
  });

  it('uses the binary itself off macOS', () => {
    expect(fuseCarrierBinary('/opt/app/my-linux-app')).toBe('/opt/app/my-linux-app');
    expect(fuseCarrierBinary('C:/app/My.exe')).toBe('C:/app/My.exe');
  });
});

describe('readInspectArgumentsFuse (live)', () => {
  const app = process.env.CRAFTDRIVER_ELECTRON_APP;
  it.runIf(!!app)('reads a real packaged app as enabled (the default fuse)', () => {
    expect(readInspectArgumentsFuse(app!)).toBe('enabled');
  });
});
