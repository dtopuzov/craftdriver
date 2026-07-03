/**
 * Automatic driver resolution for Chrome and Firefox.
 *
 * Resolution chain (first match wins):
 *   1. options.binaryPath (explicit)
 *   2. CRAFTDRIVER_DRIVER_PATH
 *   3. Legacy env vars (CHROMEDRIVER_PATH, SE_CHROMEDRIVER, etc.)
 *   4. node_modules/.bin/chromedriver|geckodriver
 *   5. PATH probe
 *   [CRAFTDRIVER_OFFLINE → throw here if no match yet]
 *   6. System browser detect + driver-only download from CfT / GitHub
 *
 * Only the driver binary is downloaded by default, never the browser itself.
 * This avoids CfT's OS-dependency problems on lean Linux containers.
 * See research/driver-manager.md for the full strategy.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// ─── Configuration ────────────────────────────────────────────────────────────

function cacheDir(): string {
  return process.env.CRAFTDRIVER_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'craftdriver');
}

function ttlMs(): number {
  return parseInt(process.env.CRAFTDRIVER_DRIVER_TTL ?? '86400', 10) * 1000;
}

// ─── Metadata (geckodriver TTL record) ───────────────────────────────────────

interface MetadataEntry {
  version: string;
  driverPath: string;
  timestamp: number;
}

interface Metadata {
  [key: string]: MetadataEntry;
}

function readMetadata(): Metadata {
  try {
    const raw = fs.readFileSync(path.join(cacheDir(), 'metadata.json'), 'utf-8');
    return JSON.parse(raw) as Metadata;
  } catch {
    return {};
  }
}

function writeMetadata(meta: Metadata): void {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 2));
}

// ─── Platform helpers ─────────────────────────────────────────────────────────

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

/** Maps to Chrome-for-Testing platform directory names. */
function cftPlatform(): string {
  const p = os.platform();
  const a = os.arch();
  if (p === 'darwin') return a === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (p === 'win32') return a === 'x64' ? 'win64' : 'win32';
  if (a === 'arm64') {
    // CfT does not publish ARM64 Linux builds. Fail early with a clear message
    // rather than downloading an x64 binary that silently fails on exec.
    throw new Error(
      'Chrome for Testing does not provide chromedriver for Linux ARM64.\n' +
      'Install chromedriver via your system package manager and set CRAFTDRIVER_DRIVER_PATH.',
    );
  }
  return 'linux64';
}

/**
 * Maps to the geckodriver release asset name fragment.
 * Asset names follow the pattern: geckodriver-vX.Y.Z-<platform>.<ext>
 * e.g. geckodriver-v0.35.0-macos.tar.gz
 *      geckodriver-v0.35.0-macos-aarch64.tar.gz
 *      geckodriver-v0.35.0-linux64.tar.gz
 */
function geckodriverPlatform(): string {
  const p = os.platform();
  const a = os.arch();
  if (p === 'darwin') return a === 'arm64' ? 'macos-aarch64' : 'macos';
  if (p === 'win32') return a === 'x64' ? 'win64' : 'win32';
  return a === 'arm64' ? 'linux-aarch64' : 'linux64';
}

function driverBinName(): string {
  return os.platform() === 'win32' ? 'chromedriver.exe' : 'chromedriver';
}

