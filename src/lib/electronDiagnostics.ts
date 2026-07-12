/**
 * Electron launch diagnostics: turn opaque "Chrome instance exited" / mismatched
 * driver failures into actionable {@link CraftdriverError}s, either before the
 * driver spawns (arch / Chromium-major mismatch) or when session creation dies
 * (macOS signing/Gatekeeper, Linux sandbox). See docs/electron.md "Troubleshooting".
 */
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import { CraftdriverError, ErrorCode } from './errors.js';
import { chromiumMajorForElectron } from './electronVersions.js';
import { readChromeDriverVersion } from './driverManager.js';
import { PATH_PROBE_TIMEOUT_MS } from './timing.js';

export type BinaryArch = 'x64' | 'arm64';

/**
 * Best-effort CPU arch of an executable, read from its Mach-O / ELF header
 * (no child process). Returns `undefined` for a universal/fat binary (no single
 * arch), a Windows PE (not parsed here), or anything unrecognized — callers then
 * skip the arch check rather than guess.
 */
export function readBinaryArch(filePath: string): BinaryArch | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(20);
    const read = fs.readSync(fd, buf, 0, 20, 0);
    if (read < 20) return undefined;

    // Mach-O 64-bit, little-endian (MH_MAGIC_64 = 0xFEEDFACF on disk as CF FA ED FE).
    if (buf.readUInt32LE(0) === 0xfeedfacf) {
      const cpuType = buf.readInt32LE(4);
      if (cpuType === 0x01000007) return 'x64'; // CPU_TYPE_X86_64
      if (cpuType === 0x0100000c) return 'arm64'; // CPU_TYPE_ARM64
      return undefined;
    }
    // Fat/universal (0xCAFEBABE, big-endian): multiple arches, no single answer.
    if (buf.readUInt32BE(0) === 0xcafebabe) return undefined;

    // ELF: 0x7F 'E' 'L' 'F'.
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      const littleEndian = buf[5] === 1; // EI_DATA: 1 = LE, 2 = BE
      const machine = littleEndian ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
      if (machine === 0x3e) return 'x64'; // EM_X86_64
      if (machine === 0xb7) return 'arm64'; // EM_AARCH64
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Fail before spawning when the chromedriver's CPU arch can't match the runtime
 * that has to exec it (e.g. an x64 electron-chromedriver on an arm64 host). A
 * pure header read; skips silently when the arch can't be determined.
 */
export function assertDriverArchCompatible(driverPath: string): void {
  const driverArch = readBinaryArch(driverPath);
  const runtimeArch = os.arch();
  if (!driverArch || (runtimeArch !== 'x64' && runtimeArch !== 'arm64')) return;
  if (driverArch === runtimeArch) return;
  throw new CraftdriverError(
    ErrorCode.ELECTRON_DRIVER_MISMATCH,
    `The chromedriver at "${driverPath}" is ${driverArch}, but this process is ${runtimeArch} — ` +
      'it cannot launch and the Electron session would fail to start.',
    {
      detail: { kind: 'arch', driverPath, driverArch, runtimeArch },
      hint:
        `Install/point at a ${runtimeArch} chromedriver (electron-chromedriver for your arch, ` +
        'or let craftdriver download one via electron.version).',
    }
  );
}

/**
 * Fail before session creation when the resolved chromedriver's major doesn't
 * match the Chromium the app's Electron version bundles — the exact mismatch
 * that otherwise surfaces as an opaque "session not created" deep in startup.
 * Only meaningful when the app's Electron version is known (explicit or detected)
 * AND the driver reports a version; skips otherwise.
 */
export function assertDriverChromiumMajorCompatible(
  driverPath: string,
  electronVersion: string
): void {
  const expectedMajor = chromiumMajorForElectron(electronVersion);
  if (expectedMajor === undefined) return; // unknown mapping — nothing to assert against
  const driverVersion = readChromeDriverVersion(driverPath);
  if (!driverVersion) return; // couldn't read — let the real spawn surface any error
  const driverMajor = Number.parseInt(driverVersion.split('.')[0], 10);
  if (!Number.isFinite(driverMajor) || driverMajor === expectedMajor) return;
  throw new CraftdriverError(
    ErrorCode.ELECTRON_DRIVER_MISMATCH,
    `chromedriver ${driverVersion} (major ${driverMajor}) does not match Electron ` +
      `${electronVersion}, which bundles Chromium ${expectedMajor} — the session would fail to start.`,
    {
      detail: {
        kind: 'chromium-major',
        driverPath,
        driverVersion,
        driverMajor,
        electronVersion,
        expectedChromiumMajor: expectedMajor,
      },
      hint:
        `Use a chromedriver matching Chromium ${expectedMajor} (pin ` +
        `electron-chromedriver@${electronVersion.split('.')[0]}, or set electron.version so ` +
        'craftdriver downloads the matching Chrome-for-Testing driver).',
    }
  );
}

