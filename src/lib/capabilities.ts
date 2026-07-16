import type { Capabilities } from './types.js';

/**
 * Fill the BiDi-request capabilities (`webSocketUrl` + prompt-ignore) when
 * absent; explicit caller values are left untouched. `promptBehavior: 'string'`
 * sends the plain `'ignore'` enum for strict W3C hubs (e.g. BrowserStack) that
 * reject the per-prompt map form; `'map'` (local default) ignores `beforeUnload`
 * explicitly. Either shape leaves prompts open so BiDi prompt events can fire.
 */
export function applyBidiDefaults(
  caps: Capabilities,
  bidiRequested: boolean,
  promptBehavior: 'map' | 'string' = 'map'
): void {
  if (!bidiRequested) return;
  if (caps.webSocketUrl === undefined) caps.webSocketUrl = true;
  if (caps.unhandledPromptBehavior === undefined) {
    caps.unhandledPromptBehavior =
      promptBehavior === 'string'
        ? 'ignore'
        : {
            alert: 'ignore',
            confirm: 'ignore',
            prompt: 'ignore',
            beforeUnload: 'ignore',
          };
  }
}

/**
 * Inputs for {@link buildLaunchCapabilities}. Everything here is already
 * resolved by the caller (`Browser.launch`) — this module stays pure so the
 * W3C capability shape (and the one place the Classic-vs-BiDi protocol choice
 * is encoded as `webSocketUrl`) is unit-testable without launching a browser.
 */
export interface LaunchCapabilityInput {
  /** `'chrome' | 'chromium' | 'firefox' | 'safari'`. Electron is chrome-family (see `isElectron`). */
  browserName: 'chrome' | 'chromium' | 'firefox' | 'safari';
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
 *
 * Branches on browser family explicitly (chrome-family / firefox / safari)
 * rather than a binary `isFirefox` if/else. The old binary shape meant
 * "anything that isn't Firefox" fell into the `goog:chromeOptions` branch —
 * harmless while only two families existed, but a real bug once Safari was
 * added: a naive change would have sent `goog:chromeOptions` (including
 * `--headless=new` and Chrome download prefs) to `safaridriver`, which
 * doesn't understand Chrome vendor capabilities. The switch below has an
 * exhaustive, `never`-typed default so a future browser family that forgets
 * its own branch fails to compile instead of silently reusing Chrome's.
 */
export function buildLaunchCapabilities(input: LaunchCapabilityInput): Capabilities {
  const caps: Capabilities = {};

  switch (input.browserName) {
    case 'chrome':
    case 'chromium': {
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
      break;
    }
    case 'firefox': {
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
      break;
    }
    case 'safari': {
      // Standard W3C capabilities only. No goog:chromeOptions, no
      // moz:firefoxOptions — safaridriver doesn't understand either. Safari
      // has no custom binary, args, mobileEmulation, or downloadsDir support
      // (all rejected upstream in resolveLaunchTarget()), so there is nothing
      // vendor-specific to attach here.
      //
      // Defense in depth on webSocketUrl: `input.bidiRequested` is already
      // always `false` for Safari by the time this function runs (enforced
      // in resolveLaunchTarget()/Browser.launch — Safari has no
      // documented WebDriver BiDi endpoint). We still don't read
      // `input.bidiRequested` in this branch at all, rather than trusting
      // that invariant here too — so even if a future caller path ever
      // miscomputes `bidiRequested` for Safari, this branch structurally
      // cannot emit `webSocketUrl`. This intentionally does not change the
      // single-`bidiRequested`-flag design for chrome-family/firefox below;
      // it's a narrow Safari-only safety net, not a second source of truth.
      break;
    }
    // Extension seam: a future browser family adds its own `case` here with
    // whatever vendor-prefixed capabilities it needs. The `never`-typed default
    // below forces that to be a compile error rather than silently reusing
    // Chrome's options — do not add speculative branches before there's a real
    // target.
    default: {
      const _exhaustive: never = input.browserName;
      throw new Error(`buildLaunchCapabilities: unhandled browserName "${String(_exhaustive)}"`);
    }
  }

  // Safari's branch above never reaches here with bidiRequested true (see the
  // comment in that branch) because it's rejected earlier in the launch
  // pipeline; this keeps the single-flag design for the other families.
  if (input.browserName !== 'safari') {
    applyBidiDefaults(caps, input.bidiRequested);
  }

  return caps;
}
