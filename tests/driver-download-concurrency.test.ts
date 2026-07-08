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

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { resolveChromeDriver } from '../src/lib/driverManager';
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
