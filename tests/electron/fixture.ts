/**
 * Shared fixture for the Electron e2e suites: get the packaged **craftdriver-examples**
 * app, and launch it the same way everywhere.
 *
 * The app is downloaded **once** from the pinned release into a git-ignored folder at
 * the repo root (`.electron-fixture/<release>/`) and reused on every later run — only
 * (re)downloaded when missing, so CI (ephemeral) fetches it fresh and locally you keep
 * it until you delete the folder. `tests/electron/global-setup.ts` triggers the
 * download once before the suites run; the suites themselves just resolve the path.
 *
 * `CRAFTDRIVER_ELECTRON_APP` overrides everything (point at any app executable).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Browser } from '../../src';

/** Pinned example-app release. Bump this and the checksums together on a new release. */
const RELEASE = 'v0.1.5';

/** Per-platform release asset, executable path within it, and SHA-256 (from the GitHub asset digest). */
const ASSETS: Record<string, { asset: string; exe: string; sha256: string }> = {
  'darwin-x64': {
    asset: 'example-electron-mac-x64.zip',
    exe: 'CraftdriverExample.app/Contents/MacOS/CraftdriverExample',
    sha256: '8c5690e6073f000fe9ca5874494540466efda8848fecdaa264ed0d98dd60214e',
  },
  'darwin-arm64': {
    asset: 'example-electron-mac-arm64.zip',
    exe: 'CraftdriverExample.app/Contents/MacOS/CraftdriverExample',
    sha256: '4ab036f3ff16399c83adec6cb65e0b3895620e904b84e627e985630c27a5781d',
  },
  'linux-x64': {
    asset: 'example-electron-linux-x64.zip',
    exe: 'craftdriver-example-electron',
    sha256: '787a223d00b26579fae5bbf9238ede49bc1a61ba94a54a828f0cff0b904d5413',
  },
  'win32-x64': {
    asset: 'example-electron-win-x64.zip',
    exe: 'CraftdriverExample.exe',
    sha256: '959ad6502663ba3dd664ee3e2685bf621a4cf467ee48bf7bf68ca155af61232d',
  },
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, '.electron-fixture', RELEASE);
const entry = () => ASSETS[`${process.platform}-${process.arch}`];

/** Path to the downloaded app executable — or undefined on an unsupported platform / not yet downloaded. */
export function resolveElectronAppPath(): string | undefined {
  const override = process.env.CRAFTDRIVER_ELECTRON_APP;
  if (override) return override;
  const e = entry();
  if (!e) return undefined;
  const exe = path.join(FIXTURE_ROOT, e.exe);
  return fs.existsSync(exe) ? exe : undefined;
}

/** Download + extract the app once (idempotent). Returns its executable path, or undefined if unsupported. */
export async function ensureElectronApp(): Promise<string | undefined> {
  if (process.env.CRAFTDRIVER_ELECTRON_APP) return process.env.CRAFTDRIVER_ELECTRON_APP;
  const e = entry();
  if (!e) return undefined; // unsupported OS/arch → suites skip
  const exe = path.join(FIXTURE_ROOT, e.exe);
  if (fs.existsSync(exe)) return exe; // already there → reuse

  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  const zip = path.join(os.tmpdir(), `craftdriver-${RELEASE}-${e.asset}`);
  const url = `https://github.com/dtopuzov/craftdriver-examples/releases/download/${RELEASE}/${e.asset}`;
  process.stderr.write(`[electron-fixture] downloading ${e.asset} (${RELEASE})…\n`);
  await download(url, zip);

  const actual = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (actual !== e.sha256) {
    fs.rmSync(zip, { force: true });
    throw new Error(`[electron-fixture] checksum mismatch for ${e.asset}: expected ${e.sha256}, got ${actual}`);
  }

  extract(zip, FIXTURE_ROOT);
  fs.rmSync(zip, { force: true });
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755); // unzip may drop the +x bit
  if (process.platform === 'darwin') {
    // Release .apps are unsigned; ad-hoc sign so Gatekeeper/AMFI let them launch.
    try {
      execFileSync('codesign', ['-f', '-s', '-', '--deep', path.join(FIXTURE_ROOT, 'CraftdriverExample.app')]);
    } catch { /* Intel doesn't AMFI-kill unsigned apps; non-fatal */ }
  }
  if (!fs.existsSync(exe)) throw new Error(`[electron-fixture] extracted ${e.asset} but ${e.exe} is missing`);
  process.stderr.write(`[electron-fixture] ready at ${exe}\n`);
  return exe;
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const get = (u: string, redirects = 0) => {
      if (redirects > 5) return reject(new Error(`too many redirects for ${url}`));
      https.get(u, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
        file.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

function extract(zip: string, dir: string): void {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Force -Path '${zip}' -DestinationPath '${dir}'`]);
  } else {
    execFileSync('unzip', ['-q', '-o', zip, '-d', dir]); // -o overwrites a partial extract
  }
}

/** Extra Chromium flags for the app (CI passes `--no-sandbox` on Linux via this env). */
const EXTRA_ARGS = (process.env.CRAFTDRIVER_ELECTRON_ARGS ?? '').split(' ').map((s) => s.trim()).filter(Boolean);

export interface LaunchOpts {
  /** Ask the fixture app to show a splash window first (SHOW_SPLASH). */
  splash?: boolean;
  /** Negotiate WebDriver BiDi (Electron defaults to Classic). */
  bidi?: boolean;
  /** Open the main-process inspector for `browser.electron`. */
  mainProcess?: boolean;
}

/**
 * Launch the example app the way the suites do. On macOS the driver is auto-detected
 * from the app bundle; elsewhere `CRAFTDRIVER_ELECTRON_VERSION` supplies it (CI sets it).
 */
export function launchExampleApp(appPath: string, opts: LaunchOpts = {}): Promise<Browser> {
  // The app reads SHOW_SPLASH from its inherited env; set it deterministically per launch.
  if (opts.splash) process.env.SHOW_SPLASH = '1';
  else delete process.env.SHOW_SPLASH;

  const version = process.env.CRAFTDRIVER_ELECTRON_VERSION?.trim() || undefined;
  return Browser.launch({
    electron: {
      appBinaryPath: appPath,
      ...(version ? { version } : {}),
      ...(opts.mainProcess ? { mainProcess: true } : {}),
      ...(EXTRA_ARGS.length ? { args: EXTRA_ARGS } : {}),
    },
    ...(opts.bidi ? { enableBiDi: true } : {}),
  });
}
