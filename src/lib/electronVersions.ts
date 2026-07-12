/**
 * Electron → Chromium major-version map, used to resolve a matching
 * Chrome-for-Testing chromedriver from an app's Electron version — so an Electron
 * user can drop the `electron-chromedriver` dependency (see
 * {@link resolveElectronChromeDriverInfo}).
 *
 * WHY A VENDORED MAP (not the `electron-to-chromium` package WDIO uses):
 * craftdriver ships an intentionally tiny dependency surface, and Electron is an
 * optional target — pulling a data package into every install (or making users
 * install one) to serve a niche feature isn't worth it. The chromedriver
 * downloader only needs the Chromium **major** to pick a compatible driver
 * (`downloadChromedriver` matches within a major), and Electron bumps its
 * Chromium major roughly quarterly, so this table is small and slow-moving.
 *
 * MAINTENANCE: add one row per new Electron major. Source of truth for a pair is
 * the `electron-to-chromium` package or https://electronjs.org/headers/index.json
 * (both list the exact Chromium each Electron release bundles). An unmapped
 * version fails with actionable guidance rather than guessing, so a missing row
 * is a clear error, never a wrong driver.
 *
 * COVERAGE NOTE: Chrome for Testing only publishes chromedriver for Chromium
 * >= 115 (Electron >= 26), and a brand-new Chromium major can lag CfT by weeks.
 * Mapping a version whose Chromium isn't in CfT yet still fails at download with
 * CfT's own "no chromedriver found" error — pin `electron-chromedriver` or an
 * explicit `chromedriverPath` for those.
 */

/**
 * Electron major → bundled Chromium major. Kept as majors because the CfT
 * chromedriver selection is major-scoped; a driver is compatible across a
 * Chromium major, so the exact build isn't needed to pick the right one.
 */
const ELECTRON_MAJOR_TO_CHROMIUM_MAJOR: Readonly<Record<number, number>> = {
  // Historical, CfT-covered range (Chromium >= 115). Verified against
  // electron-to-chromium.
  26: 116,
  27: 118,
  28: 120,
  29: 122,
  30: 124,
  31: 126,
  32: 128,
  33: 130,
  34: 132,
  35: 134,
  36: 136,
  37: 138,
  38: 140,
  // 39 verified live: Fiddler Everywhere 7.8 is Electron 39.8.6 / Chromium 142
  // (read from its Electron Framework), driven end-to-end. 40–42 follow the exact
  // +2-Chromium-major-per-Electron-major cadence this table holds across 26→43
  // (37→138, 38→140, 39→142, … 43→150); re-verify against electron-to-chromium
  // when an app pins one.
  39: 142,
  40: 144,
  41: 146,
  42: 148,
  // craftdriver's own compatibility target (see docs/electron.md): Electron
  // 43.1.0 bundles Chromium 150. Verified end-to-end: CfT publishes a matching
  // chromedriver (150.0.7871.115), so `electron: { version: '43.1.0' }` resolves
  // a matching driver with no electron-chromedriver dependency.
  43: 150,
};

/**
 * Parse the leading integer major from an Electron version string
 * (`'43.1.0'` → 43, `'37'` → 37). Returns `undefined` for anything without a
 * numeric leading component.
 */
function electronMajor(version: string): number | undefined {
  const match = /^\s*(\d+)/.exec(version);
  if (!match) return undefined;
  return Number.parseInt(match[1], 10);
}

/**
 * Map an Electron version to the Chromium **major** it bundles, or `undefined`
 * when the version is malformed or not in the vendored table. Pure — no I/O.
 */
export function chromiumMajorForElectron(electronVersion: string): number | undefined {
  const major = electronMajor(electronVersion);
  if (major === undefined) return undefined;
  return ELECTRON_MAJOR_TO_CHROMIUM_MAJOR[major];
}

/** The Electron majors this build knows how to map, ascending — for diagnostics. */
export function knownElectronMajors(): number[] {
  return Object.keys(ELECTRON_MAJOR_TO_CHROMIUM_MAJOR)
    .map((k) => Number.parseInt(k, 10))
    .sort((a, b) => a - b);
}
