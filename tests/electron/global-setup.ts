/**
 * Vitest global setup for the Electron e2e suites: download the packaged example app
 * once (into the git-ignored `.electron-fixture/`) before any suite runs, so the
 * suites just resolve the path. Reused on later runs; only fetched when missing.
 * A skip (unsupported platform / no network) is left to the suites' `runIf` guard.
 */
import { ensureElectronApp } from './fixture';

export default async function setup(): Promise<void> {
  try {
    await ensureElectronApp();
  } catch (err) {
    // Don't fail the whole run here — the suites `runIf(appAvailable)` and skip.
    process.stderr.write(`[electron-fixture] setup skipped: ${(err as Error).message}\n`);
  }
}
