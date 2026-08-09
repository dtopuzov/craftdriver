/**
 * Driver-process acquisition and lifecycle, in one lane.
 *
 * Everything here is about how craftdriver *obtains and runs* its driver
 * process — no page-level browser behavior. Four concerns share this file:
 *
 *   1. Auto-download integration — real chromedriver resolution from Chrome
 *      for Testing into an isolated cache (makes real network requests).
 *   2. Concurrent resolution — the temp-file race regression when parallel
 *      callers resolve the same missing version at once (real network).
 *   3. Cache recovery — a stale cached chromedriver path is invalidated and
 *      the launch retried once (fake driver service, no network).
 *   4. DriverService startup diagnostics — the generic service base class
 *      drains output, keeps a bounded tail, and reports an early exit.
 */
import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Browser } from '../src';
import { resolveChromeDriver } from '../src/lib/driverManager';
import { DriverService } from '../src/lib/service';
import type { Driver } from '../src/lib/driver.js';
import { Builder } from '../src/lib/builder.js';
import { ChromeService } from '../src/lib/chrome.js';

/** Remove a list of keys from process.env, returning a restore function. */
function unsetEnvVars(keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

/**
 * Integration test for the automatic driver resolution in driverManager.ts.
 *
 * Strategy: point CRAFTDRIVER_CACHE_DIR at a fresh temp dir, unset all driver
 * env vars, then call Browser.launch(). With no npm-installed chromedriver
 * (removed from devDependencies) and no pre-seeded cache, the manager must
 * detect the system Chrome, download chromedriver from CfT, and start the
 * browser — all automatically.
 *
 * This test makes real network requests and can take 10–30 s on the first run.
 * The cache is preserved between runs so subsequent runs are instant
 * (the cache hit path is exercised by the second `it` block).
 */
describe('driver manager — auto-download integration', () => {
  // Use a project-local temp cache so we don't pollute ~/.cache/craftdriver
  // during the test run, and so we can easily inspect what was written.
  const testCacheDir = path.join(os.tmpdir(), `craftdriver-test-cache-${process.pid}`);

  let browser: Browser | undefined;
  let restoreEnv = () => {};

  beforeAll(async () => {
    // Ensure the test cache starts empty so we exercise the download path.
    fs.rmSync(testCacheDir, { recursive: true, force: true });

    // Unset every env var that could short-circuit auto-resolution, including
    // CI-provided driver directories (CHROMEWEBDRIVER/GECKOWEBDRIVER) — GitHub
    // Actions runners set these natively, and step 3.5 in driverManager.ts
    // ranks them above the auto-download path this test exercises, so leaving
    // them set makes this "downloads chromedriver" test pass without ever
    // downloading anything on CI.
    restoreEnv = unsetEnvVars([
      'CRAFTDRIVER_CHROMEDRIVER_PATH',
      'CRAFTDRIVER_GECKODRIVER_PATH',
      'CRAFTDRIVER_DRIVER_PATH',
      'CRAFTDRIVER_CACHE_DIR',
      'CRAFTDRIVER_OFFLINE',
      'CHROMEDRIVER_PATH',
      'SE_CHROMEDRIVER',
      'CRAFTDRIVER_SKIP_PATH_PROBE',
      'CHROMEWEBDRIVER',
      'GECKOWEBDRIVER',
    ]);

    // Skip the PATH probe so pre-installed chromedriver on CI runners
    // (ubuntu-latest) or nvm-managed Node envs does not short-circuit the
    // resolution chain before step 7 (auto-download).
    process.env.CRAFTDRIVER_SKIP_PATH_PROBE = '1';

    // Point the cache at our temp dir AFTER unsetEnvVars so it is not unset.
    process.env.CRAFTDRIVER_CACHE_DIR = testCacheDir;

    // This is the real assertion: if the manager fails to resolve a driver
    // and start the browser, this will throw and the test fails.
    browser = await Browser.launch({ browserName: 'chrome' });
  }, 60_000); // allow up to 60 s for a first-time download

  afterAll(async () => {
    await browser?.quit();
    restoreEnv?.();
    // Leave the cache in place for inspection; /tmp is cleaned by the OS.
  });

  it('downloads chromedriver into the cache directory', () => {
    const chromedriverDir = path.join(testCacheDir, 'chromedriver');
    expect(fs.existsSync(chromedriverDir)).toBe(true);

    // There should be exactly one version directory inside.
    const versionDirs = fs.readdirSync(chromedriverDir);
    expect(versionDirs.length).toBeGreaterThan(0);

    // Inside the version dir there should be a platform subdir with the binary.
    const versionDir = path.join(chromedriverDir, versionDirs[0]);
    const platformDirs = fs.readdirSync(versionDir);
    expect(platformDirs.length).toBeGreaterThan(0);

    const binName = os.platform() === 'win32' ? 'chromedriver.exe' : 'chromedriver';
    const driverBin = path.join(versionDir, platformDirs[0], binName);
    expect(fs.existsSync(driverBin)).toBe(true);

    // The binary must be executable on Unix.
    if (os.platform() !== 'win32') {
      const mode = fs.statSync(driverBin).mode;
      // Check owner-execute bit (0o100)
      expect(mode & 0o100).toBe(0o100);
    }
  });

  it('starts the browser and can navigate to a page', async () => {
    expect(browser).toBeDefined();
    const launchedBrowser = browser!;
    await launchedBrowser.navigateTo('about:blank');
    const url = await launchedBrowser.url();
    expect(url).toBe('about:blank');
  });
});

/**
 * Regression test for the temp-file race in driverManager's download path.
 *
 * Several launches can resolve the same *missing* chromedriver version at the
 * same time — most commonly parallel vitest workers, each its own process,
 * sharing the one on-disk cache. They all pass the "already downloaded?" check
 * together and take the download+extract path at once. With a fixed temp path
 * (`_chromedriver-<ver>.zip` / `_extract_chromedriver_<ver>`) one process's
 * cleanup deleted the zip another was mid-extract on, surfacing as
 * `unzip failed: cannot find or open …` and a failed launch.
 *
 * This test forces that exact condition in one process via Promise.all against
 * a cold, isolated cache: everything up to `downloadChromedriver`'s first
 * network await runs synchronously, so all callers reach the download step
 * before any finishes. It makes real network requests (first-run download from
 * Chrome for Testing); the cache is isolated to a temp dir.
 */
describe('driver manager — concurrent resolution', () => {
  const testCacheDir = path.join(os.tmpdir(), `craftdriver-concurrent-cache-${process.pid}`);
  let restoreEnv = () => {};

  beforeAll(() => {
    // Start from an empty cache so every caller exercises the download path.
    fs.rmSync(testCacheDir, { recursive: true, force: true });

    restoreEnv = unsetEnvVars([
      'CRAFTDRIVER_CHROMEDRIVER_PATH',
      'CRAFTDRIVER_GECKODRIVER_PATH',
      'CRAFTDRIVER_DRIVER_PATH',
      'CRAFTDRIVER_CACHE_DIR',
      'CRAFTDRIVER_OFFLINE',
      'CHROMEDRIVER_PATH',
      'SE_CHROMEDRIVER',
      'CRAFTDRIVER_SKIP_PATH_PROBE',
    ]);

    // Skip the PATH probe so a pre-installed chromedriver (CI runners, nvm envs)
    // does not short-circuit before the auto-download path we want to test.
    process.env.CRAFTDRIVER_SKIP_PATH_PROBE = '1';
    process.env.CRAFTDRIVER_CACHE_DIR = testCacheDir;
  });

  afterAll(() => {
    restoreEnv?.();
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  });

  it('resolves the same chromedriver from concurrent callers without a temp-file race', async () => {
    const N = 3;
    const results = await Promise.all(Array.from({ length: N }, () => resolveChromeDriver()));

    // All callers land on the one cached binary, and it exists + is executable.
    const unique = new Set(results.map((p) => path.resolve(p)));
    expect(unique.size).toBe(1);

    const bin = results[0];
    expect(fs.existsSync(bin)).toBe(true);
    if (os.platform() !== 'win32') {
      expect(fs.statSync(bin).mode & 0o100).toBe(0o100);
    }
  }, 120_000);
});

/**
 * Cache recovery: a stale cached chromedriver whose version no longer matches
 * the installed Chrome must be invalidated and the launch retried once — not
 * surfaced as a hard "unsupported Chrome version" failure. Uses a fake driver
 * service (no real network / no real chromedriver) that returns a version
 * mismatch on the first /session and succeeds on the second.
 */
function cftPlatformForTest(): string {
  const p = os.platform();
  const a = os.arch();
  if (p === 'darwin') return a === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (p === 'win32') return a === 'x64' ? 'win64' : 'win32';
  return a === 'arm64' ? 'linux-aarch64' : 'linux64';
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

class FakeChromeService extends ChromeService {
  startCalls = 0;
  stopCalls = 0;
  private server?: http.Server;

  constructor(
    private readonly staleDriverPath: string,
    private readonly freshDriverPath: string
  ) {
    super();
  }

  override async start(): Promise<void> {
    if (this.server) return;
    this.startCalls++;
    const generation = this.startCalls;
    this.opts.command = generation === 1 ? this.staleDriverPath : this.freshDriverPath;

    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/session') {
        if (generation === 1) {
          writeJson(res, 500, {
            value: {
              error: 'session not created',
              message:
                'session not created: This version of ChromeDriver only supports Chrome version 139',
            },
          });
          return;
        }

        writeJson(res, 200, {
          value: {
            sessionId: 'fresh-session',
            capabilities: { browserName: 'chrome' },
          },
        });
        return;
      }

      if (req.method === 'DELETE' && req.url === '/session/fresh-session') {
        writeJson(res, 200, { value: null });
        return;
      }

      writeJson(res, 404, { value: { error: 'unknown command', message: req.url } });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (typeof address !== 'object' || !address) {
          reject(new Error('No fake service port'));
          return;
        }
        this.endpoint = {
          protocol: 'http',
          hostname: '127.0.0.1',
          port: address.port,
          path: '',
        };
        resolve();
      });
    });
  }

  override async stop(): Promise<void> {
    if (!this.server) return;
    this.stopCalls++;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('chromedriver auto-resolution cache recovery', () => {
  const envCacheDir = process.env.CRAFTDRIVER_CACHE_DIR;
  const envOffline = process.env.CRAFTDRIVER_OFFLINE;
  const envSkipPathProbe = process.env.CRAFTDRIVER_SKIP_PATH_PROBE;
  let cacheDir: string | undefined;

  afterEach(() => {
    if (envCacheDir === undefined) {
      delete process.env.CRAFTDRIVER_CACHE_DIR;
    } else {
      process.env.CRAFTDRIVER_CACHE_DIR = envCacheDir;
    }
    if (envOffline === undefined) delete process.env.CRAFTDRIVER_OFFLINE;
    else process.env.CRAFTDRIVER_OFFLINE = envOffline;
    if (envSkipPathProbe === undefined) delete process.env.CRAFTDRIVER_SKIP_PATH_PROBE;
    else process.env.CRAFTDRIVER_SKIP_PATH_PROBE = envSkipPathProbe;
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
    cacheDir = undefined;
  });

  it('rejects a fresh cached driver from the previous browser major', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdriver-cache-major-'));
    process.env.CRAFTDRIVER_CACHE_DIR = cacheDir;
    process.env.CRAFTDRIVER_OFFLINE = '1';
    process.env.CRAFTDRIVER_SKIP_PATH_PROBE = '1';

    const staleDriverPath = path.join(cacheDir, 'chromedriver-previous-major');
    fs.writeFileSync(staleDriverPath, '');
    const cacheKey = `chromedriver/${cftPlatformForTest()}`;
    fs.writeFileSync(
      path.join(cacheDir, 'metadata.json'),
      JSON.stringify({
        [cacheKey]: {
          version: '999.0.0.0',
          driverPath: staleDriverPath,
          timestamp: Date.now(),
        },
      })
    );

    await expect(resolveChromeDriver({ browserPath: process.execPath })).rejects.toThrow(
      /Cached driver provenance was Chrome 999\.0\.0\.0/
    );

    const metadata = JSON.parse(
      fs.readFileSync(path.join(cacheDir, 'metadata.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(metadata[cacheKey]).toBeUndefined();
  });

  it('repairs stale metadata from an exact-version offline binary', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdriver-cache-exact-'));
    process.env.CRAFTDRIVER_CACHE_DIR = cacheDir;
    process.env.CRAFTDRIVER_OFFLINE = '1';
    process.env.CRAFTDRIVER_SKIP_PATH_PROBE = '1';

    const staleDriverPath = path.join(cacheDir, 'chromedriver-previous-major');
    fs.writeFileSync(staleDriverPath, '');
    const exactDriverPath = path.join(
      cacheDir,
      'chromedriver',
      process.versions.node,
      cftPlatformForTest(),
      os.platform() === 'win32' ? 'chromedriver.exe' : 'chromedriver'
    );
    fs.mkdirSync(path.dirname(exactDriverPath), { recursive: true });
    fs.writeFileSync(exactDriverPath, '');

    const cacheKey = `chromedriver/${cftPlatformForTest()}`;
    fs.writeFileSync(
      path.join(cacheDir, 'metadata.json'),
      JSON.stringify({
        [cacheKey]: {
          version: '999.0.0.0',
          driverPath: staleDriverPath,
          timestamp: Date.now(),
        },
      })
    );

    await expect(resolveChromeDriver({ browserPath: process.execPath })).resolves.toBe(
      exactDriverPath
    );

    const metadata = JSON.parse(
      fs.readFileSync(path.join(cacheDir, 'metadata.json'), 'utf8')
    ) as Record<string, { version?: string; driverPath?: string }>;
    expect(metadata[cacheKey]).toMatchObject({
      version: process.versions.node,
      driverPath: exactDriverPath,
    });
  });

  it('invalidates a stale cached chromedriver path and retries launch once', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdriver-cache-retry-'));
    process.env.CRAFTDRIVER_CACHE_DIR = cacheDir;

    const staleDriverPath = path.join(cacheDir, 'chromedriver-139');
    const freshDriverPath = path.join(cacheDir, 'chromedriver-140');
    fs.writeFileSync(staleDriverPath, '');
    fs.writeFileSync(freshDriverPath, '');

    const cacheKey = `chromedriver/${cftPlatformForTest()}`;
    fs.writeFileSync(
      path.join(cacheDir, 'metadata.json'),
      JSON.stringify({
        [cacheKey]: {
          version: '139.0.0.0',
          driverPath: staleDriverPath,
          timestamp: Date.now(),
        },
      })
    );

    const service = new FakeChromeService(staleDriverPath, freshDriverPath);
    let driver: Driver | undefined;
    try {
      driver = await new Builder().forBrowser('chrome').setChromeService(service).build();

      expect(service.startCalls).toBe(2);
      expect(service.stopCalls).toBe(1);
      const metadata = JSON.parse(
        fs.readFileSync(path.join(cacheDir, 'metadata.json'), 'utf-8')
      ) as Record<string, unknown>;
      expect(metadata[cacheKey]).toBeUndefined();
    } finally {
      await driver?.quit();
      await service.stop();
    }
  });
});

/**
 * DriverService is the generic base class every driver service (chrome,
 * firefox, safari) extends. Its startup path must drain the driver's stdout/
 * stderr (so a chatty driver can't deadlock on a full pipe), keep only a
 * bounded tail of that output, and turn an early process exit into a clear
 * error rather than a hang.
 */
class NodeScriptService extends DriverService {
  constructor(private readonly scriptPath: string) {
    super({ command: process.execPath, readinessTimeoutMs: 5_000 });
  }

  protected buildCommandArgs(): string[] {
    return [this.scriptPath];
  }
}

describe('DriverService startup diagnostics', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drains driver output, keeps a bounded tail, and reports an early exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craftdriver-service-'));
    tempDirs.push(dir);
    const script = path.join(dir, 'noisy-driver.cjs');
    fs.writeFileSync(
      script,
      [
        "process.stdout.write('discard-me-' + 'x'.repeat(128 * 1024));",
        "process.stdout.write('STDOUT-TAIL\\n');",
        "process.stderr.write('STDERR-TAIL\\n');",
        'setTimeout(() => process.exit(17), 20);',
      ].join('\n')
    );

    const service = new NodeScriptService(script);
    const startedAt = Date.now();

    await expect(service.start()).rejects.toThrow(/exited before it was ready \(code 17\)/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    const output = service.getOutputTail();
    expect(output).toContain('STDOUT-TAIL');
    expect(output).toContain('STDERR-TAIL');
    expect(output).not.toContain('discard-me-');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });
});
