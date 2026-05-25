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

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser } from '../src';
import path from 'path';
import os from 'os';
import fs from 'fs';

/** Remove a list of keys from process.env, returning a restore function. */
function unsetEnvVars(keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  };
}

describe('driver manager — auto-download integration', () => {
  // Use a project-local temp cache so we don't pollute ~/.cache/craftdriver
  // during the test run, and so we can easily inspect what was written.
  const testCacheDir = path.join(os.tmpdir(), `craftdriver-test-cache-${process.pid}`);

  let browser: Browser | undefined;
  let restoreEnv: () => void;

  beforeAll(async () => {
    // Ensure the test cache starts empty so we exercise the download path.
    fs.rmSync(testCacheDir, { recursive: true, force: true });

    // Unset every env var that could short-circuit auto-resolution.
    restoreEnv = unsetEnvVars([
      'CRAFTDRIVER_CHROMEDRIVER_PATH',
      'CRAFTDRIVER_GECKODRIVER_PATH',
      'CRAFTDRIVER_DRIVER_PATH',
      'CRAFTDRIVER_CACHE_DIR',
      'CRAFTDRIVER_OFFLINE',
      'CHROMEDRIVER_PATH',
      'SE_CHROMEDRIVER',
    ]);

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
      expect(mode & 0o100).toBeTruthy();
    }
  });

  it('starts the browser and can navigate to a page', async () => {
    expect(browser).toBeDefined();
    await browser!.navigateTo('about:blank');
    const url = await browser!.url();
    expect(url).toBe('about:blank');
  });
});
