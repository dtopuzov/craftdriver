import { CraftdriverError, ErrorCode } from './errors.js';
import type { RemoteWebDriverOptions } from './remote.js';

// Unknown remote browser names must opt into BiDi explicitly.
const BIDI_CAPABLE_BY_DEFAULT = new Set(['chrome', 'chromium', 'firefox', 'edge', 'microsoftedge']);

// Local browser names — intentionally narrower than the free-form remote
// provider name. Duplicated as parallel unions in browser.ts, builder.ts,
// capabilities.ts, and tests/utils.ts; keep them in sync when adding a browser.
export type SupportedBrowserName = 'chrome' | 'chromium' | 'firefox' | 'safari';

/** Normalize a provider-facing name for internal engine-specific behavior. */
export function normalizeEngine(browserName: string): string {
  const lower = browserName.trim().toLowerCase();
  if (lower === 'edge' || lower === 'msedge' || lower === 'microsoftedge') return 'chrome';
  return lower;
}

/** Reject local launch options that safaridriver cannot honor. */
function assertSafariCompatible(options: Record<string, unknown>): void {
  const headlessEnv = process.env.HEADLESS;
  const checks: Array<{ present: boolean; feature: string; hint: string }> = [
    {
      present: headlessEnv === 'true' || headlessEnv === '1',
      feature: 'HEADLESS',
      hint: 'Safari has no supported headless mode. Unset the HEADLESS env var when launching Safari.',
    },
    {
      present: hasValue(options, 'args'),
      feature: 'args',
      hint: 'safaridriver does not accept browser command-line arguments. Omit args for Safari.',
    },
    {
      present: hasValue(options, 'browserPath'),
      feature: 'browserPath',
      hint:
        'Safari is launched from the installed app by safaridriver, not a chosen binary. ' +
        "To use Safari Technology Preview, pass its safaridriver path via SafariService's binaryPath instead.",
    },
    {
      present: hasValue(options, 'mobileEmulation'),
      feature: 'mobileEmulation',
      hint: 'Desktop Safari automation has no device/mobile emulation API. Omit mobileEmulation for Safari.',
    },
    {
      present: hasValue(options, 'downloadsDir'),
      feature: 'downloadsDir',
      hint: 'Safari exposes no download-directory configuration craftdriver can drive. Omit downloadsDir for Safari.',
    },
  ];

  const incompatible = checks.find((check) => check.present);
  if (incompatible) {
    throw new CraftdriverError(
      ErrorCode.UNSUPPORTED,
      `browserName: 'safari' cannot be combined with ${incompatible.feature}. ${incompatible.hint}`,
      { detail: { browserName: 'safari', feature: incompatible.feature } }
    );
  }
}

export interface BrowserLaunchTarget {
  kind: 'browser';
  browserName: SupportedBrowserName;
  bidiRequested: boolean;
  args?: string[];
  browserPath?: string;
}

export interface ElectronLaunchTarget {
  kind: 'electron';
  browserName: 'chrome';
  bidiRequested: boolean;
  appBinaryPath: string;
  chromedriverPath?: string;
  version?: string;
  /** Opt in to main-process access (`browser.electron.executeMain`) via `--inspect`. */
  mainProcess?: boolean;
  args?: string[];
}

export interface RemoteLaunchTarget {
  kind: 'remote';
  /** Provider-facing browser name, forwarded verbatim. */
  browserName: string;
  /** Normalized engine family for internal checks. */
  engine: string;
  bidiRequested: boolean;
  /** Validated shape; `parseRemoteEndpoint` (`remote.ts`) turns this into a `WebDriverEndpoint`. */
  remote: RemoteWebDriverOptions;
}

export type LaunchTarget = BrowserLaunchTarget | ElectronLaunchTarget | RemoteLaunchTarget;

function hasValue(options: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined;
}

function optionalString(value: unknown, optionName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${optionName} must be a non-empty string.`);
  }
  return value;
}

function optionalStringArray(value: unknown, optionName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${optionName} must be an array of strings.`);
  }
  return value;
}

// Local-only options rejected on a remote launch.
const REMOTE_CONFLICTS: Array<[string, string]> = [
  ['electron', 'remote and electron are different launch targets; choose one'],
  ['electronService', 'electronService only applies to an electron launch'],
  ['chromeService', 'a remote session has no local driver process to configure'],
  ['firefoxService', 'a remote session has no local driver process to configure'],
  ['safariService', 'a remote session has no local driver process to configure'],
  ['mobileEmulation', 'pass device capabilities via remote.capabilities instead'],
  ['args', 'pass browser flags via remote.capabilities (e.g. goog:chromeOptions.args) instead'],
  ['browserPath', 'a remote session launches whatever browser the grid/provider offers'],
  ['downloadsDir', 'remote sessions have no client-visible downloads directory'],
];

