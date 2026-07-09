/**
 * Micro-benchmark backing the CI-provided driver directory step (step 3.5 in
 * driverManager.ts's resolution chain — CHROMEWEBDRIVER / GECKOWEBDRIVER).
 *
 * Compares resolveChromeDriver() timing:
 *   - "ci-dir":    CHROMEWEBDRIVER set to a directory already containing the
 *                  driver — the new fast path (an fs.existsSync check).
 *   - "fallback":  the pre-existing cold-cache path this step used to force
 *                  every launch through on a fresh CI job: PATH probe (miss)
 *                  + Chrome-version detection, both blocking spawnSync calls.
 *
 * The exact driver version is pre-copied from this machine's real
 * ~/.cache/craftdriver into an isolated temp cache dir before timing starts,
 * so downloadChromedriver()'s "exact version already present" check (see
 * driverManager.ts's `downloadChromedriver`) short-circuits and no network
 * call happens during either measured path — only the PATH probe +
 * version-detect overhead this step is meant to save is being timed, not
 * download variance.
 *
 * Run with:  npm run bench -- driver-resolution
 */
import { describe, it } from 'vitest';
import { resolveChromeDriver } from '../../src/lib/driverManager.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { median, sample, printTable } from './_perf-utils.js';

const WARMUP_ITERATIONS = 1;
const MEASURED_ITERATIONS = 5;

const DRIVER_ENV_VARS = [
  'CRAFTDRIVER_CHROMEDRIVER_PATH',
  'CRAFTDRIVER_GECKODRIVER_PATH',
  'CRAFTDRIVER_DRIVER_PATH',
  'CRAFTDRIVER_CACHE_DIR',
  'CRAFTDRIVER_OFFLINE',
  'CHROMEDRIVER_PATH',
  'SE_CHROMEDRIVER',
  'CRAFTDRIVER_SKIP_PATH_PROBE',
  'CHROMEWEBDRIVER',
];

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

describe('Driver resolution: CI-provided directory vs PATH-probe/version-detect fallback', () => {
  it(
    'resolveChromeDriver(): CHROMEWEBDRIVER vs cold PATH-probe/version-detect fallback',
    async () => {
      const testRoot = path.join(os.tmpdir(), `craftdriver-perf-driverres-${process.pid}`);
      const testCacheDir = path.join(testRoot, 'cache');
      fs.rmSync(testRoot, { recursive: true, force: true });
      const restoreEnv = unsetEnvVars(DRIVER_ENV_VARS);

      try {
        process.env.CRAFTDRIVER_CACHE_DIR = testCacheDir;

        // Pre-populate the isolated cache with the already-downloaded driver
        // from this machine's real cache, keyed under its detected version, so
        // downloadChromedriver()'s exact-version check hits and no network
        // call happens in either measured path below.
        const realCacheDir = path.join(os.homedir(), '.cache', 'craftdriver', 'chromedriver');
        if (!fs.existsSync(realCacheDir)) {
          throw new Error(
            `No pre-existing chromedriver cache at ${realCacheDir}. Run \`npm test\` once first ` +
            `so this benchmark can measure resolution overhead without a network download.`,
          );
        }
        fs.mkdirSync(testCacheDir, { recursive: true });
        fs.cpSync(realCacheDir, path.join(testCacheDir, 'chromedriver'), { recursive: true });

        /** Clear only the TTL memo, keeping the pre-copied driver files, so
         *  resolution falls all the way through PATH probe + version-detect
         *  every iteration instead of hitting the warm-cache read. */
        function clearResolutionMemo(): void {
          fs.rmSync(path.join(testCacheDir, 'metadata.json'), { force: true });
        }

        async function fallbackOnce(): Promise<number> {
          clearResolutionMemo();
          const start = performance.now();
          await resolveChromeDriver();
          return performance.now() - start;
        }

        const fallback = await sample(fallbackOnce, WARMUP_ITERATIONS, MEASURED_ITERATIONS);

        // Now measure the CI-dir fast path: point CHROMEWEBDRIVER at a copy of
        // the same real driver binary.
        const binName = os.platform() === 'win32' ? 'chromedriver.exe' : 'chromedriver';
        const ciDir = path.join(testRoot, 'chromewebdriver');
        fs.mkdirSync(ciDir, { recursive: true });
        const versionDir = fs.readdirSync(path.join(testCacheDir, 'chromedriver'))[0];
        const platformDir = fs.readdirSync(path.join(testCacheDir, 'chromedriver', versionDir))[0];
        fs.copyFileSync(
          path.join(testCacheDir, 'chromedriver', versionDir, platformDir, binName),
          path.join(ciDir, binName),
        );
        if (os.platform() !== 'win32') fs.chmodSync(path.join(ciDir, binName), 0o755);
        process.env.CHROMEWEBDRIVER = ciDir;

        async function ciDirOnce(): Promise<number> {
          const start = performance.now();
          await resolveChromeDriver();
          return performance.now() - start;
        }

        const ciDetection = await sample(ciDirOnce, WARMUP_ITERATIONS, MEASURED_ITERATIONS);

        printTable('resolveChromeDriver() wall time', [
          { label: 'CHROMEWEBDRIVER set (new)', values: ciDetection },
          { label: 'PATH-probe/version-detect (old)', values: fallback },
        ]);
        const gap = median(fallback) - median(ciDetection);
        console.log(
          `  CI-dir detection saves ~${gap.toFixed(1)}ms per cold resolveChromeDriver() call ` +
          `vs. the PATH-probe/version-detect fallback.`,
        );
      } finally {
        restoreEnv();
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
