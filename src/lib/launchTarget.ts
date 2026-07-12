export type SupportedBrowserName = 'chrome' | 'chromium' | 'firefox';

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
    if (requestedName !== 'chrome' && requestedName !== 'chromium' && requestedName !== 'firefox') {
      throw new Error(
        `Unsupported browser "${String(requestedName)}". Supported: chrome, chromium, firefox.`,
      );
    }

    return {
      kind: 'browser',
      browserName: requestedName,
      bidiRequested: enableBiDi !== false,
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