export type MacSigningState = 'unsigned' | 'adhoc' | 'signed' | 'unknown';

/**
 * Probe an app binary's code signature via `codesign -dv`. An unsigned or
 * ad-hoc-signed app is what Gatekeeper/AMFI kills on locked-down macOS, which
 * chromedriver reports only as "Chrome instance exited". macOS-only; returns
 * `'unknown'` on any other platform or probe failure.
 */
export function probeMacAppSigning(appBinaryPath: string): MacSigningState {
  if (os.platform() !== 'darwin') return 'unknown';
  const result = spawnSync('codesign', ['-dv', appBinaryPath], {
    encoding: 'utf8',
    timeout: PATH_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return 'unknown';
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/code object is not signed at all/i.test(output)) return 'unsigned';
  // Ad-hoc shows up as `flags=0x2(adhoc)` and `Signature=adhoc`; check before the
  // generic signed signal since ad-hoc binaries also carry a CodeDirectory.
  if (/\badhoc\b/i.test(output)) return 'adhoc';
  if (result.status === 0 && /(CodeDirectory|Signature size=|Authority=)/i.test(output))
    return 'signed';
  return 'unknown';
}

/** Heuristic: did session creation fail because the app process exited/crashed? */
export function isElectronInstanceExitedError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('chrome instance exited') ||
    message.includes('session not created') ||
    message.includes('chrome failed to start') ||
    message.includes('crashed') ||
    message.includes('devtoolsactiveport')
  );
}

export interface ElectronLaunchDiagnosticsInput {
  appBinaryPath: string;
  /** Chromium/app args passed at launch (checked for `--no-sandbox`). */
  args?: string[];
  /** Bounded chromedriver stdout/stderr tail, e.g. `ElectronService#getOutputTail()`. */
  driverOutputTail?: string;
  /** Override the host platform (tests exercise both branches on one host). */
  platform?: NodeJS.Platform;
}

/**
 * Enrich a session-creation failure on the Electron path with the diagnosed
 * likely cause and the chromedriver output tail. Returns the original error
 * unchanged when it isn't the app-exited class (so unrelated failures aren't
 * mislabeled).
 */
export function diagnoseElectronLaunchFailure(
  cause: unknown,
  input: ElectronLaunchDiagnosticsInput
): unknown {
  if (!isElectronInstanceExitedError(cause)) return cause;

  const platform = input.platform ?? os.platform();
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const hints: string[] = [];
  const detail: Record<string, unknown> = {
    platform: `${platform}-${os.arch()}`,
    appBinaryPath: input.appBinaryPath,
  };

  if (platform === 'darwin') {
    const signing = probeMacAppSigning(input.appBinaryPath);
    detail.macSigning = signing;
    if (signing === 'unsigned' || signing === 'adhoc') {
      hints.push(
        `The app at "${input.appBinaryPath}" is ${signing === 'adhoc' ? 'only ad-hoc' : 'not'} ` +
          'code-signed. macOS Gatekeeper/AMFI can kill it before a window opens, which chromedriver ' +
          'reports as "Chrome instance exited". Sign or notarize the app for a real test target, or ' +
          'open it once via Finder to clear quarantine for a throwaway.'
      );
    }
  }

  if (platform === 'linux') {
    const hasNoSandbox = (input.args ?? []).includes('--no-sandbox');
    detail.sandboxDisabled = hasNoSandbox;
    if (!hasNoSandbox) {
      hints.push(
        'On Linux CI the unzipped chrome-sandbox helper loses its root-owned SUID bit, so the ' +
          'sandbox cannot start and the app exits. Pass electron.args: ["--no-sandbox"] for a ' +
          'throwaway fixture.'
      );
    }
  }

  const tail = input.driverOutputTail?.trim();
  const sections = [causeMessage];
  if (hints.length > 0) {
    sections.push('Electron launch diagnostics:\n' + hints.map((h) => `  • ${h}`).join('\n'));
  }
  if (tail) sections.push(`chromedriver output (tail):\n${tail}`);

  return new CraftdriverError(ErrorCode.ELECTRON_LAUNCH_FAILED, sections.join('\n\n'), {
    detail,
    hint: hints[0],
    cause,
  });
}
