/**
 * Automatic driver resolution for Chrome and Firefox.
 *
 * Resolution chain (first match wins):
 *   1. options.binaryPath (explicit)
 *   2. CRAFTDRIVER_DRIVER_PATH
 *   3. Legacy env vars (CHROMEDRIVER_PATH, SE_CHROMEDRIVER, etc.)
 *   3.5. Known CI-provided driver directories (e.g. GitHub Actions'
 *        CHROMEWEBDRIVER / GECKOWEBDRIVER)
 *   4. node_modules/.bin/chromedriver|geckodriver
 *   5. PATH probe
 *   [CRAFTDRIVER_OFFLINE → throw here if no match yet]
 *   6. System browser detect + driver-only download from CfT / GitHub
 *
 * Only the driver binary is downloaded by default, never the browser itself.
 * This avoids CfT's OS-dependency problems on lean Linux containers.
 * See research/driver-manager.md for the full strategy.
 *
 * A separate, independent chain resolves a custom **browser** binary (Chrome/
 * Chromium/Firefox) — see `resolveBrowserBinaryPath()` below. It's opt-in
 * only: nothing resolving there changes any of the above.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { VERSION_PROBE_TIMEOUT_MS, PATH_PROBE_TIMEOUT_MS } from './timing.js';

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

/**
 * Return the cached driver path recorded under `cacheKey` if its TTL record is
 * still fresh and the binary still exists on disk; otherwise `undefined`. Used
 * to skip expensive re-resolution (browser-version detection, PATH probes,
 * network calls) on every launch.
 */
function readFreshCachedDriver(cacheKey: string): string | undefined {
  const cached = readMetadata()[cacheKey];
  if (cached && Date.now() - cached.timestamp < ttlMs() && fs.existsSync(cached.driverPath)) {
    return cached.driverPath;
  }
  return undefined;
}

/** Record an auto-resolved driver path so subsequent resolves can reuse it. */
function recordResolvedDriver(cacheKey: string, version: string, driverPath: string): void {
  const meta = readMetadata();
  meta[cacheKey] = { version, driverPath, timestamp: Date.now() };
  writeMetadata(meta);
}

/**
 * Drop the cached chromedriver resolution if it points at `driverPath`.
 * Returns true when an entry was removed. The downloaded binary is left on disk;
 * only the "reuse this path without re-detecting Chrome" metadata is cleared.
 */