function geckoBinName(): string {
  return os.platform() === 'win32' ? 'geckodriver.exe' : 'geckodriver';
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsGet(url: string, depth = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('Too many HTTP redirects')); return; }
    https.get(url, { headers: { 'User-Agent': 'craftdriver' } }, (res) => {
      const location = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
        resolve(httpsGet(location, depth + 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function httpsDownload(url: string, dest: string, depth = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (depth > 5) { reject(new Error('Too many HTTP redirects')); return; }
    https.get(url, { headers: { 'User-Agent': 'craftdriver' } }, (res) => {
      const location = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
        resolve(httpsDownload(location, dest, depth + 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading from ${url}`));
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close((err) => err ? reject(err) : resolve()));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Archive extraction ───────────────────────────────────────────────────────

function extractZip(zipPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  if (os.platform() === 'win32') {
    // Pass path and destination as separate arguments to avoid string injection
    // if the cache path contains special characters.
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      'Expand-Archive',
      '-Force',
      '-Path', zipPath,
      '-DestinationPath', destDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) {
      throw new Error(`Zip extraction failed: ${String(r.stderr)}`);
    }
  } else {
    const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      throw new Error(`unzip failed: ${String(r.stderr)}`);
    }
  }
}

function extractTarGz(tarPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  const r = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    throw new Error(`tar extraction failed: ${String(r.stderr)}`);
  }
}

// ─── System browser detection ─────────────────────────────────────────────────

const CHROME_CANDIDATES: Partial<Record<SupportedPlatform, string[]>> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

const FIREFOX_CANDIDATES: Partial<Record<SupportedPlatform, string[]>> = {
  darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
  linux: ['firefox', 'firefox-esr'],
  win32: [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  ],
};

function detectBrowserVersion(
  candidates: string[],
): { browserPath: string; version: string } | undefined {
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0 && result.stdout) {
        const match = result.stdout.match(/\d+\.\d[\d.]*/);
        if (match) return { browserPath: candidate, version: match[0] };
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

// ─── PATH probe ───────────────────────────────────────────────────────────────

function commandOnPath(cmd: string): boolean {
  try {
    const r = spawnSync(os.platform() === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ─── Chrome driver download ───────────────────────────────────────────────────

const CFT_JSON_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';

interface CfTVersion {
  version: string;
  downloads: {
    chromedriver?: Array<{ platform: string; url: string }>;
  };
}

async function downloadChromedriver(browserVersion: string): Promise<string> {
  const platform = cftPlatform();
  const binName = driverBinName();
  const driverDir = path.join(cacheDir(), 'chromedriver', browserVersion, platform);
  const driverBin = path.join(driverDir, binName);

  // Cache hit: exact browser version already downloaded — always valid, no TTL.
  if (fs.existsSync(driverBin)) return driverBin;

  const major = browserVersion.split('.')[0];
  process.stderr.write(
    `[craftdriver] Fetching chromedriver for Chrome ${browserVersion}…\n`,
  );

  const json: { versions: CfTVersion[] } = JSON.parse(await httpsGet(CFT_JSON_URL));

  // Find the best matching version: prefer exact match, then latest in same major.
  const candidates = json.versions
    .filter((v) => v.version.startsWith(`${major}.`) && v.downloads.chromedriver)
    .filter((v) => v.downloads.chromedriver!.some((d) => d.platform === platform))
    .sort((a, b) => {
      if (a.version === browserVersion) return -1;
      if (b.version === browserVersion) return 1;
      return b.version.localeCompare(a.version, undefined, { numeric: true });
    });

  if (candidates.length === 0) {
    throw new Error(
      `No chromedriver found in Chrome for Testing for Chrome ${browserVersion} on ${platform}.\n` +
      `Set CRAFTDRIVER_DRIVER_PATH to a local chromedriver binary to skip auto-resolution.`,
    );
  }

  const chosen = candidates[0];
  const entry = chosen.downloads.chromedriver!.find((d) => d.platform === platform)!;
  const tmpZip = path.join(cacheDir(), `_chromedriver-${chosen.version}.zip`);

  process.stderr.write(
    `[craftdriver] Downloading chromedriver ${chosen.version}…\n`,
  );
  fs.mkdirSync(cacheDir(), { recursive: true });
  await httpsDownload(entry.url, tmpZip);

  // CfT zip layout: chromedriver-<platform>/chromedriver[.exe]
  const extractDir = path.join(cacheDir(), `_extract_chromedriver_${chosen.version}`);
  extractZip(tmpZip, extractDir);
  fs.unlinkSync(tmpZip);

  const innerBin = path.join(extractDir, `chromedriver-${platform}`, binName);
  if (!fs.existsSync(innerBin)) {
    throw new Error(
      `Unexpected zip layout: could not find ${innerBin} after extraction.`,
    );
  }

  fs.mkdirSync(driverDir, { recursive: true });
  fs.renameSync(innerBin, driverBin);
  fs.rmSync(extractDir, { recursive: true, force: true });

  if (os.platform() !== 'win32') fs.chmodSync(driverBin, 0o755);

  return driverBin;
}

// ─── Firefox driver download ──────────────────────────────────────────────────

const GECKODRIVER_RELEASES_URL =
  'https://api.github.com/repos/mozilla/geckodriver/releases/latest';

async function downloadGeckodriver(): Promise<string> {
  const platform = geckodriverPlatform();
  const binName = geckoBinName();
  const cacheKey = `geckodriver/${platform}`;
  const ext = os.platform() === 'win32' ? '.zip' : '.tar.gz';

  // Check TTL: if we've resolved within the TTL window and the binary still
  // exists, skip the GitHub API call.
  const meta = readMetadata();
  const cached = meta[cacheKey];
  if (
    cached &&
    Date.now() - cached.timestamp < ttlMs() &&
    fs.existsSync(cached.driverPath)
  ) {
    return cached.driverPath;
  }

  process.stderr.write('[craftdriver] Fetching latest geckodriver version…\n');

  interface GeckoRelease {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  }
  const release: GeckoRelease = JSON.parse(await httpsGet(GECKODRIVER_RELEASES_URL));
  const version = release.tag_name; // e.g. "v0.35.0"

  const driverDir = path.join(cacheDir(), 'geckodriver', version, platform);
  const driverBin = path.join(driverDir, binName);

  if (!fs.existsSync(driverBin)) {
    // Match asset exactly: name must contain `-<platform>.` to avoid
    // 'macos' accidentally matching 'macos-aarch64' on macOS x64.
    const asset = release.assets.find(
      (a) => a.name.includes(`-${platform}.`) && a.name.endsWith(ext),
    );
    if (!asset) {
      throw new Error(
        `No geckodriver asset found for platform "${platform}".\n` +
        `Set CRAFTDRIVER_DRIVER_PATH to a local geckodriver binary to skip auto-resolution.`,
      );
    }

    const tmpFile = path.join(cacheDir(), `_geckodriver-${version}${ext}`);
    process.stderr.write(`[craftdriver] Downloading geckodriver ${version}…\n`);
    fs.mkdirSync(cacheDir(), { recursive: true });
    await httpsDownload(asset.browser_download_url, tmpFile);

    fs.mkdirSync(driverDir, { recursive: true });
    if (ext === '.zip') {
      extractZip(tmpFile, driverDir);
    } else {
      extractTarGz(tmpFile, driverDir);
    }
    fs.unlinkSync(tmpFile);

    if (os.platform() !== 'win32') fs.chmodSync(driverBin, 0o755);
  }

  // Refresh TTL record regardless of whether we downloaded a new version.
  meta[cacheKey] = { version, driverPath: driverBin, timestamp: Date.now() };
  writeMetadata(meta);

  return driverBin;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Resolves the path to a chromedriver binary, downloading if necessary. */
export async function resolveChromeDriver(options?: {
  binaryPath?: string;
}): Promise<string> {
  // 1. Explicit constructor argument.
  if (options?.binaryPath && fs.existsSync(options.binaryPath)) {
    return options.binaryPath;
  }

  // 2. craftdriver-specific env vars (browser-specific first, then generic fallback).
  for (const envVar of ['CRAFTDRIVER_CHROMEDRIVER_PATH', 'CRAFTDRIVER_DRIVER_PATH']) {
    const cdPath = process.env[envVar];
    if (cdPath && fs.existsSync(cdPath)) return cdPath;
  }

  // 3. Legacy / Selenium-compatible env vars.
  for (const envVar of ['CHROMEDRIVER_PATH', 'SE_CHROMEDRIVER']) {
    const p = process.env[envVar];
    if (p && fs.existsSync(p)) return p;
  }

  // 4. Auto-resolution cache. Once we've auto-resolved a chromedriver (step 7
  //    below), reuse it for a TTL window instead of re-probing PATH (a blocking
  //    `which` spawn, ~80ms) and re-launching Chrome to read its version
  //    (`detectBrowserVersion`, a blocking spawnSync, ~340ms) on every single
  //    Browser.launch(). Both stall the event loop, which is especially costly
  //    when several browsers launch in parallel. Explicit config (the arg + env
  //    vars checked above) always wins over this cache; only the auto-download
  //    path writes it. TTL defaults to 24h, tunable via CRAFTDRIVER_DRIVER_TTL
  //    (0 disables). Mirrors the metadata record geckodriver already keeps.
  const cacheKey = `chromedriver/${cftPlatform()}`;
  const meta = readMetadata();
  const cached = meta[cacheKey];
  if (
    cached &&
    Date.now() - cached.timestamp < ttlMs() &&
    fs.existsSync(cached.driverPath)
  ) {
    return cached.driverPath;
  }

  // 5. Locally installed chromedriver npm package.
  const localBin = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
    'node_modules/.bin/chromedriver',
  );
  if (fs.existsSync(localBin)) return localBin;

  // 6. PATH probe (skipped when CRAFTDRIVER_SKIP_PATH_PROBE is set, e.g. in
  //    integration tests that need to exercise the auto-download path even on
  //    systems where chromedriver is already installed).
  if (!process.env.CRAFTDRIVER_SKIP_PATH_PROBE && commandOnPath('chromedriver')) return 'chromedriver';

  // 7. Offline guard.
  if (process.env.CRAFTDRIVER_OFFLINE) {
    throw new Error(
      'CRAFTDRIVER_OFFLINE is set and no chromedriver was found.\n' +
      'Set CRAFTDRIVER_DRIVER_PATH to a local chromedriver binary.',
    );
  }

  // 8. Detect system Chrome + download matching driver from CfT, then record
  //    the result in the auto-resolution cache read at step 4.
  const p = os.platform() as SupportedPlatform;
  const candidates = CHROME_CANDIDATES[p] ?? ['google-chrome'];
  const detected = detectBrowserVersion(candidates);
  if (!detected) {
    throw new Error(
      'Could not detect a system Chrome or Chromium installation.\n' +
      'Install Chrome, or set CRAFTDRIVER_DRIVER_PATH to a local chromedriver binary.',
    );
  }
  const driverPath = await downloadChromedriver(detected.version);

  // Refresh TTL record regardless of whether we downloaded a new binary.
  meta[cacheKey] = { version: detected.version, driverPath, timestamp: Date.now() };
  writeMetadata(meta);
  return driverPath;
}

/** Resolves the path to a geckodriver binary, downloading if necessary. */
export async function resolveFirefoxDriver(options?: {
  binaryPath?: string;
}): Promise<string> {
  // 1. Explicit constructor argument.
  if (options?.binaryPath && fs.existsSync(options.binaryPath)) {
    return options.binaryPath;
  }

  // 2. craftdriver-specific env vars (browser-specific first, then generic fallback).
  for (const envVar of ['CRAFTDRIVER_GECKODRIVER_PATH', 'CRAFTDRIVER_DRIVER_PATH']) {
    const cdPath = process.env[envVar];
    if (cdPath && fs.existsSync(cdPath)) return cdPath;
  }

  // 3. Legacy / Selenium-compatible env vars.
  for (const envVar of ['GECKODRIVER_PATH', 'GECKODRIVER_FILEPATH', 'SE_GECKODRIVER']) {
    const p = process.env[envVar];
    if (p && fs.existsSync(p)) return p;
  }

  // 4. Auto-resolution cache. Once geckodriver has been auto-resolved (step 8
  //    below writes this record), reuse it for a TTL window instead of probing
  //    PATH (a blocking `which` spawn) and re-detecting Firefox on every
  //    Browser.launch() — both stall the event loop and hurt parallel launches.
  //    Explicit config (arg + env vars above) always wins. Same record and TTL
  //    that downloadGeckodriver() maintains; tunable via CRAFTDRIVER_DRIVER_TTL.
  const cacheKey = `geckodriver/${geckodriverPlatform()}`;
  const meta = readMetadata();
  const cached = meta[cacheKey];
  if (
    cached &&
    Date.now() - cached.timestamp < ttlMs() &&
    fs.existsSync(cached.driverPath)
  ) {
    return cached.driverPath;
  }

  // 5. Locally installed geckodriver npm package.
  const localBin = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
    'node_modules/.bin/geckodriver',
  );
  if (fs.existsSync(localBin)) return localBin;

  // 6. PATH probe.
  if (commandOnPath('geckodriver')) return 'geckodriver';

  // 7. Offline guard.
  if (process.env.CRAFTDRIVER_OFFLINE) {
    throw new Error(
      'CRAFTDRIVER_OFFLINE is set and no geckodriver was found.\n' +
      'Set CRAFTDRIVER_DRIVER_PATH to a local geckodriver binary.',
    );
  }

  // 8. Detect system Firefox (informational only) + download latest
  //    geckodriver from GitHub releases, which records the auto-resolution
  //    cache read at step 4. Only reached on a cold cache, so the detection
  //    spawn no longer runs on the common warm path.
  const p = os.platform() as SupportedPlatform;
  const candidates = FIREFOX_CANDIDATES[p] ?? ['firefox'];
  const detected = detectBrowserVersion(candidates);
  if (!detected) {
    process.stderr.write(
      '[craftdriver] No system Firefox detected; downloading geckodriver for latest Firefox.\n',
    );
  }
  return downloadGeckodriver();
}
