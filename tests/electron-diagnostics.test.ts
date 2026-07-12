/**
 * Unit tests for Electron launch diagnostics — pure header parsing, the
 * pre-session driver checks, the macOS signing probe, and the launch-failure
 * diagnoser. No real Electron app or session (the enrichment is proven
 * end-to-end against the unsigned fixture in the docs' before/after evidence).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { CraftdriverError, ErrorCode } from '../src/lib/errors';
import {
  assertDriverArchCompatible,
  assertDriverChromiumMajorCompatible,
  diagnoseElectronLaunchFailure,
  isElectronInstanceExitedError,
  probeMacAppSigning,
  readBinaryArch,
} from '../src/lib/electronDiagnostics';

const tempDirs: string[] = [];
const makeTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 20-byte Mach-O 64-bit header (little-endian) for the given arch. */
function machO(arch: 'x64' | 'arm64'): Buffer {
  const buf = Buffer.alloc(20);
  buf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64 on disk
  buf.writeInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4); // cputype
  return buf;
}
/** 20-byte little-endian ELF header for the given arch. */
function elf(arch: 'x64' | 'arm64'): Buffer {
  const buf = Buffer.alloc(20);
  buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; // 0x7F E L F
  buf[5] = 1; // EI_DATA little-endian
  buf.writeUInt16LE(arch === 'x64' ? 0x3e : 0xb7, 18); // e_machine
  return buf;
}
function writeBinary(bytes: Buffer): string {
  const file = path.join(makeTempDir('diag-bin-'), 'binary');
  fs.writeFileSync(file, bytes);
  return file;
}

describe('readBinaryArch', () => {
  it('reads arch from Mach-O and ELF headers', () => {
    expect(readBinaryArch(writeBinary(machO('x64')))).toBe('x64');
    expect(readBinaryArch(writeBinary(machO('arm64')))).toBe('arm64');
    expect(readBinaryArch(writeBinary(elf('x64')))).toBe('x64');
    expect(readBinaryArch(writeBinary(elf('arm64')))).toBe('arm64');
  });

  it('returns undefined for a fat binary, a text file, and a missing file', () => {
    const fat = Buffer.alloc(20); fat.writeUInt32BE(0xcafebabe, 0);
    expect(readBinaryArch(writeBinary(fat))).toBeUndefined();
    expect(readBinaryArch(writeBinary(Buffer.from('#!/bin/sh\necho hi\n')))).toBeUndefined();
    expect(readBinaryArch('/no/such/binary')).toBeUndefined();
  });
});

describe('assertDriverArchCompatible', () => {
  const otherArch = os.arch() === 'x64' ? 'arm64' : 'x64';

  it('passes for a driver matching the runtime arch', () => {
    const arch = os.arch() as 'x64' | 'arm64';
    expect(() => assertDriverArchCompatible(writeBinary(machO(arch)))).not.toThrow();
  });

  it('throws ELECTRON_DRIVER_MISMATCH for the wrong arch', () => {
    try {
      assertDriverArchCompatible(writeBinary(elf(otherArch)));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(CraftdriverError.is(err, ErrorCode.ELECTRON_DRIVER_MISMATCH)).toBe(true);
      expect((err as CraftdriverError).detail).toMatchObject({ kind: 'arch', driverArch: otherArch });
    }
  });

  it('skips silently when the arch cannot be read', () => {
    expect(() => assertDriverArchCompatible(writeBinary(Buffer.from('not a binary')))).not.toThrow();
  });
});

