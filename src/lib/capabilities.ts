import type { Capabilities } from './types.js';

/**
 * Inputs for {@link buildLaunchCapabilities}. Everything here is already
 * resolved by the caller (`Browser.launch`) — this module stays pure so the
 * W3C capability shape (and the one place the Classic-vs-BiDi protocol choice
 * is encoded as `webSocketUrl`) is unit-testable without launching a browser.
 */
export interface LaunchCapabilityInput {
  /** `'chrome' | 'chromium' | 'firefox'`. Electron is chrome-family (see `isElectron`). */
  browserName: 'chrome' | 'chromium' | 'firefox';
  /** Electron target: chrome-family capabilities, but never `--headless` (GUI app). */
  isElectron?: boolean;
  /** From the `HEADLESS` env var. Ignored for Electron. */
  isHeadless: boolean;
  /**
   * Whether BiDi was requested. The default differs by target (browser users
   * must opt out; Electron users must opt in) — that policy lives in
   * `Browser.launch`; here we just
   * apply it by requesting `webSocketUrl`.
   */
  bidiRequested: boolean;
  /** `goog:chromeOptions.binary` / `moz:firefoxOptions.binary` (custom browser or Electron app binary). */
  browserBinary?: string;
  /** Directory downloads are routed to (set via browser prefs). */
  downloadsDir: string;
  /** Extra browser CLI flags (`goog:chromeOptions.args` / `moz:firefoxOptions.args`). */
  args?: string[];
  /** Pre-resolved `goog:chromeOptions.mobileEmulation` payload (Chrome/Chromium only). */
  mobileEmulation?: Record<string, unknown>;
}

/**
 * Build the W3C capabilities for a launch. Pure: no I/O, no driver spawn.
 */
export function buildLaunchCapabilities(input: LaunchCapabilityInput): Capabilities {
  const isFirefox = input.browserName === 'firefox';

  const caps: Capabilities = {};

  if (!isFirefox) {
    const chromeOptions: Record<string, unknown> = {
      // Electron is a GUI app with no headless mode — never inject --headless,
      // even if HEADLESS is set (it would make Electron fail to start a window).
      args: [
        ...(input.isHeadless && !input.isElectron ? ['--headless=new'] : []),
        ...(input.args ?? []),
      ],
      prefs: {
        'download.default_directory': input.downloadsDir,
        'download.prompt_for_download': false,
        'safebrowsing.enabled': true,
      },
    };
    if (input.browserBinary) chromeOptions.binary = input.browserBinary;
    if (input.mobileEmulation) chromeOptions.mobileEmulation = input.mobileEmulation;
    caps['goog:chromeOptions'] = chromeOptions;
  } else {
    const firefoxArgs: string[] = [];
    if (input.isHeadless) firefoxArgs.push('-headless');
    if (input.args?.length) firefoxArgs.push(...input.args);
    caps['moz:firefoxOptions'] = {
      args: firefoxArgs,
      prefs: {
        'browser.download.folderList': 2,
        'browser.download.dir': input.downloadsDir,
        'browser.download.useDownloadDir': true,
        'browser.helperApps.neverAsk.saveToDisk':
          'application/octet-stream,application/pdf,text/plain,text/csv,application/zip',
        'pdfjs.disabled': true,
      },
      ...(input.browserBinary ? { binary: input.browserBinary } : {}),
    };
  }

  if (input.bidiRequested) {
    // Request the BiDi WebSocket URL...
    caps.webSocketUrl = true;
    // ...and set all prompt types to 'ignore' so BiDi events fire and we can handle them.
    caps.unhandledPromptBehavior = {
      alert: 'ignore',
      confirm: 'ignore',
      prompt: 'ignore',
      beforeUnload: 'ignore',
    };
  }

  return caps;
}