function resolveRemoteLaunchTarget(
  options: Record<string, unknown>,
  enableBiDi: unknown
): RemoteLaunchTarget {
  for (const [key, guidance] of REMOTE_CONFLICTS) {
    if (hasValue(options, key)) {
      throw new Error(`remote cannot be combined with ${key}; ${guidance}.`);
    }
  }

  const remote = options.remote;
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
    throw new Error('remote must be an object containing a url.');
  }
  const remoteOptions = remote as Record<string, unknown>;
  if (typeof remoteOptions.url !== 'string' || remoteOptions.url.trim() === '') {
    throw new Error('remote.url must be a non-empty string.');
  }

  const remoteCapabilities = remoteOptions.capabilities;
  const capsObject =
    remoteCapabilities &&
    typeof remoteCapabilities === 'object' &&
    !Array.isArray(remoteCapabilities)
      ? (remoteCapabilities as Record<string, unknown>)
      : undefined;
  const capsBrowserName = capsObject?.browserName;

  const topLevelBrowserName = options.browserName;
  if (
    topLevelBrowserName !== undefined &&
    (typeof topLevelBrowserName !== 'string' || topLevelBrowserName.trim() === '')
  ) {
    throw new Error('browserName must be a non-empty string.');
  }
  if (
    capsBrowserName !== undefined &&
    (typeof capsBrowserName !== 'string' || capsBrowserName.trim() === '')
  ) {
    throw new Error('remote.capabilities.browserName must be a non-empty string.');
  }

  if (
    typeof topLevelBrowserName === 'string' &&
    typeof capsBrowserName === 'string' &&
    topLevelBrowserName.toLowerCase() !== capsBrowserName.toLowerCase()
  ) {
    throw new Error(
      `browserName ("${topLevelBrowserName}") conflicts with remote.capabilities.browserName ` +
        `("${capsBrowserName}"); set only one.`
    );
  }

  const requestedName =
    (typeof topLevelBrowserName === 'string' ? topLevelBrowserName : undefined) ??
    (typeof capsBrowserName === 'string' ? capsBrowserName : undefined) ??
    'chrome';
  const engine = normalizeEngine(requestedName);

  // Known BiDi engines default on; other remote names require explicit opt-in.
  const defaultsToBidi = BIDI_CAPABLE_BY_DEFAULT.has(engine);
  const bidiRequested = defaultsToBidi ? enableBiDi !== false : enableBiDi === true;

  // A caller can't keep BiDi on yet disable its transport: webSocketUrl:false would
  // leave craftdriver negotiating a BiDi session the hub was never asked to provide,
  // silently degrading every BiDi feature to Classic. Reject the contradiction early.
  if (bidiRequested && capsObject?.webSocketUrl === false) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      'remote.capabilities.webSocketUrl is false, which disables WebDriver BiDi, but BiDi is ' +
        `enabled for "${requestedName}". Pass enableBiDi: false to run over WebDriver Classic, ` +
        'or remove webSocketUrl to keep BiDi.',
      { detail: { browserName: requestedName, feature: 'WebDriver BiDi' } }
    );
  }

  return {
    kind: 'remote',
    browserName: requestedName,
    engine,
    bidiRequested,
    remote: remoteOptions as unknown as RemoteLaunchTarget['remote'],
  };
}

/**
 * Reject `remote` at the CLI daemon and MCP entry points — both are local dev
 * tools by design. Permanent product boundary, not a gap to fill: no CLI flag
 * or MCP tool for remote exists, and none should be added.
 */
export function assertLocalOnlyLaunch(options: Record<string, unknown>): void {
  if (hasValue(options, 'remote')) {
    throw new CraftdriverError(
      ErrorCode.UNSUPPORTED,
      'The craftdriver CLI and MCP server are local dev tools and do not support remote ' +
        '(Selenium Grid / BrowserStack / cloud) sessions. Use the Browser.launch({ remote }) ' +
        'library API directly from your own script instead.',
      { detail: { feature: 'remote' } }
    );
  }
}

/**
 * Normalize and validate the mutually-exclusive browser/Electron/remote launch
 * surfaces before any filesystem I/O or driver process is started.
 *
 * This function deliberately accepts an untyped record: `Browser.launch` is a
 * JavaScript API and is also reached by JSON-driven integrations, so runtime
 * validation must not depend on TypeScript having checked the caller.
 */