describe.skipIf(process.platform === 'win32')('assertDriverChromiumMajorCompatible', () => {
  const fakeDriver = (versionLine: string): string => {
    const file = path.join(makeTempDir('diag-drv-'), 'chromedriver');
    fs.writeFileSync(file, `#!/bin/sh\necho "${versionLine}"\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };

  it('throws when the driver major mismatches the app Chromium major', () => {
    const driver = fakeDriver('ChromeDriver 138.0.7204.183'); // major 138
    try {
      assertDriverChromiumMajorCompatible(driver, '43.1.0'); // Electron 43 → Chromium 150
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(CraftdriverError.is(err, ErrorCode.ELECTRON_DRIVER_MISMATCH)).toBe(true);
      expect((err as CraftdriverError).detail).toMatchObject({
        kind: 'chromium-major', driverMajor: 138, expectedChromiumMajor: 150,
      });
    }
  });

  it('passes when the driver major matches', () => {
    const driver = fakeDriver('ChromeDriver 138.0.7204.183');
    expect(() => assertDriverChromiumMajorCompatible(driver, '37.2.0')).not.toThrow(); // 37 → 138
  });

  it('skips for an unmapped Electron version', () => {
    const driver = fakeDriver('ChromeDriver 138.0.7204.183');
    expect(() => assertDriverChromiumMajorCompatible(driver, '999.0.0')).not.toThrow();
  });
});

describe('isElectronInstanceExitedError', () => {
  it('recognizes the app-exited failure class', () => {
    expect(isElectronInstanceExitedError(new Error('session not created: Chrome instance exited'))).toBe(true);
    expect(isElectronInstanceExitedError(new Error('DevToolsActivePort file doesn\'t exist'))).toBe(true);
  });
  it('is false for unrelated errors', () => {
    expect(isElectronInstanceExitedError(new Error('element not found'))).toBe(false);
  });
});

describe('diagnoseElectronLaunchFailure', () => {
  const exited = () => new Error('session not created: Chrome instance exited');

  it('returns an unrelated error unchanged', () => {
    const err = new Error('element not found');
    expect(diagnoseElectronLaunchFailure(err, { appBinaryPath: '/app', platform: 'linux' })).toBe(err);
  });

  it('adds the Linux sandbox hint when --no-sandbox is absent, and the driver tail', () => {
    const out = diagnoseElectronLaunchFailure(exited(), {
      appBinaryPath: '/app', args: [], platform: 'linux', driverOutputTail: 'chromedriver said boom',
    });
    expect(CraftdriverError.is(out, ErrorCode.ELECTRON_LAUNCH_FAILED)).toBe(true);
    const e = out as CraftdriverError;
    expect(e.hint).toMatch(/--no-sandbox/);
    expect(e.detail).toMatchObject({ sandboxDisabled: false });
    expect(e.message).toContain('chromedriver said boom');
    expect(e.cause).toBeInstanceOf(Error);
  });

  it('omits the sandbox hint when --no-sandbox is already set', () => {
    const out = diagnoseElectronLaunchFailure(exited(), {
      appBinaryPath: '/app', args: ['--no-sandbox'], platform: 'linux',
    }) as CraftdriverError;
    expect(out.detail).toMatchObject({ sandboxDisabled: true });
    expect(out.hint).toBeUndefined(); // no actionable hint on this path
  });
});

describe.skipIf(process.platform !== 'darwin')('probeMacAppSigning + darwin diagnosis', () => {
  const copyLs = (): string => {
    const file = path.join(makeTempDir('diag-sign-'), 'bin');
    fs.copyFileSync('/bin/ls', file);
    fs.chmodSync(file, 0o755);
    return file;
  };

  it('reports a system binary as signed', () => {
    expect(probeMacAppSigning('/bin/ls')).toBe('signed');
  });

  it('reports an ad-hoc-signed copy as adhoc', () => {
    const bin = copyLs();
    spawnSync('codesign', ['-f', '-s', '-', bin]);
    expect(probeMacAppSigning(bin)).toBe('adhoc');
  });

  it('reports a signature-stripped copy as unsigned', () => {
    const bin = copyLs();
    const r = spawnSync('codesign', ['--remove-signature', bin]);
    // Some hosts refuse to strip; only assert when the strip succeeded.
    if (r.status === 0) expect(probeMacAppSigning(bin)).toBe('unsigned');
  });

  it('adds a signing hint for an ad-hoc app on macOS', () => {
    const bin = copyLs();
    spawnSync('codesign', ['-f', '-s', '-', bin]);
    const out = diagnoseElectronLaunchFailure(
      new Error('session not created: Chrome instance exited'),
      { appBinaryPath: bin, platform: 'darwin' },
    ) as CraftdriverError;
    expect(out.detail).toMatchObject({ macSigning: 'adhoc' });
    expect(out.hint).toMatch(/sign|notariz/i);
  });
});