export function invalidateChromeDriverAutoResolutionCache(driverPath?: string): boolean {
  const meta = readMetadata();
  let keys: string[];
  try {
    keys = [`chromedriver/${cftPlatform()}`];
  } catch {
    // On unsupported CfT platforms (notably Linux ARM64), avoid letting cleanup
    // mask the original session-creation error.
    keys = Object.keys(meta).filter((key) => key.startsWith('chromedriver/'));
  }

  const expectedPath = driverPath ? path.resolve(driverPath) : undefined;
  let removed = false;
  for (const key of keys) {
    const entry = meta[key];
    if (!entry) continue;
    if (expectedPath && path.resolve(entry.driverPath) !== expectedPath) continue;
    delete meta[key];
    removed = true;
  }

  if (removed) writeMetadata(meta);
  return removed;
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
        timeout: VERSION_PROBE_TIMEOUT_MS,
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
      timeout: PATH_PROBE_TIMEOUT_MS,
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

  process.stderr.write(
    `[craftdriver] Downloading chromedriver ${chosen.version}…\n`,
  );
  fs.mkdirSync(cacheDir(), { recursive: true });

  // Download and extract inside a per-call unique working directory. Several
  // launches can resolve the same missing version at once (parallel test
  // workers, each its own process, share the one on-disk cache); a fixed temp
  // path let them clobber each other's zip mid-download or delete it
  // mid-extract ("unzip: cannot find or open …" / "invalid compressed data").
  // mkdtempSync hands each caller a distinct directory — safe across processes —
  // and the finally removes it whatever happens.
  const workDir = fs.mkdtempSync(path.join(cacheDir(), '_dl-chromedriver-'));
  try {
    const tmpZip = path.join(workDir, 'chromedriver.zip');
    await httpsDownload(entry.url, tmpZip);

    // CfT zip layout: chromedriver-<platform>/chromedriver[.exe]
    const extractDir = path.join(workDir, 'extract');
    extractZip(tmpZip, extractDir);

    const innerBin = path.join(extractDir, `chromedriver-${platform}`, binName);
    if (!fs.existsSync(innerBin)) {
      throw new Error(
        `Unexpected zip layout: could not find ${innerBin} after extraction.`,
      );
    }

    fs.mkdirSync(driverDir, { recursive: true });
    // A concurrent resolver may have placed the binary first. On POSIX rename
    // atomically replaces it; on Windows rename onto an existing file throws, so
    // treat an already-present destination as success.
    try {
      fs.renameSync(innerBin, driverBin);
    } catch (err) {
      if (!fs.existsSync(driverBin)) throw err;
    }

    if (os.platform() !== 'win32') fs.chmodSync(driverBin, 0o755);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

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

  // Skip the GitHub API call when a fresh cached geckodriver is still on disk.
  const cachedPath = readFreshCachedDriver(cacheKey);
  if (cachedPath) return cachedPath;

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

    process.stderr.write(`[craftdriver] Downloading geckodriver ${version}…\n`);
    fs.mkdirSync(cacheDir(), { recursive: true });

    // Per-call unique working directory so parallel resolvers don't share a
    // fixed temp path and extract dir — same race, and fix, as
    // downloadChromedriver above. (`test:firefox` runs with --maxWorkers=2.)
    const workDir = fs.mkdtempSync(path.join(cacheDir(), '_dl-geckodriver-'));
    try {
      const tmpFile = path.join(workDir, `geckodriver${ext}`);
      await httpsDownload(asset.browser_download_url, tmpFile);

      // geckodriver archives contain the binary at the archive root.
      const extractDir = path.join(workDir, 'extract');
      if (ext === '.zip') {
        extractZip(tmpFile, extractDir);
      } else {
        extractTarGz(tmpFile, extractDir);
      }

      const innerBin = path.join(extractDir, binName);
      if (!fs.existsSync(innerBin)) {
        throw new Error(
          `Unexpected archive layout: could not find ${innerBin} after extraction.`,
        );
      }

      fs.mkdirSync(driverDir, { recursive: true });
      // See downloadChromedriver: tolerate a destination a concurrent resolver
      // already placed (Windows rename onto an existing file throws).
      try {
        fs.renameSync(innerBin, driverBin);
      } catch (err) {
        if (!fs.existsSync(driverBin)) throw err;
      }

      if (os.platform() !== 'win32') fs.chmodSync(driverBin, 0o755);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  // Refresh TTL record regardless of whether we downloaded a new version.
  recordResolvedDriver(cacheKey, version, driverBin);
  return driverBin;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// CI platforms that pre-install a version-matched driver and publish its
// directory via an env var. Not craftdriver-specific — these are the
// platform's own convention — so this step ranks below explicit config
// (steps 1-3) and only fills a gap when nothing more specific was set.
// Confirmed present with matching semantics on GitHub Actions' Ubuntu, macOS,
// and Windows runner images (see actions/runner-images per-image READMEs).
const CHROME_CI_DIR_ENV_VARS = ['CHROMEWEBDRIVER'];   // GitHub Actions
const GECKO_CI_DIR_ENV_VARS  = ['GECKOWEBDRIVER'];    // GitHub Actions

/**
 * Resolves a custom **browser** binary (Chrome/Chromium/Firefox) — distinct
 * from `resolveChromeDriver`/`resolveFirefoxDriver`, which resolve the
 * *driver* (chromedriver/geckodriver). Returns `undefined` when
 * nothing resolves, in which case the caller forwards nothing and
 * chromedriver/geckodriver fall back to their own built-in browser discovery
 * (craftdriver's zero-config default, unchanged).
 *
 * Resolution chain (first match wins), each step validated with
 * `fs.existsSync` — an invalid path falls through rather than being forwarded:
 *   1. `explicitPath` (e.g. LaunchOptions.browserPath)
 *   2. CRAFTDRIVER_CHROME_PATH / CRAFTDRIVER_FIREFOX_PATH (browser-specific)
 *   3. CRAFTDRIVER_BROWSER_PATH (generic fallback, either browser)
 *   4. Legacy/compatible env vars: CHROME_BIN / FIREFOX_BIN (community
 *      convention), SE_CHROME_PATH / SE_FIREFOX_PATH (Selenium Manager)
 */
export function resolveBrowserBinaryPath(
  kind: 'chrome' | 'firefox',
  explicitPath?: string,
): string | undefined {
  if (explicitPath) {
    if (fs.existsSync(explicitPath)) return explicitPath;
    // A candidate was actually supplied here, so a silent fallthrough would
    // hide a typo behind a browser that quietly launches from somewhere else
    // entirely. Everything below the auto-download path already announces
    // itself the same way (see downloadChromedriver/downloadGeckodriver).
    process.stderr.write(
      `[craftdriver] browserPath "${explicitPath}" does not exist; falling back to the next resolution step.\n`,
    );
  }

  const specificEnvVar = kind === 'chrome' ? 'CRAFTDRIVER_CHROME_PATH' : 'CRAFTDRIVER_FIREFOX_PATH';
  const legacyBinEnvVar = kind === 'chrome' ? 'CHROME_BIN' : 'FIREFOX_BIN';
  const legacySeEnvVar = kind === 'chrome' ? 'SE_CHROME_PATH' : 'SE_FIREFOX_PATH';

  for (const envVar of [specificEnvVar, 'CRAFTDRIVER_BROWSER_PATH', legacyBinEnvVar, legacySeEnvVar]) {
    const p = process.env[envVar];
    if (!p) continue;
    if (fs.existsSync(p)) return p;
    process.stderr.write(
      `[craftdriver] ${envVar}="${p}" does not exist; falling back to the next resolution step.\n`,
    );
  }

  return undefined;
}

/** Resolves the path to a chromedriver binary, downloading if necessary. */
export async function resolveChromeDriver(options?: {
  binaryPath?: string;
  /**
   * A custom browser binary (see {@link resolveBrowserBinaryPath}). When the
   * driver itself has to be auto-downloaded (step 8), its version is detected
   * from *this* binary instead of the system Chrome candidate list — so a
   * custom Chromium build (whose version routinely doesn't match system
   * Chrome) gets a matching chromedriver, not the wrong one.
   */
  browserPath?: string;
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

  // 3.5. Known CI-provided driver directories (e.g. GitHub Actions'
  //      CHROMEWEBDRIVER). Cheaper than a cache read (fs.existsSync) and a
  //      stronger signal than anything below: the CI platform vendor
  //      guarantees this driver matches the pre-installed browser version.
  //      Not cached — it's already as cheap as a cache read, so caching it
  //      would only add stale-path risk for no benefit.
  for (const envVar of CHROME_CI_DIR_ENV_VARS) {
    const dir = process.env[envVar];
    if (!dir) continue;
    const candidate = path.join(dir, driverBinName());
    if (fs.existsSync(candidate)) return candidate;
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
  const cachedPath = readFreshCachedDriver(cacheKey);
  if (cachedPath) return cachedPath;

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

  // 8. Detect the browser + download a matching driver from CfT, then record
  //    the result in the auto-resolution cache read at step 4. If a custom
  //    browser binary was given, detect its version directly instead of
  //    probing the system Chrome candidate list (see resolveChromeDriver's
  //    `browserPath` option doc). This assumes the binary answers `--version`
  //    the way Chrome/Chromium does — untested against anything that doesn't
  //    (e.g. Electron), so `browserPath` is documented as Chrome/Chromium-only
  //    for now.
  const p = os.platform() as SupportedPlatform;
  const candidates = options?.browserPath ? [options.browserPath] : (CHROME_CANDIDATES[p] ?? ['google-chrome']);
  const detected = detectBrowserVersion(candidates);
  if (!detected) {
    throw new Error(
      options?.browserPath
        ? `Could not read a Chrome/Chromium version from browserPath "${options.browserPath}" ` +
          '(it did not respond to --version the way Chrome/Chromium does).\n' +
          'Set CRAFTDRIVER_CHROMEDRIVER_PATH to a chromedriver binary that matches it instead of relying on auto-detection.'
        : 'Could not detect a system Chrome or Chromium installation.\n' +
          'Install Chrome, or set CRAFTDRIVER_DRIVER_PATH to a local chromedriver binary.',
    );
  }
  const driverPath = await downloadChromedriver(detected.version);

  // Refresh TTL record regardless of whether we downloaded a new binary.
  recordResolvedDriver(cacheKey, detected.version, driverPath);
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

  // 3.5. Known CI-provided driver directories (e.g. GitHub Actions'
  //      GECKOWEBDRIVER). See resolveChromeDriver's equivalent step for why
  //      this ranks here and isn't cached.
  for (const envVar of GECKO_CI_DIR_ENV_VARS) {
    const dir = process.env[envVar];
    if (!dir) continue;
    const candidate = path.join(dir, geckoBinName());
    if (fs.existsSync(candidate)) return candidate;
  }

  // 4. Auto-resolution cache. Once geckodriver has been auto-resolved (step 8
  //    below writes this record), reuse it for a TTL window instead of probing
  //    PATH (a blocking `which` spawn) and re-detecting Firefox on every
  //    Browser.launch() — both stall the event loop and hurt parallel launches.
  //    Explicit config (arg + env vars above) always wins. Same record and TTL
  //    that downloadGeckodriver() maintains; tunable via CRAFTDRIVER_DRIVER_TTL.
  const cacheKey = `geckodriver/${geckodriverPlatform()}`;
  const cachedPath = readFreshCachedDriver(cacheKey);
  if (cachedPath) return cachedPath;

  // 5. Locally installed geckodriver npm package.
  const localBin = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
    'node_modules/.bin/geckodriver',
  );
  if (fs.existsSync(localBin)) return localBin;

  // 6. PATH probe (skipped when CRAFTDRIVER_SKIP_PATH_PROBE is set, e.g. in
  //    integration tests that need to exercise the auto-download path even on
  //    systems where geckodriver is already installed). Mirrors
  //    resolveChromeDriver's equivalent step.
  if (!process.env.CRAFTDRIVER_SKIP_PATH_PROBE && commandOnPath('geckodriver')) return 'geckodriver';

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
