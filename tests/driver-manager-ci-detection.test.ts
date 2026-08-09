/**
 * Regression tests for the CI-provided driver directory step in
 * resolveChromeDriver() / resolveFirefoxDriver() (step 3.5 of the resolution
 * chain — see driverManager.ts's top-of-file comment).
 *
 * GitHub Actions runners pre-install a version-matched driver and publish its
 * directory via CHROMEWEBDRIVER / GECKOWEBDRIVER. This step must win over the
 * auto-resolution cache, npm-local binary, PATH probe, and download, but must
 * never override explicit craftdriver config.
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { resolveChromeDriver, resolveFirefoxDriver } from '../src/lib/driverManager';
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
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

const chromeBinName = os.platform() === 'win32' ? 'chromedriver.exe' : 'chromedriver';
const geckoBinName = os.platform() === 'win32' ? 'geckodriver.exe' : 'geckodriver';

/** Create a fake, non-empty, executable file at `dir/binName`. */
function writeFakeDriver(dir: string, binName: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, binName);
  fs.writeFileSync(bin, '#!/bin/sh\necho fake driver\n');
  if (os.platform() !== 'win32') fs.chmodSync(bin, 0o755);
  return bin;
}

describe('driver manager — CI-provided driver directories', () => {
  const testRoot = path.join(os.tmpdir(), `craftdriver-ci-detect-${process.pid}`);
  const testCacheDir = path.join(testRoot, 'cache');
  let restoreEnv = () => {};

  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });

    restoreEnv = unsetEnvVars([
      'CRAFTDRIVER_CHROMEDRIVER_PATH',
      'CRAFTDRIVER_GECKODRIVER_PATH',
      'CRAFTDRIVER_DRIVER_PATH',
      'CRAFTDRIVER_CACHE_DIR',
      'CRAFTDRIVER_OFFLINE',
      'CHROMEDRIVER_PATH',
      'SE_CHROMEDRIVER',
      'GECKODRIVER_PATH',
      'GECKODRIVER_FILEPATH',
      'SE_GECKODRIVER',
      'CRAFTDRIVER_SKIP_PATH_PROBE',
      'CHROMEWEBDRIVER',
      'GECKOWEBDRIVER',
    ]);

    // Skip the PATH probe so a chromedriver/geckodriver already on this
    // machine's PATH can't mask a resolution-order bug as a pass.
    process.env.CRAFTDRIVER_SKIP_PATH_PROBE = '1';
    process.env.CRAFTDRIVER_CACHE_DIR = testCacheDir;
  });

  afterEach(() => {
    restoreEnv?.();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  describe('resolveChromeDriver()', () => {
    it('resolves the driver from CHROMEWEBDRIVER when set to a directory containing it', async () => {
      // Placed under the isolated test root, so it can only be found via
      // CHROMEWEBDRIVER — never via PATH, npm-local, cache, or download.
      const dir = path.join(testRoot, 'chromewebdriver');
      const bin = writeFakeDriver(dir, chromeBinName);
      process.env.CHROMEWEBDRIVER = dir;

      const resolved = await resolveChromeDriver();
      expect(resolved).toBe(bin);

      // Must not have written to the auto-resolution cache.
      expect(fs.existsSync(path.join(testCacheDir, 'metadata.json'))).toBe(false);
    });

    it('prefers explicit CRAFTDRIVER_CHROMEDRIVER_PATH over CHROMEWEBDRIVER', async () => {
      const ciDir = path.join(testRoot, 'chromewebdriver');
      writeFakeDriver(ciDir, chromeBinName);
      process.env.CHROMEWEBDRIVER = ciDir;

      const explicitBin = writeFakeDriver(path.join(testRoot, 'explicit'), chromeBinName);
      process.env.CRAFTDRIVER_CHROMEDRIVER_PATH = explicitBin;

      const resolved = await resolveChromeDriver();
      expect(resolved).toBe(explicitBin);
    });

    it('falls through when CHROMEWEBDRIVER points at a nonexistent directory', async () => {
      process.env.CHROMEWEBDRIVER = path.join(testRoot, 'does-not-exist');
      // Force a fast, deterministic failure further down the chain instead of
      // a real network download, so this test only proves the bad CI var
      // didn't throw or get misused — not that the rest of the chain works.
      process.env.CRAFTDRIVER_OFFLINE = '1';

      await expect(resolveChromeDriver()).rejects.toThrow(/no compatible chromedriver was found/i);
    });

    it('is unaffected when CHROMEWEBDRIVER is unset', async () => {
      delete process.env.CHROMEWEBDRIVER;
      const localBin = writeFakeDriver(path.join(testRoot, 'explicit'), chromeBinName);
      process.env.CRAFTDRIVER_CHROMEDRIVER_PATH = localBin;

      const resolved = await resolveChromeDriver();
      expect(resolved).toBe(localBin);
    });
  });

  describe('resolveFirefoxDriver()', () => {
    it('resolves the driver from GECKOWEBDRIVER when set to a directory containing it', async () => {
      const dir = path.join(testRoot, 'geckowebdriver');
      const bin = writeFakeDriver(dir, geckoBinName);
      process.env.GECKOWEBDRIVER = dir;

      const resolved = await resolveFirefoxDriver();
      expect(resolved).toBe(bin);

      expect(fs.existsSync(path.join(testCacheDir, 'metadata.json'))).toBe(false);
    });

    it('prefers explicit CRAFTDRIVER_GECKODRIVER_PATH over GECKOWEBDRIVER', async () => {
      const ciDir = path.join(testRoot, 'geckowebdriver');
      writeFakeDriver(ciDir, geckoBinName);
      process.env.GECKOWEBDRIVER = ciDir;

      const explicitBin = writeFakeDriver(path.join(testRoot, 'explicit'), geckoBinName);
      process.env.CRAFTDRIVER_GECKODRIVER_PATH = explicitBin;

      const resolved = await resolveFirefoxDriver();
      expect(resolved).toBe(explicitBin);
    });

    it('falls through when GECKOWEBDRIVER points at a nonexistent directory', async () => {
      process.env.GECKOWEBDRIVER = path.join(testRoot, 'does-not-exist');
      process.env.CRAFTDRIVER_OFFLINE = '1';

      await expect(resolveFirefoxDriver()).rejects.toThrow(/no geckodriver was found/i);
    });

    it('is unaffected when GECKOWEBDRIVER is unset', async () => {
      delete process.env.GECKOWEBDRIVER;
      const localBin = writeFakeDriver(path.join(testRoot, 'explicit'), geckoBinName);
      process.env.CRAFTDRIVER_GECKODRIVER_PATH = localBin;

      const resolved = await resolveFirefoxDriver();
      expect(resolved).toBe(localBin);
    });
  });
});