export function resolveLaunchTarget(options: Record<string, unknown>): LaunchTarget {
  const enableBiDi = options.enableBiDi;
  if (enableBiDi !== undefined && typeof enableBiDi !== 'boolean') {
    throw new Error('enableBiDi must be a boolean.');
  }

  if (hasValue(options, 'remote')) {
    return resolveRemoteLaunchTarget(options, enableBiDi);
  }

  const electronWasProvided =
    Object.prototype.hasOwnProperty.call(options, 'electron') && options.electron !== undefined;

  if (!electronWasProvided) {
    if (hasValue(options, 'electronService')) {
      throw new Error('electronService requires the electron launch option.');
    }

    const requestedName = options.browserName ?? 'chrome';
    if (
      requestedName !== 'chrome' &&
      requestedName !== 'chromium' &&
      requestedName !== 'firefox' &&
      requestedName !== 'safari'
    ) {
      throw new Error(
        `Unsupported browser "${String(requestedName)}". Supported: chrome, chromium, firefox, safari.`
      );
    }

    if (requestedName === 'safari') {
      assertSafariCompatible(options);
    }

    // BiDi defaults to on for Chrome/Chromium/Firefox (`enableBiDi !== false`)
    // but Safari has no supported WebDriver BiDi implementation: it
    // defaults to off, and an explicit `enableBiDi: true` is rejected here,
    // before any driver process starts.
    if (requestedName === 'safari' && enableBiDi === true) {
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        "browserName: 'safari' cannot be combined with enableBiDi: true. " +
          'Safari has no supported WebDriver BiDi implementation. Omit enableBiDi (or pass false) for Safari.',
        { detail: { browserName: 'safari', feature: 'WebDriver BiDi' } }
      );
    }
    const bidiRequested = requestedName === 'safari' ? false : enableBiDi !== false;

    return {
      kind: 'browser',
      browserName: requestedName,
      bidiRequested,
      args: optionalStringArray(options.args, 'args'),
      browserPath: optionalString(options.browserPath, 'browserPath'),
    };
  }

  const electron = options.electron;
  if (!electron || typeof electron !== 'object' || Array.isArray(electron)) {
    throw new Error('electron must be an object containing appBinaryPath.');
  }
  const electronOptions = electron as Record<string, unknown>;

  const supportedElectronKeys = new Set([
    'appBinaryPath',
    'chromedriverPath',
    'version',
    'mainProcess',
    'args',
  ]);
  const unknownElectronKey = Object.keys(electronOptions).find(
    (key) => !supportedElectronKeys.has(key)
  );
  if (unknownElectronKey) {
    throw new Error(
      `Unsupported electron option "${unknownElectronKey}". ` +
        'Supported: appBinaryPath, chromedriverPath, version, mainProcess, args.'
    );
  }

  const mainProcess = electronOptions.mainProcess;
  if (mainProcess !== undefined && typeof mainProcess !== 'boolean') {
    throw new Error('electron.mainProcess must be a boolean.');
  }

  const conflicts: Array<[string, string]> = [
    ['browserName', 'electron selects its own Chromium target; omit browserName'],
    ['chromeService', 'use electronService for an Electron-specific driver service'],
    ['firefoxService', 'Firefox services cannot drive Electron'],
    ['safariService', 'Safari services cannot drive Electron'],
    ['mobileEmulation', 'mobile emulation does not model a desktop Electron shell'],
    ['args', 'put application/Electron/Chromium arguments in electron.args'],
    ['browserPath', 'electron.appBinaryPath is the executable path'],
  ];
  for (const [key, guidance] of conflicts) {
    if (hasValue(options, key)) {
      throw new Error(`electron cannot be combined with ${key}; ${guidance}.`);
    }
  }

  const appBinaryPath = optionalString(electronOptions.appBinaryPath, 'electron.appBinaryPath');
  if (!appBinaryPath) {
    throw new Error('electron.appBinaryPath is required.');
  }

  const chromedriverPath = optionalString(
    electronOptions.chromedriverPath,
    'electron.chromedriverPath'
  );
  if (chromedriverPath && hasValue(options, 'electronService')) {
    throw new Error(
      'electron.chromedriverPath cannot be combined with electronService; configure the path on ElectronService instead.'
    );
  }

  const version = optionalString(electronOptions.version, 'electron.version');
  // version and chromedriverPath are two different driver sources; letting
  // chromedriverPath silently win would ignore the version the user asked for.
  if (version && chromedriverPath) {
    throw new Error(
      'electron.version cannot be combined with electron.chromedriverPath; choose one driver source.'
    );
  }
  // A caller-supplied ElectronService owns its own driver config — mirror the
  // chromedriverPath rule so the version isn't quietly dropped.
  if (version && hasValue(options, 'electronService')) {
    throw new Error(
      'electron.version cannot be combined with electronService; configure version on ElectronService instead.'
    );
  }

  return {
    kind: 'electron',
    browserName: 'chrome',
    bidiRequested: enableBiDi === true,
    appBinaryPath,
    chromedriverPath,
    version,
    mainProcess: mainProcess === true,
    args: optionalStringArray(electronOptions.args, 'electron.args'),
  };
}
