import { CraftdriverError, ErrorCode } from './errors.js';

// Keep in sync with the other independently-declared browser-name unions:
// src/lib/browser.ts, src/lib/builder.ts, tests/utils.ts, src/cli/parseArgs.ts
// (plus a few narrower call-site unions downstream, e.g. capabilities.ts,
// tracing.ts, vibiumTrace.ts). This duplication is a known gap; consolidating
// to one source of truth is a separate, out-of-scope refactor.
export type SupportedBrowserName = 'chrome' | 'chromium' | 'firefox' | 'safari';

/**
 * Launch options that don't map onto Safari's public `safaridriver` surface.
 * None of these have a faithful Safari equivalent:
 * there is no supported headless mode, no browser-arg passthrough, no
 * alternate-binary launch (STP is selected via `SafariService`'s
 * `binaryPath`, not `browserPath`), no mobile/device emulation, and no
 * download-directory configuration craftdriver can drive. Checked here, at
 * launch-target resolution, so a Safari launch fails before any service
 * process starts rather than partially launching and then failing.
 */
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
      hint: 'Safari is launched from the installed app by safaridriver, not a chosen binary. ' +
        'To use Safari Technology Preview, pass its safaridriver path via SafariService\'s binaryPath instead.',
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
      { detail: { browserName: 'safari', feature: incompatible.feature } },
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

export type LaunchTarget = BrowserLaunchTarget | ElectronLaunchTarget;

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

/**
 * Normalize and validate the mutually-exclusive browser/Electron launch
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

  const electronWasProvided = Object.prototype.hasOwnProperty.call(options, 'electron') &&
    options.electron !== undefined;

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
        `Unsupported browser "${String(requestedName)}". Supported: chrome, chromium, firefox, safari.`,
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
        { detail: { browserName: 'safari', feature: 'WebDriver BiDi' } },
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
    'appBinaryPath', 'chromedriverPath', 'version', 'mainProcess', 'args',
  ]);
  const unknownElectronKey = Object.keys(electronOptions)
    .find((key) => !supportedElectronKeys.has(key));
  if (unknownElectronKey) {
    throw new Error(
      `Unsupported electron option "${unknownElectronKey}". ` +
      'Supported: appBinaryPath, chromedriverPath, version, mainProcess, args.',
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

  const appBinaryPath = optionalString(
    electronOptions.appBinaryPath,
    'electron.appBinaryPath',
  );
  if (!appBinaryPath) {
    throw new Error('electron.appBinaryPath is required.');
  }

  const chromedriverPath = optionalString(
    electronOptions.chromedriverPath,
    'electron.chromedriverPath',
  );
  if (chromedriverPath && hasValue(options, 'electronService')) {
    throw new Error(
      'electron.chromedriverPath cannot be combined with electronService; configure the path on ElectronService instead.',
    );
  }

  const version = optionalString(electronOptions.version, 'electron.version');
  // version and chromedriverPath are two different driver sources; letting
  // chromedriverPath silently win would ignore the version the user asked for.
  if (version && chromedriverPath) {
    throw new Error(
      'electron.version cannot be combined with electron.chromedriverPath; choose one driver source.',
    );
  }
  // A caller-supplied ElectronService owns its own driver config — mirror the
  // chromedriverPath rule so the version isn't quietly dropped.
  if (version && hasValue(options, 'electronService')) {
    throw new Error(
      'electron.version cannot be combined with electronService; configure version on ElectronService instead.',
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
