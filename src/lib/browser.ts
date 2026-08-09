import { Builder } from './builder.js';
import { ChromeService } from './chrome.js';
import { ElectronService, writeElectronDebug } from './electron.js';
import { diagnoseElectronLaunchFailure } from './electronDiagnostics.js';
import { ElectronRemote } from './electronRemote.js';
import { findFreePort } from './service.js';
import { FirefoxService } from './firefox.js';
import { SafariService } from './safari.js';
import { resolveBrowserBinaryPath } from './driverManager.js';
import { buildLaunchCapabilities } from './capabilities.js';
import { resolveLaunchTarget, type RemoteLaunchTarget } from './launchTarget.js';
import {
  parseRemoteEndpoint,
  buildRemoteCapabilities,
  redactUrlForLog,
  type RemoteWebDriverOptions,
} from './remote.js';
import { Driver } from './driver.js';
import { By } from './by.js';
import { Condition, WaitOptions, until } from './wait.js';
import {
  DEFAULT_ELEMENT_TIMEOUT_MS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  STATE_POLL_INTERVAL_MS,
  NETWORK_IDLE_SETTLE_MS,
  PORT_RELEASE_DELAY_MS,
  BIDI_CONNECT_MAX_ATTEMPTS,
  BIDI_CONNECT_BACKOFF_STEP_MS,
} from './timing.js';
import { ElementHandle } from './elementHandle.js';
import { Locator } from './locator.js';
import { expectDocument, expectSelector } from './expect.js';
import type { DocumentExpectApi, LocatorExpectApi } from './expect.js';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { Keyboard } from './keyboard.js';
import { Key } from './keys.js';
import { Mouse } from './mouse.js';
import { ActionsBuilder } from './actions.js';
import type { RemoteValue, ScriptEvaluateResult } from './bidi/types.js';
import type { BiDiConnection } from './bidi/connection.js';
import {
  BiDiSession,
  NetworkInterceptor,
  LogMonitor,
  SessionStateManager,
  type SessionState,
  type StorageStateOptions,
  type InterceptedRequest,
  type InterceptedResponse,
} from './bidi/index.js';
import { Frame } from './frame.js';
import { Page, isNoSuchWindowError } from './page.js';
import { bidiWaitFor } from './loadState.js';
import { BrowserContext } from './browserContext.js';
import { Tracer, type TraceStartOptions, type TraceStopOptions } from './tracing.js';
import { A11y } from './a11y.js';
import { Clock } from './clock.js';
import { CraftdriverError, ErrorCode } from './errors.js';
import {
  parseSessionState,
  hasNonEmptySessionStorage,
  isSessionStateEmpty,
  storageStateDetail,
} from './sessionStateValidation.js';
import { clickWithFastPath } from './clickFastPath.js';
import { fillWithFastPath } from './fillFastPath.js';
import { clearWithFastPath } from './clearFastPath.js';
import { waitForVisibleDiagnosed } from './visibilityDiagnosis.js';
import { runExpectScreenshot, shouldUpdateVisualBaselines } from './visual/index.js';
import type { ExpectScreenshotOptions, ScreenshotMatchResult } from './visual/index.js';
import { publicPageInitScript } from './initScript.js';
import { withRealmRetry } from './bidi/evaluate.js';

/** Device metrics for custom mobile emulation */
export interface DeviceMetrics {
  width: number;
  height: number;
  pixelRatio: number;
  mobile?: boolean;
  touch?: boolean;
}

/** Mobile emulation configuration */
export interface MobileEmulation {
  /** Use a predefined device (e.g., 'iPhone 14', 'Pixel 7') */
  deviceName?: string;
  /** Custom device metrics */
  deviceMetrics?: DeviceMetrics;
  /** Custom user agent string */
  userAgent?: string;
}

/**
 * Options for {@link Browser.emulate}. Every field is independent; only the
 * keys you pass are applied, others stay at their previous value. Passing
 * `null` for a field clears the override for that field.
 */
export interface EmulateOptions {
  /** `prefers-color-scheme` media query value. Chromium only. */
  colorScheme?: 'light' | 'dark' | 'no-preference' | null;
  /** `prefers-reduced-motion` media query value. Chromium only. */
  reducedMotion?: 'reduce' | 'no-preference' | null;
  /** `forced-colors` media query value. Chromium only. */
  forcedColors?: 'active' | 'none' | null;
  /** BCP-47 language tag, e.g. `'de-DE'`. Affects `navigator.language` and `Intl.*`. */
  locale?: string | null;
  /** IANA timezone, e.g. `'Europe/Berlin'`. Affects `Intl.DateTimeFormat` and `Date`. */
  timezoneId?: string | null;
  /** When `true`, network requests fail and `navigator.onLine === false`. Chromium only. */
  offline?: boolean;
}

/** Common mobile device presets */
export const devices = {
  'iPhone 14': {
    deviceMetrics: { width: 390, height: 844, pixelRatio: 3, mobile: true, touch: true },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  },
  'iPhone 14 Pro Max': {
    deviceMetrics: { width: 430, height: 932, pixelRatio: 3, mobile: true, touch: true },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  },
  'iPhone SE': {
    deviceMetrics: { width: 375, height: 667, pixelRatio: 2, mobile: true, touch: true },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  },
  'Pixel 7': {
    deviceMetrics: { width: 412, height: 915, pixelRatio: 2.625, mobile: true, touch: true },
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  },
  'Pixel 7 Pro': {
    deviceMetrics: { width: 412, height: 892, pixelRatio: 3.5, mobile: true, touch: true },
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  },
  'Samsung Galaxy S23': {
    deviceMetrics: { width: 360, height: 780, pixelRatio: 3, mobile: true, touch: true },
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  },
  'iPad Pro 11': {
    deviceMetrics: { width: 834, height: 1194, pixelRatio: 2, mobile: true, touch: true },
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  },
  'iPad Mini': {
    deviceMetrics: { width: 768, height: 1024, pixelRatio: 2, mobile: true, touch: true },
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  },
} as const;

export type DeviceName = keyof typeof devices;

/**
 * Resolve a `goog:chromeOptions.mobileEmulation` payload from the public
 * `MobileEmulation | DeviceName` option — a built-in device name maps to
 * Chrome's `deviceName`, otherwise a custom `deviceMetrics`/`userAgent` config
 * is built. Kept next to `devices`; `buildLaunchCapabilities` takes the result.
 */
function resolveMobileEmulationConfig(
  mobileEmulation: MobileEmulation | DeviceName
): Record<string, unknown> {
  const emulation =
    typeof mobileEmulation === 'string' ? devices[mobileEmulation] : mobileEmulation;

  if ('deviceName' in emulation && emulation.deviceName) {
    // Use Chrome's built-in device name
    return { deviceName: emulation.deviceName };
  }

  // Build custom mobile emulation config
  const mobileConfig: Record<string, unknown> = {};
  if (emulation.deviceMetrics) {
    mobileConfig.deviceMetrics = {
      width: emulation.deviceMetrics.width,
      height: emulation.deviceMetrics.height,
      pixelRatio: emulation.deviceMetrics.pixelRatio,
      mobile: emulation.deviceMetrics.mobile ?? true,
      touch: emulation.deviceMetrics.touch ?? true,
    };
  }
  if (emulation.userAgent) {
    mobileConfig.userAgent = emulation.userAgent;
  }
  return mobileConfig;
}

async function resolveElectronAppBinaryPath(appBinaryPath: string): Promise<string> {
  const resolved = path.resolve(appBinaryPath);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`electron.appBinaryPath "${appBinaryPath}" does not exist.`);
    }
    if (code === 'EACCES') {
      throw new Error(`electron.appBinaryPath "${appBinaryPath}" is not accessible.`);
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`electron.appBinaryPath "${appBinaryPath}" is not a file.`);
  }
  if (process.platform !== 'win32') {
    try {
      await fs.access(resolved, fsSync.constants.X_OK);
    } catch {
      throw new Error(`electron.appBinaryPath "${appBinaryPath}" is not executable.`);
    }
  }
  return resolved;
}

/**
 * Options for driving an Electron application (see `LaunchOptions.electron`).
 */
export interface ElectronLaunchOptions {
  /**
   * Path to the **packaged** Electron app's executable — becomes
   * `goog:chromeOptions.binary`. On macOS this is
   * `YourApp.app/Contents/MacOS/YourApp`; on Linux/Windows the app binary.
   *
   * The app must be packaged (or have its main baked into the Electron binary):
   * chromedriver injects its own flags and ignores an unpackaged
   * app-directory argument, so an unpackaged app boots as plain Chromium.
   * Relative paths resolve from `process.cwd()`. craftdriver validates that the
   * target exists and is executable before starting chromedriver.
   */
  appBinaryPath: string;
  /**
   * Path to a `chromedriver` matching the app's bundled Chromium — normally the
   * one shipped by `electron-chromedriver` (pin it to the Electron version used
   * to package the app). When omitted, craftdriver falls back to {@link version}
   * (if set), then looks for `electron-chromedriver` in your project's
   * `node_modules`. It is **never** resolved from a system Chrome install (that
   * driver would be the wrong version for Electron).
   *
   * Mutually exclusive with {@link version}.
   */
  chromedriverPath?: string;
  /**
   * The app's Electron version (e.g. `'37.2.0'`). craftdriver maps it to the
   * bundled Chromium major and downloads a matching **Chrome-for-Testing**
   * chromedriver — so you don't need a project-local `electron-chromedriver`.
   *
   * Resolves only for Electron majors in craftdriver's built-in map whose
   * Chromium major Chrome for Testing publishes (>= 115). For anything else, or
   * offline, pin {@link chromedriverPath} / `electron-chromedriver`. Mutually
   * exclusive with {@link chromedriverPath}.
   */
  version?: string;
  /**
   * Enable main-process access (`browser.electron.executeMain(...)`). Launches
   * the app with a Node inspector (`--inspect`) on a free local port so
   * craftdriver can run code in the Electron **main** process. Off by default —
   * opening a main-process inspector is opt-in. Requires the app build to keep
   * the `EnableNodeCliInspectArguments` fuse enabled (the default).
   */
  mainProcess?: boolean;
  /** Application/Electron/Chromium arguments forwarded to `goog:chromeOptions.args`. */
  args?: string[];
}

interface SharedLaunchOptions {
  /**
   * Enable WebDriver BiDi for network interception, logs, tracing, multi-tab,
   * isolated contexts, and other BiDi-only capabilities. Browsers default to
   * `true`; Electron defaults to Classic WebDriver and requires an explicit
   * `true` opt-in. Classic-equivalent commands still prefer the fastest correct
   * protocol per command.
   */
  enableBiDi?: boolean;
  /** Load session state on launch — a path to a saved JSON file, or an
   *  in-memory `SessionState` object. */
  storageState?: string | SessionState;
  /**
   * Directory where downloaded files are saved.
   * Defaults to a temporary directory unique to this session.
   */
  downloadsDir?: string;
}

interface BrowserLaunchOptions extends SharedLaunchOptions {
  electron?: never;
  electronService?: never;
  remote?: never;
  browserName?: 'chrome' | 'chromium' | 'firefox' | 'safari';
  chromeService?: ChromeService;
  firefoxService?: FirefoxService;
  safariService?: SafariService;
  /** Enable mobile device emulation (Chrome/Chromium only) */
  mobileEmulation?: MobileEmulation | DeviceName;
  /**
   * Extra command-line flags passed to the launched **browser** (appended to
   * `goog:chromeOptions.args` for Chrome/Chromium, `moz:firefoxOptions.args`
   * for Firefox). craftdriver sets no performance/behavior flags of its own by
   * default — this is the opt-in for advanced tuning, e.g. shaving browser
   * startup time. See the "Performance" section of `docs/driver-configuration.md`
   * for a measured, recommended set. Note: these are *browser* flags, distinct
   * from the *driver* (chromedriver/geckodriver) args on `ChromeService`/
   * `FirefoxService`.
   */
  args?: string[];
  /**
   * A custom **browser** binary to launch — Chrome, Chromium, or Firefox.
   * Distinct from `chromeService`/`firefoxService`'s `binaryPath`, which names
   * the *driver* (chromedriver/geckodriver), not the browser.
   *
   * When omitted, craftdriver resolves it from (first match wins):
   *   1. `CRAFTDRIVER_CHROME_PATH` / `CRAFTDRIVER_FIREFOX_PATH` env var
   *   2. `CRAFTDRIVER_BROWSER_PATH` env var (generic fallback — forwarded as-is
   *      regardless of browser, so avoid it when launching both in one job)
   *   3. `CHROME_BIN` / `FIREFOX_BIN` env var (common CI convention)
   *   4. `SE_CHROME_PATH` / `SE_FIREFOX_PATH` env var (Selenium Manager convention)
   *
   * This option itself is opt-in, but steps 2–4 read ambient env vars other
   * tools (Karma, Selenium Manager) may already export for their own
   * purposes — if one happens to be set, craftdriver forwards it even though
   * you never touched craftdriver config. If none resolve, craftdriver
   * forwards nothing and chromedriver/geckodriver fall back to their own
   * built-in browser discovery. An invalid candidate at any step logs a
   * `[craftdriver]` note to stderr and falls through rather than failing
   * silently. See "Browser Binary Configuration" in docs/driver-configuration.md.
   */
  browserPath?: string;
}

interface ElectronTargetLaunchOptions extends SharedLaunchOptions {
  /**
   * Automate a packaged Electron application's renderer instead of a browser.
   * Electron defaults to Classic WebDriver; pass `enableBiDi: true` to opt in.
   */
  electron: ElectronLaunchOptions;
  /**
   * Optional Electron-specific driver service for custom ports, environment,
   * or driver logging. When omitted, craftdriver creates one automatically.
   */
  electronService?: ElectronService;
  remote?: never;
  browserName?: never;
  chromeService?: never;
  firefoxService?: never;
  safariService?: never;
  mobileEmulation?: never;
  args?: never;
  browserPath?: never;
}

interface RemoteTargetLaunchOptions extends SharedLaunchOptions {
  /**
   * Connect to a W3C-compatible remote WebDriver endpoint — a self-hosted
   * Selenium Grid, BrowserStack, or another cloud provider — instead of
   * launching a local browser/driver process. See `docs/remote-webdriver.md`.
   *
   * Not reachable from the CLI daemon or MCP server: both are local dev
   * tools only (see `assertLocalOnlyLaunch` in `launchTarget.ts`).
   */
  remote: RemoteWebDriverOptions;
  electron?: never;
  electronService?: never;
  /** Any non-empty name the remote endpoint understands — not restricted to craftdriver's local browser whitelist. */
  browserName?: string;
  chromeService?: never;
  firefoxService?: never;
  safariService?: never;
  mobileEmulation?: never;
  args?: never;
  browserPath?: never;
  /** Remote sessions have no client-visible downloads directory; omit this option. */
  downloadsDir?: never;
}

/** Mutually-exclusive browser, Electron, and remote-WebDriver launch configurations. */
export type LaunchOptions =
  BrowserLaunchOptions | ElectronTargetLaunchOptions | RemoteTargetLaunchOptions;

/**
 * When to consider a navigation complete.
 * - `'load'` — page `load` event has fired (default)
 * - `'domcontentloaded'` — `DOMContentLoaded` has fired (faster, no waiting for images/fonts)
 * - `'networkidle'` — `load` + no in-flight requests for 500 ms
 * - `'none'` — do not wait; return as soon as the navigation is initiated
 */
export type LoadState = 'load' | 'domcontentloaded' | 'networkidle' | 'none';

/**
 * Selects a top-level page by `url` and/or `title` for {@link Browser.waitForPage}.
 * A string matches as a substring; a `RegExp` is tested. When both fields are given,
 * both must match.
 */
export interface PageMatcher {
  url?: string | RegExp;
  title?: string | RegExp;
}

/**
 * Pure predicate behind {@link Browser.waitForPage}'s matcher form: do a page's
 * `url`/`title` satisfy the matcher? Only the fields named in `matcher` are checked,
 * and every named field must match (string = substring, RegExp = test). Exported for
 * unit testing.
 */
export function matchPageFields(
  fields: { url?: string; title?: string },
  matcher: PageMatcher
): boolean {
  const hit = (value: string | undefined, pattern: string | RegExp | undefined): boolean =>
    pattern === undefined ||
    (value !== undefined &&
      (typeof pattern === 'string' ? value.includes(pattern) : pattern.test(value)));
  return hit(fields.url, matcher.url) && hit(fields.title, matcher.title);
}

/** The type of a browser dialog. */
export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

/**
 * Represents an open browser dialog (alert / confirm / prompt).
 * Passed to handlers registered with `browser.onDialog()`.
 */
export interface Dialog {
  /** Returns the dialog type: `'alert'`, `'confirm'`, `'prompt'`, or `'beforeunload'`. */
  type(): DialogType;
  /** Returns the message text shown in the dialog. */
  message(): string;
  /** Returns the default text pre-filled in a prompt dialog (empty string for non-prompt dialogs). */
  defaultValue(): string;
  /** Accept the dialog (OK button). For prompts, optionally pass `text` to fill the input first. */
  accept(text?: string): Promise<void>;
  /** Dismiss the dialog (Cancel button / close). */
  dismiss(): Promise<void>;
}

/** A file downloaded during a `waitForDownload()` call. */
export interface Download {
  /** Absolute path to the downloaded file on disk. */
  path: string;
  /** The filename as suggested by the server (from Content-Disposition or URL). */
  suggestedFilename: string;
  /** Copy the file to `targetPath`. */
  saveAs(targetPath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// BiDi value helpers — used only by Browser.evaluate()
// ---------------------------------------------------------------------------

function serializeLocalValue(v: unknown): Record<string, unknown> {
  if (v === undefined) return { type: 'undefined' };
  if (v === null) return { type: 'null' };
  if (typeof v === 'string') return { type: 'string', value: v };
  if (typeof v === 'boolean') return { type: 'boolean', value: v };
  if (typeof v === 'bigint') return { type: 'bigint', value: String(v) };
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { type: 'number', value: 'NaN' };
    if (v === Infinity) return { type: 'number', value: 'Infinity' };
    if (v === -Infinity) return { type: 'number', value: '-Infinity' };
    if (Object.is(v, -0)) return { type: 'number', value: '-0' };
    return { type: 'number', value: v };
  }
  if (Array.isArray(v)) return { type: 'array', value: v.map(serializeLocalValue) };
  if (typeof v === 'object') {
    return {
      type: 'object',
      value: Object.entries(v as Record<string, unknown>).map(([k, val]) => [
        k,
        serializeLocalValue(val),
      ]),
    };
  }
  throw new CraftdriverError(
    ErrorCode.EVAL_BAD_ARG,
    `evaluate() argument of type "${typeof v}" is not JSON-serializable. ` +
      `Only primitive types, arrays, and plain objects are supported.`,
    { detail: { argType: typeof v } }
  );
}

function unwrapRemoteValue(v: RemoteValue): unknown {
  switch (v.type) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
      return v.value;
    case 'boolean':
      return v.value;
    case 'bigint':
      return BigInt(v.value);
    case 'number': {
      if (v.value === 'NaN') return NaN;
      if (v.value === 'Infinity') return Infinity;
      if (v.value === '-Infinity') return -Infinity;
      if (v.value === '-0') return -0;
      return v.value;
    }
    case 'array':
      return (v.value ?? []).map(unwrapRemoteValue);
    case 'object':
      return Object.fromEntries(
        (v.value ?? []).map(([k, val]) => [
          typeof k === 'string' ? k : String(unwrapRemoteValue(k as RemoteValue)),
          unwrapRemoteValue(val),
        ])
      );
    case 'date':
      return new Date(v.value);
    case 'function':
      throw new CraftdriverError(
        ErrorCode.EVAL_BAD_ARG,
        'evaluate() returned a function, which is not JSON-serializable. ' +
          'Return a primitive, array, or plain object instead.',
        { detail: { returnedType: 'function' } }
      );
    case 'node':
    case 'window':
      throw new CraftdriverError(
        ErrorCode.EVAL_BAD_ARG,
        `evaluate() returned a ${v.type} reference, which is not JSON-serializable. ` +
          'Return a primitive, array, or plain object instead.',
        { detail: { returnedType: v.type } }
      );
    default:
      return null;
  }
}

/** Shape of a BiDi `browsingContext.getTree` entry. */
interface BidiContextInfo {
  context: string;
  url: string;
  parent?: string;
  userContext?: string;
  children?: BidiContextInfo[];
}

/**
 * Internal agent-session hook. The symbol keeps the navigation fence out of
 * the documented Browser API while still letting the CLI arm it before its
 * shared dispatcher invokes an Enter/submit action.
 */
export const INTERNAL_RUN_WITH_NAVIGATION_FENCE = Symbol('runWithNavigationFence');
export const INTERNAL_FILL_AND_SUBMIT = Symbol('fillAndSubmit');
export const INTERNAL_EVALUATE_CLASSIC = Symbol('evaluateClassic');

// Includes a small pre-action identity probe; measured no-navigation fence
// cost remains ~150 ms in a persistent session.
const NAVIGATION_DETECTION_WINDOW_MS = 140;
const NAVIGATION_FENCE_CEILING_MS = 500;
const NAVIGATION_LOAD_STABILITY_MS = 25;

interface ClassicNavigationProbe {
  url: string;
  documentId: string;
  readyState: string;
}

const CLASSIC_NAVIGATION_PROBE = `
const key = Symbol.for('craftdriver.navigationFence.documentId');
if (!window[key]) {
  window[key] = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}
return {
  url: location.href,
  documentId: window[key],
  readyState: document.readyState,
};
`;

/** Best-effort string form of a selector (CSS string or By descriptor) for tracing. */
function selectorToString(sel: string | By | undefined): string | undefined {
  if (sel === undefined) return undefined;
  if (typeof sel === 'string') return sel;
  try {
    if (sel && typeof (sel as { using?: unknown }).using === 'string') {
      const b = sel as { using: string; value: string };
      return `${b.using}=${b.value}`;
    }
    return String(sel);
  } catch {
    return undefined;
  }
}

/** Recursively find the child context that matches an iframe's src URL. */
function findIframeContext(ctx: BidiContextInfo, iframeSrc: string | null): string | undefined {
  if (!ctx.children) return undefined;
  for (const child of ctx.children) {
    if (!iframeSrc || (child.url && child.url.startsWith(iframeSrc.replace(/\/$/, '')))) {
      return child.context;
    }
    const nested = findIframeContext(child, iframeSrc);
    if (nested) return nested;
  }
  // If src matching fails, return the first child context
  if (ctx.children.length > 0) return ctx.children[0].context;
  return undefined;
}

export class Browser {
  private bidiSession?: BiDiSession;
  private _network?: NetworkInterceptor;
  private _defaultContext?: BrowserContext;
  /** Cache of {@link BrowserContext} wrappers keyed by user-context id. */
  private _contextsById = new Map<string, BrowserContext>();
  /** Top-level browsing-context ids keyed to their BiDi user-context id. */
  private _topLevelContextUserContexts = new Map<string, string>();
  private _topLevelContextTracking?: Promise<void>;
  private _topLevelContextTrackingOffs: Array<() => void> = [];
  private _topLevelContextCacheVersion = 0;
  private _destroyedTopLevelContextIds = new Set<string>();
  private _logs?: LogMonitor;
  private _tracer?: Tracer;
  private _storage?: SessionStateManager;
  private _a11y?: A11y;
  private _clock?: Clock;
  /** Browser-scoped BiDi preload scripts registered via addInitScript()/clock. */
  private _browserInitScriptIds = new Set<string>();
  private _downloadsDir?: string;
  private _driverService?: { stop: () => Promise<void> };
  /** Main-process inspector endpoint, set when launched with `electron.mainProcess`. */
  private _electronInspect?: { host: string; port: number };
  /** The launched Electron app's executable path (for deep-link routing on Windows). */
  private _electronAppBinaryPath?: string;
  private _electron?: ElectronRemote;
  /** Requested local name or provider-facing remote name. */
  private _browserName: string = 'chrome';
  /** Lowercase engine family for engine-specific branches (Edge → `chrome`); see `normalizeEngine`. */
  private _engine: string = 'chrome';
  /** Set for sessions created via `remote` — no local driver process/filesystem ever backs these. */
  private _isRemote = false;
  /** Active emulation overrides, re-applied to new top-level contexts. */
  private _emulation: EmulateOptions = {};

  /** Mutable browser-level defaults. Use setDefaultTimeout() / setDefaultNavigationTimeout() to change. */
  private defaults = {
    timeout: DEFAULT_ELEMENT_TIMEOUT_MS,
    navigationTimeout: DEFAULT_NAVIGATION_TIMEOUT_MS,
  };

  private constructor(private driver: Driver) {
    this.keyboard = new Keyboard(this.driver);
    this.mouse = new Mouse(this.driver);
  }

  /**
   * Set the default timeout (ms) used by all element actions, waits, and assertions
   * when no per-call `{ timeout }` option is provided. Default: 5000.
   */
  setDefaultTimeout(ms: number): void {
    this.defaults.timeout = ms;
  }

  /**
   * Set the default navigation timeout (ms) used by navigateTo and load-state waits.
   * Default: 30000.
   */
  setDefaultNavigationTimeout(ms: number): void {
    this.defaults.navigationTimeout = ms;
  }

  /** Returns the current default timeout. Used as a live getter passed to ElementHandle / expectSelector. */
  private getDefaultTimeout = (): number => this.defaults.timeout;

  private hasBrowserInitScripts = (): boolean => this._browserInitScriptIds.size > 0;

  private hasDefaultNavigationInitScripts = (): boolean =>
    this._defaultContext?._hasInitScriptsForNavigation() ?? this.hasBrowserInitScripts();

  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    // Normalize first: callers may be JavaScript or JSON-driven, so reject
    // malformed/mixed targets before touching disk or starting a driver.
    const target = resolveLaunchTarget(options as unknown as Record<string, unknown>);

    if (target.kind === 'remote') {
      return await Browser.launchRemote(target, options as RemoteTargetLaunchOptions);
    }

    const isElectron = target.kind === 'electron';
    const name = target.browserName;
    const isChromeFamily = name === 'chrome' || name === 'chromium';

    if (target.kind === 'browser' && options.mobileEmulation && !isChromeFamily) {
      throw new Error(
        `mobileEmulation is only supported on Chrome/Chromium (got "${name}"). ` +
          `Firefox does not expose a device-emulation API equivalent to goog:chromeOptions.mobileEmulation.`
      );
    }

    const bidiRequested = target.bidiRequested;

    // Handle headless mode via env var (never applied to Electron — see capabilities.ts).
    const headlessEnv = process.env.HEADLESS;
    const isHeadless = headlessEnv === 'true' || headlessEnv === '1';

    // Resolve Electron before creating session directories. A malformed or
    // missing executable must never degrade into a regular Chrome launch.
    const electronBinary =
      target.kind === 'electron'
        ? await resolveElectronAppBinaryPath(target.appBinaryPath)
        : undefined;
    if (
      options.electronService !== undefined &&
      !(options.electronService instanceof ElectronService)
    ) {
      throw new Error('electronService must be an ElectronService instance.');
    }
    if (target.kind === 'electron') {
      writeElectronDebug({
        appPath: electronBinary,
        protocol: bidiRequested ? 'bidi' : 'classic',
        platform: `${os.platform()}-${os.arch()}`,
      });
    }

    // Set up downloads directory
    const downloadsDir =
      options.downloadsDir ??
      path.join(
        os.tmpdir(),
        'craftdriver-downloads',
        `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
    await fs.mkdir(downloadsDir, { recursive: true });

    // The binary that becomes goog:chromeOptions.binary / moz:firefoxOptions.binary.
    // For Electron it's the app executable (explicit, required). For browsers
    // it's the optional custom-binary resolution chain — but see
    // resolveBrowserBinaryPath's doc: some of the env vars in that chain aren't
    // craftdriver-opt-in, they're ambient conventions other tools may have set.
    // Safari has no custom-binary concept: browserPath/args are rejected
    // upstream in resolveLaunchTarget(), so target.browserPath is
    // always undefined here. Skip resolveBrowserBinaryPath() for Safari
    // entirely rather than calling it with 'firefox' as a stand-in — it would
    // still probe FIREFOX_BIN/SE_FIREFOX_PATH-style env vars that have
    // nothing to do with Safari, which is misleading even though it happens
    // to return undefined/harmless today.
    const browserBinary =
      target.kind === 'electron'
        ? electronBinary
        : name === 'safari'
          ? undefined
          : resolveBrowserBinaryPath(isChromeFamily ? 'chrome' : 'firefox', target.browserPath);

    // Main-process access (opt-in): launch the Electron app with a Node inspector
    // on a free local port. chromedriver forwards this arg to the app, enabling
    // its main-process inspector; browser.electron connects below for log capture
    // and retries on first executeMain() if that eager connection was too early.
    let electronInspect: { host: string; port: number } | undefined;
    let launchArgs = target.args;
    if (target.kind === 'electron' && target.mainProcess) {
      const host = '127.0.0.1';
      const port = await findFreePort();
      electronInspect = { host, port };
      launchArgs = [...(target.args ?? []), `--inspect=${host}:${port}`];
    }

    const caps = buildLaunchCapabilities({
      browserName: name,
      isElectron,
      isHeadless,
      bidiRequested,
      browserBinary,
      downloadsDir,
      args: launchArgs,
      mobileEmulation:
        target.kind === 'browser' && isChromeFamily && options.mobileEmulation
          ? resolveMobileEmulationConfig(options.mobileEmulation)
          : undefined,
    });

    const builder = new Builder().forBrowser(name);
    let driverService: ChromeService | FirefoxService | SafariService;
    if (target.kind === 'electron') {
      driverService =
        options.electronService ??
        new ElectronService({
          chromedriverPath: target.chromedriverPath,
          version: target.version,
          // Lets the driver resolver read the Electron version from a packaged app's
          // bundle when no explicit version/driver is given (production apps).
          appBinaryPath: electronBinary,
        });
      builder.setChromeService(driverService);
    } else if (isChromeFamily) {
      // Only thread browserPath into a default ChromeService — a
      // caller-supplied one is expected to already pin what it needs (same
      // reasoning as explicit config always winning over auto-detection).
      driverService = options.chromeService ?? new ChromeService({ browserPath: browserBinary });
      builder.setChromeService(driverService);
    } else if (name === 'safari') {
      // No browserPath threading (Safari has none — see the browserBinary
      // resolution above) and no headless/args to pass through; SafariService
      // resolves its own driver binary (never auto-downloaded).
      driverService = options.safariService ?? new SafariService();
      builder.setSafariService(driverService);
    } else {
      driverService = options.firefoxService ?? new FirefoxService();
      builder.setFirefoxService(driverService as FirefoxService);
    }
    builder.withCapabilities(caps);
    let driver;
    if (target.kind === 'electron') {
      try {
        driver = await builder.build();
      } catch (err) {
        // Turn an opaque "Chrome instance exited" into a diagnosed, actionable
        // error (macOS signing/Gatekeeper, Linux sandbox) with the chromedriver
        // output tail attached. Non-app-exit failures pass through unchanged.
        throw diagnoseElectronLaunchFailure(err, {
          appBinaryPath: electronBinary!,
          args: target.args,
          driverOutputTail: (driverService as ElectronService).getOutputTail?.(),
        });
      }
    } else {
      driver = await builder.build();
    }
    const browser = new Browser(driver);
    browser._downloadsDir = downloadsDir;
    browser._driverService = driverService;
    browser._browserName = name;
    // Local names are already the normalized `SupportedBrowserName`, so engine
    // and provider-facing name coincide here (they diverge only for remote).
    browser._engine = name;
    browser._electronInspect = electronInspect;
    browser._electronAppBinaryPath = electronBinary;

    // With main-process access enabled, open the inspector bridge now so
    // main-process console/error capture (browser.electron.mainLogs) starts at
    // launch, mirroring always-on renderer log capture. Best-effort: a disabled
    // EnableNodeCliInspectArguments fuse or an unreachable inspector must never
    // fail renderer automation — executeMain still surfaces the actionable error
    // on first use.
    if (electronInspect) {
      const remote = new ElectronRemote(electronInspect, { appBinaryPath: electronBinary });
      browser._electron = remote;
      await remote.connect().catch((err) => {
        writeElectronDebug({
          event: 'main-bridge-eager-connect-failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    try {
      // Initialize BiDi session if WebSocket URL available
      const wsUrl = (driver as any).__wsUrl;
      if (wsUrl && bidiRequested) {
        await browser.initBiDi(wsUrl);
      }

      if (options.storageState !== undefined) {
        const protocol = browser.bidiSession?.isConnected() ? 'bidi' : 'classic';
        const errorContext = { operation: 'Browser.launch', browserName: name, protocol };
        const state = await parseSessionState(options.storageState, errorContext);
        if (browser.bidiSession?.isConnected()) {
          await browser.defaultContext._loadStorageState(state, 'Browser.launch');
        } else if (!isSessionStateEmpty(state)) {
          throw new CraftdriverError(
            ErrorCode.UNSUPPORTED,
            'non-empty storageState cannot be restored at WebDriver Classic launch',
            {
              detail: storageStateDetail(errorContext, 'capability', { partialApplied: false }),
              hint: 'Enable BiDi, or launch first, navigate to the sole origin, then call browser.loadState().',
            }
          );
        }
      }
    } catch (err) {
      // The driver session (and, for Electron, the app) already exists — don't
      // leak the process if post-launch initialization fails. Tear it down,
      // then surface the original error.
      await browser.quit().catch(() => {});
      throw err;
    }

    return browser;
  }

  /** Create a remote session without local driver or filesystem setup. */
  private static async launchRemote(
    target: RemoteLaunchTarget,
    options: RemoteTargetLaunchOptions
  ): Promise<Browser> {
    const { endpoint, sessionTimeoutMs } = parseRemoteEndpoint(target.remote);

    const caps = buildRemoteCapabilities({
      browserName: target.browserName,
      bidiRequested: target.bidiRequested,
      userCapabilities: target.remote.capabilities,
    });

    const builder = new Builder()
      .forBrowser(target.browserName)
      .usingServer(endpoint, { sessionTimeoutMs })
      .withCapabilities(caps);
    const driver = await builder.build();

    const browser = new Browser(driver);
    browser._isRemote = true;
    browser._browserName = target.browserName;
    browser._engine = target.engine;

    try {
      const wsUrl = (driver as any).__wsUrl;
      if (wsUrl && target.bidiRequested) {
        await browser.initBiDi(wsUrl);
      }

      if (options.storageState !== undefined) {
        const protocol = browser.bidiSession?.isConnected() ? 'bidi' : 'classic';
        const errorContext = {
          operation: 'Browser.launch',
          browserName: target.browserName,
          protocol,
        };
        const state = await parseSessionState(options.storageState, errorContext);
        if (browser.bidiSession?.isConnected()) {
          await browser.defaultContext._loadStorageState(state, 'Browser.launch');
        } else if (!isSessionStateEmpty(state)) {
          throw new CraftdriverError(
            ErrorCode.UNSUPPORTED,
            'non-empty storageState cannot be restored at WebDriver Classic launch',
            {
              detail: storageStateDetail(errorContext, 'capability', { partialApplied: false }),
              hint: 'Enable BiDi, or launch first, navigate to the sole origin, then call browser.loadState().',
            }
          );
        }
      }
    } catch (err) {
      // POST /session already succeeded — a failure initializing the session
      // must not strand it as a paid, orphaned session on the provider. Send
      // DELETE /session (via quit()) before surfacing the original error.
      await browser.quit().catch(() => {});
      throw err;
    }

    return browser;
  }

  /**
   * Initialize BiDi WebSocket connection
   */
  private async initBiDi(wsUrl: string): Promise<void> {
    const session = new BiDiSession(this.driver);
    this.bidiSession = session;
    // Retry up to 8 times with increasing delays — Firefox may not have finished
    // binding its BiDi WebSocket yet (especially when a previous session just closed
    // on the same port, or the profile is still initialising).
    const maxAttempts = BIDI_CONNECT_MAX_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await session.connect(wsUrl, {
          // Seed the top-level-context cache from the tree connect() already
          // fetched, off the subscription connect() already armed — avoids a
          // second getTree/subscribe round trip right after this returns.
          onContextTree: (contexts) => {
            this._topLevelContextTracking = this._startTopLevelContextTracking(contexts);
          },
        });
        session.network.setInternalContextPredicate((context) =>
          this._isInternalContextId(context)
        );
        session.logs.setInternalContextPredicate((context) => this._isInternalContextId(context));
        await this._ensureTopLevelContextTracking().catch(() => {});
        return; // success
      } catch (err) {
        if (attempt < maxAttempts) {
          // Back-off: 300ms, 600ms, 900ms, 1200ms …
          await new Promise((r) => setTimeout(r, BIDI_CONNECT_BACKOFF_STEP_MS * attempt));
        } else {
          // All attempts failed; fall back to Classic-only mode. Redact the
          // WebSocket URL and any occurrence of it inside the error message —
          // some remote providers proxy webSocketUrl through query-string
          // tokens or embedded credentials, which must never reach a log.
          const redactedWsUrl = redactUrlForLog(wsUrl);
          const rawMessage = err instanceof Error ? err.message : String(err);
          const redactedMessage = rawMessage.split(wsUrl).join(redactedWsUrl);
          console.warn(
            `BiDi connection to ${redactedWsUrl} failed after retries, using Classic WebDriver only: ${redactedMessage}`
          );
          this.bidiSession = undefined;
        }
      }
    }
  }

  /**
   * Check if BiDi features are available
   */
  isBiDiEnabled(): boolean {
    return this.bidiSession?.isConnected() ?? false;
  }

  /** Require a connected BiDi session, with a stable Safari error code. */
  private requireBiDi(feature: string, chromeMessage: string): void {
    if (this.bidiSession?.isConnected()) return;
    if (this._engine === 'safari') {
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        `${feature} is not supported on Safari (no WebDriver BiDi). ` +
          'Apple does not document a WebDriver BiDi endpoint for Safari.',
        { detail: { browserName: 'safari', feature } }
      );
    }
    throw new Error(chromeMessage);
  }

  // === BiDi Feature Accessors ===

  /**
   * Network interception API (BiDi)
   * Mock, intercept, and modify network requests
   */
  get network(): NetworkInterceptor {
    if (!this._network) {
      this.requireBiDi(
        'network',
        'Network interception requires BiDi. ' +
          'BiDi negotiation may have failed at launch — check browser logs for WebSocket errors.'
      );
      this._network = this.bidiSession!.network;
    }
    return this._network;
  }

  /**
   * Console/error log monitoring (BiDi)
   */
  get logs(): LogMonitor {
    if (!this._logs) {
      this.requireBiDi(
        'logs',
        'Log monitoring requires BiDi. ' +
          'BiDi negotiation may have failed at launch — check browser logs for WebSocket errors.'
      );
      this._logs = this.bidiSession!.logs;
    }
    return this._logs;
  }

  /**
   * Session state management (cookies, localStorage)
   * Works with both BiDi and Classic WebDriver
   */
  get storage(): SessionStateManager {
    if (!this._storage) {
      this._storage = new SessionStateManager(
        this.driver,
        this.bidiSession?.isConnected() ? this.bidiSession.getConnection() : null,
        undefined,
        {
          browserName: this._browserName,
          protocol: this.bidiSession?.isConnected() ? 'bidi' : 'classic',
          runSerializedRestore: this.bidiSession?.isConnected()
            ? (task) => this.defaultContext._runSerializedRestore(task)
            : undefined,
        }
      );
    }
    return this._storage;
  }

  /**
   * Virtual clock control — freeze or advance `Date`, `setTimeout`, and
   * `setInterval` inside the page.  Requires BiDi (enabled by default).
   *
   * ```ts
   * await browser.clock.install({ time: '2026-01-01T09:00:00Z' });
   * await browser.clock.fastForward('15:01');
   * ```
   */
  get clock(): Clock {
    if (!this._clock) {
      this._clock = new Clock(this);
    }
    return this._clock;
  }

  /**
   * Accessibility audits via axe-core.
   *
   * ```ts
   * await browser.a11y.check({ disableRules: ['color-contrast'] });
   * ```
   *
   * axe-core ships as a direct dependency of craftdriver.
   */
  get a11y(): A11y {
    if (!this._a11y) {
      this._a11y = new A11y({ driver: this.driver });
    }
    return this._a11y;
  }

  /**
   * Electron **main-process** access. `browser.electron.executeMain(fn, ...args)`
   * runs `fn(electron, ...args)` in the app's main process (full `electron`
   * module), complementing the renderer automation on `Browser` itself.
   *
   * Requires launching with `electron: { mainProcess: true }`; otherwise
   * `executeMain` throws `ELECTRON_MAIN_UNAVAILABLE`.
   *
   * ```ts
   * const version = await browser.electron.executeMain((electron) => electron.app.getVersion());
   * ```
   */
  get electron(): ElectronRemote {
    if (!this._electron) {
      this._electron = new ElectronRemote(this._electronInspect, {
        appBinaryPath: this._electronAppBinaryPath,
      });
    }
    return this._electron;
  }

  /**
   * Save current session state (cookies + localStorage) to file
   */
  async saveState(path: string, options?: StorageStateOptions): Promise<SessionState> {
    return this.storage.saveState(path, options);
  }

  /**
   * Load session state from file
   */
  async loadState(source: string | SessionState): Promise<void> {
    const protocol = this.bidiSession?.isConnected() ? 'bidi' : 'classic';
    const state = await parseSessionState(source, {
      operation: 'browser.loadState',
      browserName: this._browserName,
      protocol,
    });
    // BiDi with no sessionStorage → the validated hydrator (multi-origin, no
    // active page required). Otherwise (Classic, or sessionStorage present) take
    // the active-page path, which restores a single origin matching the active
    // page and can carry sessionStorage.
    if (this.bidiSession?.isConnected() && !hasNonEmptySessionStorage(state)) {
      await this.defaultContext._loadStorageState(state, 'browser.loadState');
    } else {
      await this.storage.setState(state, 'browser.loadState');
    }
  }

  private async _runTracedAction<T>(
    name: string,
    args: unknown[] | undefined,
    selector: string | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    const actionIndex = this._tracer?.recordAction(name, args, selector);
    try {
      const result = await run();
      this._tracer?.recordActionEnd(actionIndex);
      return result;
    } catch (error) {
      this._tracer?.recordActionEnd(actionIndex, error);
      throw error;
    }
  }

  async navigateTo(url: string, opts?: { waitUntil?: LoadState }): Promise<void> {
    return this._runTracedAction('navigateTo', [url, opts], url, async () => {
      const waitUntil: LoadState = opts?.waitUntil ?? 'load';

      // Classic-first for ordinary `waitUntil: 'load'` navigations: Classic
      // already blocks until `document.readyState === 'complete'`, so the common
      // case avoids a BiDi round trip. Preload-backed sessions stay on BiDi
      // because the next operation is often a BiDi script evaluation into the new
      // document; mixing Classic navigate + immediate BiDi evaluate can race with
      // the browser clearing old execution contexts on loaded-but-settling pages.
      const needsBiDi = waitUntil !== 'load' || this.hasDefaultNavigationInitScripts();
      const context = needsBiDi ? this.bidiSession?.getContext() : undefined;
      if (context && this.bidiSession?.isConnected()) {
        const conn = this.bidiSession.getConnection();
        const bidiWait = bidiWaitFor(waitUntil);

        await conn.send('browsingContext.navigate', { context, url, wait: bidiWait });

        if (waitUntil === 'networkidle') {
          await this.bidiSession.network.waitForNetworkIdle({
            timeout: this.defaults.navigationTimeout,
          });
        }
        return;
      }

      // Classic path — default 'load', or BiDi unavailable/no context yet.
      await this.driver.navigateTo(url);
      if (waitUntil === 'networkidle') {
        // Best-effort: Classic can't track network events; give it a short settle time
        await new Promise((r) => setTimeout(r, NETWORK_IDLE_SETTLE_MS));
      }
    });
  }

  /**
   * Navigate the active page back one step in its session history.
   * Proxies to {@link Page.goBack} on {@link activePage}.
   */
  async goBack(): Promise<void> {
    return this._runTracedAction('goBack', undefined, undefined, async () => {
      const page = await this.activePage();
      await page.goBack();
    });
  }

  /**
   * Navigate the active page forward one step in its session history.
   * Proxies to {@link Page.goForward} on {@link activePage}.
   */
  async goForward(): Promise<void> {
    return this._runTracedAction('goForward', undefined, undefined, async () => {
      const page = await this.activePage();
      await page.goForward();
    });
  }

  /**
   * Reload the active page. Proxies to {@link Page.reload} on
   * {@link activePage}.
   */
  async reload(): Promise<void> {
    return this._runTracedAction('reload', undefined, undefined, async () => {
      const page = await this.activePage();
      await page.reload();
    });
  }

  /**
   * Return the full HTML serialization of the active page.
   * Proxies to {@link Page.content}.
   */
  async content(): Promise<string> {
    const page = await this.activePage();
    return page.content();
  }

  /**
   * Replace the active page contents with the given HTML.
   * Proxies to {@link Page.setContent}.
   */
  async setContent(
    html: string,
    opts?: { waitUntil?: Exclude<LoadState, 'networkidle'> }
  ): Promise<void> {
    return this._runTracedAction('setContent', [opts], undefined, async () => {
      const page = await this.activePage();
      await page.setContent(html, opts);
    });
  }

  /**
   * Resize the viewport at runtime.
   *
   * - **BiDi** path uses `browsingContext.setViewport` on the active page,
   *   which resizes the *layout* viewport without changing the OS window.
   * - **Classic** fallback uses `POST /session/{id}/window/rect`, which
   *   resizes the OS window — the inner viewport may end up a few pixels
   *   smaller than `width`/`height` because of browser chrome.
   *
   * For full mobile emulation (DPR, user-agent, touch), pass
   * `mobileEmulation` to {@link Browser.launch}; this method only changes
   * the viewport box.
   */
  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    if (size.width <= 0 || size.height <= 0) {
      throw new Error(
        `setViewportSize: width and height must be positive integers (got ${size.width}x${size.height}).`
      );
    }
    if (this.bidiSession?.isConnected()) {
      const conn = this.bidiSession.getConnection();
      const page = await this.activePage();
      await conn.send('browsingContext.setViewport', {
        context: page.id(),
        viewport: {
          width: Math.round(size.width),
          height: Math.round(size.height),
        },
      });
      return;
    }
    // Classic fallback: resize the OS window. Best-effort approximation.
    await this.driver.setWindowRect({
      width: Math.round(size.width),
      height: Math.round(size.height),
    });
  }

  /**
   * Override one or more permissions for an origin (or for every origin
   * if `origin` is omitted).
   *
   * Uses BiDi `permissions.setPermission` (W3C Permissions module).
   * Each name in `permissions` corresponds to a `PermissionDescriptor.name`,
   * for example: `'geolocation'`, `'notifications'`, `'clipboard-read'`,
   * `'clipboard-write'`, `'camera'`, `'microphone'`, `'midi'`,
   * `'background-sync'`, `'persistent-storage'`.
   *
   * @example
   * await browser.grantPermissions(['geolocation', 'notifications']);
   * await browser.grantPermissions(['clipboard-read'], { origin: 'https://example.com' });
   */
  async grantPermissions(
    permissions: string[],
    opts?: { origin?: string; state?: 'granted' | 'denied' | 'prompt' }
  ): Promise<void> {
    this.requireBiDi(
      'grantPermissions()',
      'grantPermissions() requires BiDi (enableBiDi: true). ' +
        'Permission overrides use the W3C BiDi `permissions.setPermission` command, ' +
        'which has no Classic-WebDriver equivalent.'
    );
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new Error('grantPermissions: pass a non-empty array of permission names.');
    }
    const conn = this.bidiSession!.getConnection();
    const state = opts?.state ?? 'granted';
    const origin = opts?.origin ?? (await this._currentOrigin());
    if (!origin) {
      throw new Error(
        'grantPermissions: cannot infer origin from the current page. ' +
          'Navigate to a page first, or pass `{ origin }` explicitly.'
      );
    }
    for (const name of permissions) {
      await conn.send('permissions.setPermission', {
        descriptor: { name },
        state,
        origin,
      });
    }
  }

  /**
   * Reset all permissions for an origin (or every origin) back to the
   * browser default of `'prompt'`. Convenience wrapper around
   * {@link grantPermissions} with `state: 'prompt'`.
   */
  async clearPermissions(permissions: string[], opts?: { origin?: string }): Promise<void> {
    await this.grantPermissions(permissions, { ...opts, state: 'prompt' });
  }

  /**
   * Override the geolocation reported by `navigator.geolocation`.
   *
   * Uses BiDi `emulation.setGeolocationOverride` (W3C BiDi
   * `emulation` module). Pass `null` to clear the override and return
   * to the real device location.
   *
   * @example
   * await browser.setGeolocation({ latitude: 51.5074, longitude: -0.1278 });
   * await browser.setGeolocation(null); // clear
   */
  async setGeolocation(
    coords: { latitude: number; longitude: number; accuracy?: number } | null
  ): Promise<void> {
    this.requireBiDi(
      'setGeolocation()',
      'setGeolocation() requires BiDi (enableBiDi: true). ' +
        'Geolocation overrides use the W3C BiDi `emulation.setGeolocationOverride` ' +
        'command, which has no Classic-WebDriver equivalent.'
    );
    const conn = this.bidiSession!.getConnection();
    // Apply across all top-level contexts in the default user context.
    const tree = await conn.send<{ contexts: Array<{ context: string; parent?: string | null }> }>(
      'browsingContext.getTree',
      { maxDepth: 0 }
    );
    const tops = (tree.contexts ?? []).filter((c) => !c.parent);
    const contexts = tops.map((c) => c.context);
    const params: Record<string, unknown> = { contexts };
    if (coords === null) {
      params.coordinates = null;
    } else {
      if (
        typeof coords.latitude !== 'number' ||
        typeof coords.longitude !== 'number' ||
        coords.latitude < -90 ||
        coords.latitude > 90 ||
        coords.longitude < -180 ||
        coords.longitude > 180
      ) {
        throw new Error(
          `setGeolocation: invalid coordinates ${JSON.stringify(coords)}. ` +
            'latitude must be in [-90, 90] and longitude in [-180, 180].'
        );
      }
      params.coordinates = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy ?? 1,
      };
    }
    await conn.send('emulation.setGeolocationOverride', params);
  }

  /**
   * Override what the page sees from `matchMedia`, `navigator.language`,
   * `Intl.*`, and the network stack.
   *
   * Pass `null` for any field to clear that override; pass `{}` for a no-op.
   * Settings persist across navigations and are re-applied to new top-level
   * pages opened in the same session.
   *
   * | Field | Transport | Cross-browser |
   * |---|---|---|
   * | `locale` | BiDi `emulation.setLocaleOverride` | yes |
   * | `timezoneId` | BiDi `emulation.setTimezoneOverride` | yes |
   * | `colorScheme` / `reducedMotion` / `forcedColors` | CDP `Emulation.setEmulatedMedia` | Chromium only |
   * | `offline` | CDP `Network.emulateNetworkConditions` | Chromium only |
   *
   * Throws with a clear message if a Chromium-only field is requested on
   * Firefox, or if BiDi negotiation failed at launch.
   *
   * @example
   * ```ts
   * // Dark mode + German formatting + Berlin time
   * await browser.emulate({
   *   colorScheme: 'dark',
   *   locale: 'de-DE',
   *   timezoneId: 'Europe/Berlin',
   * });
   *
   * // Offline PWA UI
   * await browser.emulate({ offline: true });
   * await browser.click('#refresh');
   *
   * // Clear a single override
   * await browser.emulate({ locale: null });
   * ```
   */
  async emulate(options: EmulateOptions): Promise<void> {
    if (!options || Object.keys(options).length === 0) return;

    this.requireBiDi(
      'emulate()',
      'emulate() requires BiDi (enableBiDi: true). ' +
        'Emulation overrides use the W3C BiDi `emulation.*` commands ' +
        '(and the BiDi+CDP bridge for media features and offline), ' +
        'which have no Classic-WebDriver equivalent.'
    );

    // Validate Chromium-only fields up front so we fail before mutating state.
    const chromiumOnly = ['colorScheme', 'reducedMotion', 'forcedColors', 'offline'] as const;
    const isFirefox = this._engine === 'firefox';
    if (isFirefox) {
      for (const k of chromiumOnly) {
        if (k in options) {
          throw new Error(
            `emulate({ ${k} }) is not supported on Firefox yet. ` +
              'CSS media-feature and offline overrides currently require the ' +
              'BiDi+CDP bridge, which only Chromium exposes. ' +
              '`locale` and `timezoneId` work on Firefox.'
          );
        }
      }
    }

    const conn = this.bidiSession!.getConnection();
    const tree = await conn.send<{ contexts: Array<{ context: string; parent?: string | null }> }>(
      'browsingContext.getTree',
      { maxDepth: 0 }
    );
    const contexts = (tree.contexts ?? []).filter((c) => !c.parent).map((c) => c.context);

    // Merge the new options into the persisted state so subsequent pages inherit.
    this._emulation = { ...this._emulation, ...options };

    // --- locale (BiDi) ---
    if ('locale' in options) {
      await conn.send('emulation.setLocaleOverride', {
        contexts,
        locale: options.locale ?? null,
      });
    }

    // --- timezoneId (BiDi) ---
    if ('timezoneId' in options) {
      await conn.send('emulation.setTimezoneOverride', {
        contexts,
        timezone: options.timezoneId ?? null,
      });
    }

    // --- media features (CDP, Chromium only) ---
    if ('colorScheme' in options || 'reducedMotion' in options || 'forcedColors' in options) {
      const features: Array<{ name: string; value: string }> = [];
      const cs = this._emulation.colorScheme;
      const rm = this._emulation.reducedMotion;
      const fc = this._emulation.forcedColors;
      if (cs != null) features.push({ name: 'prefers-color-scheme', value: cs });
      if (rm != null) features.push({ name: 'prefers-reduced-motion', value: rm });
      if (fc != null) features.push({ name: 'forced-colors', value: fc });
      for (const context of contexts) {
        await this._cdpForContext(conn, context, 'Emulation.setEmulatedMedia', { features });
      }
    }

    // --- offline (CDP, Chromium only) ---
    if ('offline' in options) {
      const offline = options.offline === true;
      for (const context of contexts) {
        await this._cdpForContext(conn, context, 'Network.emulateNetworkConditions', {
          offline,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
      }
    }
  }

  /**
   * Send a CDP command scoped to a single top-level browsing context.
   * Uses the chromium-bidi `goog:cdp` vendor extension. Wraps protocol
   * errors so callers see an actionable message.
   */
  private async _cdpForContext(
    conn: ReturnType<NonNullable<typeof this.bidiSession>['getConnection']>,
    context: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    try {
      const sess = await conn.send<{ session: string }>('goog:cdp.getSession', { context });
      await conn.send('goog:cdp.sendCommand', {
        session: sess.session,
        method,
        params,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `emulate(): CDP command \`${method}\` failed (${msg}). ` +
          'This path requires Chromium with the BiDi+CDP bridge — confirm you are running Chrome/Chromium.'
      );
    }
  }

  /** Best-effort: derive the active page's origin (`scheme://host[:port]`). */
  private async _currentOrigin(): Promise<string | undefined> {
    try {
      const u = await this.url();
      if (!u || u === 'about:blank' || u.startsWith('data:')) return undefined;
      const parsed = new URL(u);
      return parsed.origin;
    } catch {
      return undefined;
    }
  }

  /**
   * Wait for the page to reach a given load state.
   * Call this after an action that triggers navigation (clicking a link, submitting a form).
   *
   * - `'load'` — page `load` event (default)
   * - `'domcontentloaded'` — DOMContentLoaded (faster)
   * - `'networkidle'` — load + no in-flight requests for 500 ms
   *
   * Uses BiDi events when available, falls back to polling `document.readyState`.
   */
  async waitForLoadState(
    state: Exclude<LoadState, 'none'> = 'load',
    opts?: { timeout?: number }
  ): Promise<void> {
    // Validate-or-fallback to bound timer duration (defends against resource
    // exhaustion from a hostile / buggy caller). CodeQL does not treat
    // Math.min as a sanitizer, so we use an explicit range check.
    const MAX_TIMEOUT_MS = 300_000;
    const requested = opts?.timeout;
    const timeout =
      typeof requested === 'number' && requested >= 0 && requested <= MAX_TIMEOUT_MS
        ? requested
        : this.defaults.navigationTimeout;

    if (state === 'networkidle') {
      if (this.bidiSession?.isConnected()) {
        await this.bidiSession.network.waitForNetworkIdle({ timeout });
      }
      // Classic fallback: best-effort 500ms settle
      else {
        await new Promise((r) => setTimeout(r, NETWORK_IDLE_SETTLE_MS));
      }
      return;
    }

    // --- 'load' or 'domcontentloaded' ---

    if (this.bidiSession?.isConnected()) {
      const context = this.bidiSession.getContext();

      // Check readyState first. If already satisfied, return immediately —
      // this avoids creating a timeout-Promise that could reject before the
      // caller attaches a handler (unhandled-rejection warning).
      const readyState = await this.driver.executeScript<string>('return document.readyState', []);
      const satisfied =
        state === 'load'
          ? readyState === 'complete'
          : readyState === 'interactive' || readyState === 'complete';

      if (satisfied) return;

      // Not yet in the required state — register the BiDi event listener and
      // wait. The risk window between the executeScript above and the listener
      // registration below is a single synchronous turn of the event loop
      // (no await), so in practice the event cannot be missed.
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`waitForLoadState('${state}') timed out after ${timeout}ms`));
        }, timeout);

        const handler = (params: Record<string, unknown>) => {
          if (!context || params.context === context) {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        };

        // unsubscribe is assigned synchronously before any await
        let unsubscribe =
          state === 'load'
            ? this.bidiSession!.onLoad(handler)
            : this.bidiSession!.onDomContentLoaded(handler);
      });
    }

    // Classic fallback: poll document.readyState
    const target = state === 'load' ? 'complete' : 'interactive';
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const readyState = await this.driver.executeScript<string>('return document.readyState', []);
      if (readyState === 'complete' || (target === 'interactive' && readyState === 'interactive'))
        return;
      await new Promise((r) => setTimeout(r, STATE_POLL_INTERVAL_MS));
    }
    throw new CraftdriverError(
      ErrorCode.TIMEOUT_WAITING_LOAD,
      `waitForLoadState('${state}') timed out after ${timeout}ms`,
      { detail: { state, timeout } }
    );
  }

  /** @internal Run an action behind a bounded, navigation-aware observation fence. */
  async [INTERNAL_RUN_WITH_NAVIGATION_FENCE]<T>(action: () => Promise<T>): Promise<T> {
    if (this.bidiSession?.isConnected()) {
      return this.runWithBidiNavigationFence(action);
    }
    return this.runWithClassicNavigationFence(action);
  }

  private async runWithBidiNavigationFence<T>(action: () => Promise<T>): Promise<T> {
    const session = this.bidiSession!;
    const context = (await this.activePage()).id();
    const baseline = await this.driver.executeScript<ClassicNavigationProbe>(
      CLASSIC_NAVIGATION_PROBE,
      []
    );
    let navigationId: string | null = null;
    let loadedNavigationId: string | null = null;
    let sameUrlCandidateId: string | null = null;
    let wake: (() => void) | null = null;

    const signal = (): void => {
      const current = wake;
      wake = null;
      current?.();
    };
    const waitForSignal = (timeout: number): Promise<void> =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (wake === finish) wake = null;
          resolve();
        };
        const timer = setTimeout(finish, Math.max(0, timeout));
        wake = finish;
      });

    const onStarted = (params: Record<string, unknown>): void => {
      if (params.context !== context || typeof params.navigation !== 'string') return;
      // Classic `go` can finish before its BiDi events reach this client. A
      // late start for the already-current URL must not masquerade as the
      // Enter action's navigation. Retain it until load lets us compare the
      // document identity, which also preserves real same-URL submissions.
      if (navigationId === null && params.url === baseline.url) {
        sameUrlCandidateId = params.navigation;
        signal();
        return;
      }
      // A client-side redirect starts a new navigation in the same context.
      // It supersedes the earlier id, so only the final navigation's load can
      // release the fence.
      sameUrlCandidateId = null;
      navigationId = params.navigation;
      loadedNavigationId = null;
      signal();
    };
    const onLoad = (params: Record<string, unknown>): void => {
      if (
        params.context === context &&
        typeof params.navigation === 'string' &&
        params.navigation === navigationId
      ) {
        loadedNavigationId = params.navigation;
        signal();
        return;
      }
      if (
        params.context !== context ||
        typeof params.navigation !== 'string' ||
        params.navigation !== sameUrlCandidateId
      ) {
        return;
      }

      const candidate = params.navigation;
      void this.driver
        .executeScript<ClassicNavigationProbe>(CLASSIC_NAVIGATION_PROBE, [])
        .then((probe) => {
          if (sameUrlCandidateId !== candidate || navigationId !== null) return;
          sameUrlCandidateId = null;
          if (probe.documentId !== baseline.documentId) {
            navigationId = candidate;
            loadedNavigationId = candidate;
          }
          signal();
        })
        .catch(() => {
          if (sameUrlCandidateId !== candidate || navigationId !== null) return;
          // Losing the script realm while checking is itself evidence that
          // the document changed. Conservatively accept this correlated load.
          sameUrlCandidateId = null;
          navigationId = candidate;
          loadedNavigationId = candidate;
          signal();
        });
    };

    let offStarted = (): void => {};
    let offLoad = (): void => {};

    try {
      // Listener registration is part of the guarded region too: if the
      // second subscription fails, the first one must not leak.
      offStarted = session.onNavigationStarted(onStarted);
      offLoad = session.onLoad(onLoad);
      const result = await action();
      const completedAt = Date.now();
      const detectionDeadline = completedAt + NAVIGATION_DETECTION_WINDOW_MS;
      const ceiling = completedAt + NAVIGATION_FENCE_CEILING_MS;

      while (Date.now() < ceiling) {
        if (navigationId === null) {
          if (sameUrlCandidateId !== null) {
            await waitForSignal(ceiling - Date.now());
            continue;
          }
          const remaining = detectionDeadline - Date.now();
          if (remaining <= 0) return result;
          await waitForSignal(remaining);
          continue;
        }

        if (loadedNavigationId === navigationId) {
          const loaded = navigationId;
          // Give an immediate location.href/meta-refresh redirect a chance to
          // supersede this load before its intermediate document is observed.
          await waitForSignal(Math.min(NAVIGATION_LOAD_STABILITY_MS, ceiling - Date.now()));
          if (navigationId === loaded && loadedNavigationId === loaded) return result;
          continue;
        }

        await waitForSignal(ceiling - Date.now());
      }
      return result;
    } finally {
      try {
        offStarted();
      } finally {
        try {
          offLoad();
        } finally {
          signal();
        }
      }
    }
  }

  private async runWithClassicNavigationFence<T>(action: () => Promise<T>): Promise<T> {
    const before = await this.driver.executeScript<ClassicNavigationProbe>(
      CLASSIC_NAVIGATION_PROBE,
      []
    );
    const result = await action();
    const completedAt = Date.now();
    const detectionDeadline = completedAt + NAVIGATION_DETECTION_WINDOW_MS;
    const ceiling = completedAt + NAVIGATION_FENCE_CEILING_MS;
    let navigationDetected = false;
    let stableCandidate: string | null = null;
    let stableSince = 0;

    while (Date.now() < ceiling) {
      let probe: ClassicNavigationProbe | null = null;
      try {
        probe = await this.driver.executeScript<ClassicNavigationProbe>(
          CLASSIC_NAVIGATION_PROBE,
          []
        );
      } catch {
        // Script execution commonly loses its realm while a document is
        // being replaced. That is a navigation signal, never load completion.
        navigationDetected = true;
        stableCandidate = null;
      }

      if (probe) {
        const changed = probe.url !== before.url || probe.documentId !== before.documentId;
        navigationDetected ||= changed;

        if (navigationDetected && changed && probe.readyState === 'complete') {
          const candidate = `${probe.documentId}\u0000${probe.url}`;
          if (candidate !== stableCandidate) {
            stableCandidate = candidate;
            stableSince = Date.now();
          } else if (Date.now() - stableSince >= NAVIGATION_LOAD_STABILITY_MS) {
            return result;
          }
        } else {
          stableCandidate = null;
        }
      }

      if (!navigationDetected && Date.now() >= detectionDeadline) return result;
      await new Promise((resolve) => setTimeout(resolve, STATE_POLL_INTERVAL_MS));
    }
    return result;
  }

  async url(): Promise<string> {
    return this.driver.getCurrentUrl();
  }

  async title(): Promise<string> {
    return this.driver.getTitle();
  }

  wait<T>(condition: Condition<T>, options?: WaitOptions & { message?: string }): Promise<T>;
  wait<T>(
    condition: Condition<T>,
    timeoutMs?: number,
    intervalMs?: number,
    message?: string
  ): Promise<T>;
  wait<T>(condition: Condition<T>, a?: any, b?: any, c?: any): Promise<T> {
    return (this.driver as any).wait(condition, a, b, c);
  }

  async quit(): Promise<void> {
    // Silently abort any running trace so we don't leak the timer.
    if (this._tracer?.isRunning) this._tracer.abort();
    // Whether this session had a live BiDi WebSocket. Only the Firefox+BiDi
    // combination needs the port-release pause below; capture it before close().
    const bidiWasActive = !!this.bidiSession;
    // Close the Electron main-process inspector bridge, if one was opened.
    if (this._electron) {
      await this._electron.close().catch(() => {});
    }
    // Close BiDi connection first
    if (this.bidiSession) {
      await this.bidiSession.close().catch(() => {});
    }
    this._browserInitScriptIds.clear();
    for (const off of this._topLevelContextTrackingOffs) off();
    this._topLevelContextTrackingOffs = [];
    this._topLevelContextTracking = undefined;
    this._topLevelContextUserContexts.clear();
    this._destroyedTopLevelContextIds.clear();
    this._topLevelContextCacheVersion++;
    // DELETE the WebDriver session — this tells the driver service to close the browser.
    await this.driver.quit().catch(() => {});
    // Firefox's BiDi WebSocket binds a fixed port (9222). If we kill geckodriver
    // before Firefox has released it, the next Firefox+BiDi launch can 404 while
    // connecting to the new session's socket — hence this pause. Chrome has no such
    // race: chromedriver assigns an ephemeral --remote-debugging-port=0 and our BiDi
    // URL comes from the session's own webSocketUrl, not a fixed port. So scope the
    // 500ms sleep to Firefox+BiDi; every other quit (all Chrome, Firefox w/o BiDi)
    // skips straight to stopping the driver.
    if (this._engine === 'firefox' && bidiWasActive) {
      await new Promise((r) => setTimeout(r, PORT_RELEASE_DELAY_MS));
    }
    // Stop the underlying driver service (chromedriver / geckodriver)
    // so we don't leak processes between sessions.
    if (this._driverService) {
      await this._driverService.stop().catch(() => {});
      this._driverService = undefined;
    }
  }

  // ─── Tracing ─────────────────────────────────────────────────────────────

  /**
   * Start a streaming trace session. Writes every event synchronously to
   * `<outDir>/trace.ndjson` so a thrown `expect` on the next line cannot
   * lose data. Screenshots, when enabled, land in `<outDir>/screenshots/`.
   *
   * **BiDi-only.** Call `stopTrace()` to write the closing marker and
   * close the file.
   *
   * @example
   * await browser.startTrace({ outDir: './artefacts/login' });
   * try {
   *   await browser.navigateTo('/checkout');
   *   await browser.click('#pay');
   * } finally {
   *   await browser.stopTrace();
   * }
   */
  async startTrace(opts: TraceStartOptions): Promise<void> {
    if (!this.bidiSession?.isConnected()) {
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        'startTrace() requires BiDi (enableBiDi: true). ' +
          'Tracing relies on BiDi events; Classic WebDriver does not expose them.',
        { detail: { browserName: this._browserName, feature: 'startTrace' } }
      );
    }
    if (!this._tracer) {
      this._tracer = new Tracer(this, this.bidiSession.getConnection(), this._engine, (context) =>
        this._isInternalContextId(context)
      );
    }
    await this._tracer.start(opts);
  }

  /**
   * Stop the active trace: drain in-flight screenshots, write the closing
   * `meta` line, and close the file. Pass `{ path: './trace.zip' }` to also
   * export a Vibium/Playwright-compatible archive. If your test threw and
   * never reached here, the raw file is still valid NDJSON — just without
   * the closing line.
   */
  async stopTrace(opts?: TraceStopOptions): Promise<void> {
    if (!this._tracer || !this._tracer.isRunning) {
      throw new CraftdriverError(
        ErrorCode.STATE_INVALID,
        'stopTrace(): no trace is running. Call startTrace() first.',
        { detail: { feature: 'stopTrace' } }
      );
    }
    await this._tracer.stop(opts);
  }

  /**
   * Execute JavaScript in the page and return the result.
   *
   * Accepts a function (with optional args) or a script string:
   * ```ts
   * await browser.evaluate(() => document.title);
   * await browser.evaluate((a, b) => a + b, 2, 3); // 5
   * await browser.evaluate('return document.title');
   * ```
   *
   * Uses BiDi `script.callFunction` / `script.evaluate` when available,
   * falls back to Classic WebDriver `executeScript`.
   * Only JSON-serializable return values are supported.
   */
  async evaluate<T = unknown>(
    fn: ((...args: unknown[]) => T) | string,
    ...args: unknown[]
  ): Promise<T> {
    const fnSrc = typeof fn === 'function' ? fn.toString() : fn;

    const bidiSession = this.bidiSession;
    if (bidiSession?.isConnected()) {
      const conn = bidiSession.getConnection();
      // Classic-first navigations return at readyState === 'complete', which is
      // not a barrier the BiDi side respects: an immediately following
      // { context } call can race the browser swapping the old realm for the
      // new one and throw "execution contexts cleared". The error is
      // pre-execution (script never ran, no side effects), so retry a few times,
      // re-resolving the context each attempt. In-script errors take the
      // result.type === 'exception' path below and are never retried here.
      const functionDeclaration = typeof fn === 'function' ? fnSrc : `function() { ${fnSrc} }`;
      const callArgs = typeof fn === 'function' ? args.map(serializeLocalValue) : [];

      const result = await withRealmRetry(() => {
        const context = bidiSession.getContext();
        const target: Record<string, unknown> = context ? { context } : {};
        return conn.send<ScriptEvaluateResult>('script.callFunction', {
          functionDeclaration,
          target,
          arguments: callArgs,
          awaitPromise: true,
        });
      });

      if (result.type === 'exception') {
        throw new CraftdriverError(
          ErrorCode.EVAL_THREW,
          `evaluate() threw an exception in the page: ${result.exceptionDetails?.text ?? 'unknown error'}`,
          { detail: { exception: result.exceptionDetails?.text ?? null } }
        );
      }
      if (!result.result) return undefined as T;
      return unwrapRemoteValue(result.result) as T;
    }

    // Classic fallback
    if (typeof fn === 'function') {
      return this.driver.executeScript<T>(
        `return (${fnSrc}).apply(null, Array.from(arguments))`,
        args
      );
    }
    return this.driver.executeScript<T>(fn, args);
  }

  /**
   * Execute an internal, JSON-safe script through Classic WebDriver.
   *
   * @internal Agent surfaces use this for bounded DOM probes whose first BiDi
   * realm lookup after navigation is disproportionately expensive. Public
   * callers should use {@link evaluate}, which preserves the documented BiDi
   * serialization and exception semantics.
   */
  async [INTERNAL_EVALUATE_CLASSIC]<T = unknown>(
    script: string,
    ...args: unknown[]
  ): Promise<T> {
    return this.driver.executeScript<T>(script, args);
  }

  /**
   * Register a script that runs before any page script on every navigation.
   * Returns a handle with a `remove()` method to unregister it.
   *
   * Requires BiDi (enabled by default). Throws a clear error otherwise.
   *
   * ```ts
   * const script = await browser.addInitScript(() => {
   *   window.__flags = { darkMode: true };
   * });
   * await browser.navigateTo(url); // __flags is available
   * await script.remove();         // unregister
   * ```
   */
  async addInitScript(
    fnOrSrc: ((...args: unknown[]) => unknown) | string
  ): Promise<{ remove(): Promise<void> }> {
    this.requireBiDi(
      'addInitScript()',
      'addInitScript() requires BiDi. ' +
        'BiDi is enabled by default — check that your browser supports it.'
    );

    const conn = this.bidiSession!.getConnection();
    const fnSrc = typeof fnOrSrc === 'function' ? fnOrSrc.toString() : `() => { ${fnOrSrc} }`;

    const result = await conn.send<{ script: string }>('script.addPreloadScript', {
      functionDeclaration: publicPageInitScript(fnSrc),
    });

    const scriptId = result.script;
    this._browserInitScriptIds.add(scriptId);
    return {
      remove: async () => {
        if (!this._browserInitScriptIds.has(scriptId)) return;
        await conn.send('script.removePreloadScript', { script: scriptId });
        this._browserInitScriptIds.delete(scriptId);
      },
    };
  }

  /**
   * Wait for the first network request matching a URL glob or predicate.
   * Register **before** the action that triggers the request.
   */
  waitForRequest(
    pattern: string | ((req: InterceptedRequest) => boolean),
    opts?: { timeout?: number }
  ): Promise<InterceptedRequest> {
    this.requireBiDi(
      'waitForRequest()',
      'waitForRequest() requires BiDi. BiDi is enabled by default — check your browser supports it.'
    );
    return this.network.waitForRequest(pattern, {
      timeout: opts?.timeout ?? this.defaults.navigationTimeout,
    });
  }

  /**
   * Wait for the first completed response matching a URL glob or predicate.
   * Register **before** the action that triggers the request.
   *
   * @example
   * ```ts
   * const [res] = await Promise.all([
   *   browser.waitForResponse('/api/users'),
   *   browser.click('#load-btn'),
   * ]);
   * expect(res.status).toBe(200);
   * ```
   */
  waitForResponse(
    pattern: string | ((res: InterceptedResponse) => boolean),
    opts?: { timeout?: number }
  ): Promise<InterceptedResponse> {
    this.requireBiDi(
      'waitForResponse()',
      'waitForResponse() requires BiDi. BiDi is enabled by default \u2014 check your browser supports it.'
    );
    return this.network.waitForResponse(pattern, {
      timeout: opts?.timeout ?? this.defaults.navigationTimeout,
    });
  }

  /**
   * Subscribe to **every** network request or response. Returns an
   * `off()` function that unsubscribes the listener.
   *
   * Use this for fire-and-forget logging, tracing, or assertion-on-every
   * patterns where you do not know in advance which request you care
   * about. For one-shot waits prefer {@link waitForRequest} /
   * {@link waitForResponse}.
   *
   * @example
   * ```ts
   * const off = browser.on('response', (res) => {
   *   console.log(res.status, res.url);
   * });
   * await browser.click('#load');
   * off();
   * ```
   */
  on(event: 'request', listener: (req: InterceptedRequest) => void): () => void;
  on(event: 'response', listener: (res: InterceptedResponse) => void): () => void;
  on(
    event: 'request' | 'response',
    listener: ((req: InterceptedRequest) => void) | ((res: InterceptedResponse) => void)
  ): () => void {
    this.requireBiDi(
      `browser.on('${event}')`,
      `browser.on('${event}') requires BiDi (enableBiDi: true). ` +
        'Network event listeners use the W3C BiDi `network` module, which has no Classic-WebDriver equivalent.'
    );
    if (event === 'request') {
      return this.network.on('request', listener as (req: InterceptedRequest) => void);
    }
    return this.network.on('response', listener as (res: InterceptedResponse) => void);
  }

  /**
   * Run `action`, then wait until a new file appears in the downloads directory.
   * Returns a `Download` handle with `path`, `suggestedFilename`, and `saveAs()`.
   *
   * @example
   * const dl = await browser.waitForDownload(() => browser.click('#download-btn'));
   * expect(dl.suggestedFilename).toBe('report.csv');
   * await dl.saveAs('/tmp/report.csv');
   */
  async waitForDownload(
    action: () => Promise<void> | void,
    opts?: { timeout?: number }
  ): Promise<Download> {
    if (this._engine === 'safari') {
      // safaridriver exposes no download-directory configuration craftdriver
      // can manage, so a browser download never lands in _downloadsDir — it
      // goes to the user's ~/Downloads. Without this guard, waitForDownload()
      // would watch an empty temp dir and fail with an opaque timeout instead
      // of a clear "unsupported" error. Craftdriver-managed downloads are out
      // of scope for Safari.
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        'waitForDownload() is not supported on Safari: safaridriver exposes no ' +
          'download-directory configuration craftdriver can manage, so downloads ' +
          'cannot be routed to or observed in a controlled directory.',
        { detail: { browserName: 'safari', feature: 'waitForDownload()' } }
      );
    }
    if (this._isRemote) {
      // Same shape as the Safari guard above: a remote session has no
      // client-visible downloads directory (downloadsDir is rejected at
      // remote launch time), so a download never lands anywhere craftdriver
      // can watch. Fail immediately with a clear error instead of an opaque
      // timeout on an empty/nonexistent directory.
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        'waitForDownload() is not supported on remote sessions: remote sessions have no ' +
          "client-visible downloads directory; use your provider's download API if one exists.",
        { detail: { feature: 'waitForDownload()' } }
      );
    }
    const dir = this._downloadsDir;
    if (!dir) {
      throw new Error(
        'waitForDownload() requires a downloads directory. Browser was not launched correctly.'
      );
    }
    const timeout = opts?.timeout ?? this.defaults.navigationTimeout;

    // Snapshot existing files before action
    const before = new Set(fsSync.readdirSync(dir));

    await action();

    // Poll for a new non-.crdownload file
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const after = fsSync.readdirSync(dir);
      const newFiles = after.filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
      if (newFiles.length > 0) {
        const filename = newFiles[0];
        const filePath = path.join(dir, filename);
        return {
          path: filePath,
          suggestedFilename: filename,
          saveAs: async (targetPath: string) => {
            await fs.copyFile(filePath, targetPath);
          },
        };
      }
      await new Promise((r) => setTimeout(r, STATE_POLL_INTERVAL_MS));
    }

    throw new Error(`waitForDownload() timed out after ${timeout}ms — no file appeared in ${dir}`);
  }

  // ─── Dialog handling ──────────────────────────────────────────────────────

  /**
   * Register a handler called every time a browser dialog opens (alert / confirm / prompt).
   * The handler receives a `Dialog` object with `accept()` and `dismiss()` methods.
   * Returns an unsubscribe function — call it to stop listening.
   *
   * If no handler is registered, dialogs are auto-dismissed so they don't hang the test.
   *
   * @example
   * const off = browser.onDialog(async dialog => {
   *   expect(dialog.message).toBe('Are you sure?');
   *   await dialog.accept();
   * });
   * await browser.click('#confirm-btn');
   * off(); // stop listening
   */
  onDialog(handler: (dialog: Dialog) => Promise<void> | void): () => void {
    if (this.bidiSession?.isConnected()) {
      return this.bidiSession.onDialog(async (params) => {
        const dialog = this._buildDialog(params);
        await handler(dialog);
      });
    }
    if (this._engine === 'safari') {
      // Safari is Classic-only and has no WebDriver BiDi push events, so there
      // is no event-driven way to detect a dialog opening. A polling fallback
      // (repeatedly calling getAlertText()/driver "no such alert" errors to
      // detect a dialog) was considered, but would need to be *proven*
      // reliable on real Safari before shipping. Rather than silently no-op (today's
      // Classic behavior for other browsers) or let waitForDialog() hang
      // until its own generic timeout — which would look like a missed
      // dialog rather than "this API isn't supported here" — fail
      // immediately with a clear, actionable error. Revisit if a polling
      // form is later measured reliable on real Safari.
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        'onDialog() / waitForDialog() are not supported on Safari: Safari has no ' +
          'WebDriver BiDi, so there is no push-event mechanism for dialogs. ' +
          'Use the imperative dialog API instead — acceptDialog(), dismissDialog(), ' +
          'getDialogMessage() — which work in Classic mode.',
        { detail: { browserName: 'safari', feature: 'onDialog()' } }
      );
    }
    // Classic (non-Safari): no push events — callers must use the imperative API below
    // Return a no-op unsubscribe
    return () => {
      /* no-op */
    };
  }

  /**
   * Accept the currently open dialog (OK / confirm).
   * For prompt dialogs, pass `text` to type into the input first.
   * Uses BiDi when available, Classic WebDriver otherwise.
   */
  async acceptDialog(text?: string): Promise<void> {
    return this._runTracedAction(
      'acceptDialog',
      text !== undefined ? [text] : undefined,
      undefined,
      async () => {
        if (this.bidiSession?.isConnected()) {
          await this.bidiSession.handleUserPrompt(true, text);
          return;
        }
        if (text !== undefined) await this.driver.sendAlertText(text);
        await this.driver.acceptAlert();
      }
    );
  }

  /**
   * Dismiss the currently open dialog (Cancel / close).
   * Uses BiDi when available, Classic WebDriver otherwise.
   */
  async dismissDialog(): Promise<void> {
    return this._runTracedAction('dismissDialog', undefined, undefined, async () => {
      if (this.bidiSession?.isConnected()) {
        await this.bidiSession.handleUserPrompt(false);
        return;
      }
      await this.driver.dismissAlert();
    });
  }

  /**
   * Get the message text of the currently open dialog.
   * Uses BiDi when available, Classic WebDriver otherwise.
   */
  async getDialogMessage(): Promise<string> {
    // BiDi surfaces the message in the userPromptOpened event, not via a query.
    // For the imperative (non-event) case we fall through to Classic.
    return this.driver.getAlertText();
  }

  /**
   * Wait for the next dialog (alert / confirm / prompt) to open and return it.
   * The dialog object has `accept()` and `dismiss()` methods — call one of them
   * or the page will be frozen waiting for the dialog.
   *
   * Matches Playwright's `page.waitForEvent('dialog')` pattern:
   * ```ts
   * const [, dialog] = await Promise.all([
   *   browser.click('#confirm-btn'),
   *   browser.waitForDialog(),
   * ]);
   * await dialog.accept();
   * ```
   */
  waitForDialog(opts?: { timeout?: number }): Promise<Dialog> {
    const timeout = opts?.timeout ?? this.defaults.timeout;
    return new Promise<Dialog>((resolve, reject) => {
      let tid: ReturnType<typeof setTimeout> | undefined;
      let off: () => void;
      // onDialog() throws synchronously on Safari (no BiDi push events for
      // dialogs — see onDialog()'s comment). Register the handler before
      // scheduling the timeout so that throw rejects this promise
      // immediately instead of leaving a dangling timer whose callback would
      // later reference `off` before it was ever assigned.
      try {
        off = this.onDialog((dialog) => {
          if (tid !== undefined) clearTimeout(tid);
          off();
          resolve(dialog);
        });
      } catch (err) {
        reject(err as Error);
        return;
      }

      if (timeout > 0) {
        tid = setTimeout(() => {
          off();
          reject(new Error(`waitForDialog timed out after ${timeout}ms`));
        }, timeout);
      }
    });
  }

  private _buildDialog(params: Record<string, unknown>): Dialog {
    const _type = (params.type as DialogType) ?? 'alert';
    const _message = String(params.message ?? '');
    const _defaultValue = String(params.defaultValue ?? '');

    return {
      type: () => _type,
      message: () => _message,
      defaultValue: () => _defaultValue,
      accept: async (text?: string) => {
        await this.acceptDialog(text);
      },
      dismiss: async () => {
        await this.dismissDialog();
      },
    };
  }

  // ─── Frames ───────────────────────────────────────────────────────────────

  /**
   * Return a `Frame` object scoped to the first iframe matching `selector`.
   * All element methods on the returned `Frame` are automatically targeted
   * inside that iframe's browsing context.
   *
   * @example
   * const frame = await browser.frame('#stripe-iframe');
   * await frame.fill('#card-number', '4242 4242 4242 4242');
   */
  async frame(selector: string | By, opts?: { timeout?: number }): Promise<Frame> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementLocated(by), {
      timeout: opts?.timeout ?? this.defaults.timeout,
    });
    const frameElementId = el.getId();

    // Attempt to find the BiDi context id for this iframe
    let bidiContextId: string | undefined;
    if (this.bidiSession?.isConnected()) {
      const conn = this.bidiSession.getConnection();
      const topContextId = this.bidiSession.getContext();
      if (topContextId) {
        try {
          const tree = await conn.send<{ contexts: BidiContextInfo[] }>('browsingContext.getTree', {
            root: topContextId,
          });
          // The BiDi context for the iframe has the top-level context as ancestor.
          // We find the first child context (iframes appear as children).
          const iframeSrc = await el.getAttribute('src');
          bidiContextId = findIframeContext(tree.contexts[0], iframeSrc);
        } catch {
          // BiDi tree not available — fall back to Classic
        }
      }
      return new Frame(this.driver, frameElementId, this.getDefaultTimeout, {
        bidiContextId,
        conn,
      });
    }

    return new Frame(this.driver, frameElementId, this.getDefaultTimeout);
  }

  /**
   * Return `Frame` objects for all iframes on the current page.
   */
  async frames(opts?: { timeout?: number }): Promise<Frame[]> {
    const iframes = await this.driver.findElements(By.css('iframe'));
    const result: Frame[] = [];
    const conn = this.bidiSession?.isConnected() ? this.bidiSession.getConnection() : undefined;
    const topContextId = conn ? this.bidiSession!.getContext() : undefined;

    let tree: { contexts: BidiContextInfo[] } | undefined;
    if (conn && topContextId) {
      try {
        tree = await conn.send<{ contexts: BidiContextInfo[] }>('browsingContext.getTree', {
          root: topContextId,
        });
      } catch {
        tree = undefined;
      }
    }

    for (const iframe of iframes) {
      let bidiContextId: string | undefined;
      if (tree) {
        const src = await iframe.getAttribute('src');
        bidiContextId = findIframeContext(tree.contexts[0], src);
      }
      result.push(
        new Frame(
          this.driver,
          iframe.getId(),
          this.getDefaultTimeout,
          conn ? { bidiContextId, conn } : undefined
        )
      );
    }
    return result;
  }

  // ─── Pages (top-level browsing contexts: tabs & popups) ──────────────────

  /**
   * Return `Page` objects for all open top-level browsing contexts
   * (tabs and popup windows).
   */
  async pages(): Promise<Page[]> {
    if (this.bidiSession?.isConnected()) {
      const conn = this.bidiSession.getConnection();
      const tree = await conn.send<{ contexts: BidiContextInfo[] }>('browsingContext.getTree', {
        maxDepth: 0,
      });
      const pages: Page[] = [];
      for (const ctx of tree.contexts ?? []) {
        const owner = this._wrapContext(ctx.userContext ?? 'default');
        if (await owner._isInternalPageContext(ctx.context)) continue;
        pages.push(new Page(this.driver, ctx.context, this.getDefaultTimeout, conn, owner));
      }
      return pages;
    }

    // Classic fallback: use window handles
    const handles = await this.driver.getWindowHandles();
    const pages: Page[] = [];
    for (const handle of handles) {
      pages.push(new Page(this.driver, handle, this.getDefaultTimeout));
    }
    return pages;
  }

  /**
   * Open a new top-level browsing context (a tab or a window).
   *
   * Maps to BiDi `browsingContext.create`. **BiDi-only** — throws in Classic
   * mode because WebDriver Classic has no spec-level command for creating
   * top-level browsing contexts.
   *
   * @example
   * const page = await browser.openPage({ url: 'https://example.com', type: 'tab' });
   * await page.waitForLoadState();
   */
  async openPage(opts?: { url?: string; type?: 'tab' | 'window' }): Promise<Page> {
    this.requireBiDi(
      'openPage()',
      'openPage() requires BiDi (enableBiDi: true). ' +
        'WebDriver Classic cannot create top-level browsing contexts.'
    );
    const conn = this.bidiSession!.getConnection();
    const created = await conn.send<{ context: string }>('browsingContext.create', {
      type: opts?.type ?? 'tab',
    });
    const page = new Page(
      this.driver,
      created.context,
      this.getDefaultTimeout,
      conn,
      this.defaultContext
    );
    if (opts?.url) {
      await page.navigateTo(opts.url);
    }
    return page;
  }

  /**
   * Wait for a top-level page and return it, in one of two modes:
   *
   * - **New page from an action** — pass a function; resolves with the page the
   *   action opens (a tab or popup).
   *   ```ts
   *   const popup = await browser.waitForPage(() => browser.click('#open-popup'));
   *   ```
   * - **An existing/appearing page by url or title** — pass a matcher; resolves with
   *   the first top-level page whose url/title matches (string = substring, RegExp =
   *   test; both fields must match when given). Ideal for a **splash → main** Electron
   *   app, where the real window appears on the app's own schedule:
   *   ```ts
   *   const main = await browser.waitForPage({ title: /Example App/ });
   *   await main.find(By.testId('app-title')).expect().toBeVisible();
   *   ```
   *   In Classic mode the matched window also becomes the current one, so
   *   `browser.find(...)` targets it too.
   */
  waitForPage(action: () => Promise<void>, opts?: { timeout?: number }): Promise<Page>;
  waitForPage(matcher: PageMatcher, opts?: { timeout?: number }): Promise<Page>;
  async waitForPage(
    actionOrMatcher: (() => Promise<void>) | PageMatcher,
    opts?: { timeout?: number }
  ): Promise<Page> {
    if (typeof actionOrMatcher !== 'function') {
      return this._waitForMatchingPage(actionOrMatcher, opts);
    }
    const action = actionOrMatcher;
    const timeout = opts?.timeout ?? this.defaults.navigationTimeout;

    if (this.bidiSession?.isConnected()) {
      const conn = this.bidiSession.getConnection();

      // `browsingContext.contextCreated` is already subscribed session-wide by
      // `BiDiSession.connect()` (which must have run for `isConnected()` to be
      // true), so no per-call `subscribe()` round trip is needed here.
      return new Promise<Page>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          off();
          reject(new Error(`waitForPage() timed out after ${timeout}ms`));
        }, timeout);

        const off = conn.on('browsingContext.contextCreated', (params: Record<string, unknown>) => {
          // Only top-level contexts have no parent
          if (!params.parent) {
            const id = params.context as string;
            const owner = this._wrapContext(
              (params.userContext as string | undefined) ?? 'default'
            );
            void owner
              ._isInternalPageContext(id)
              .then((internal) => {
                if (internal || settled) return;
                settled = true;
                clearTimeout(timer);
                off();
                resolve(new Page(this.driver, id, this.getDefaultTimeout, conn, owner));
              })
              .catch((err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                off();
                reject(err);
              });
          }
        });

        action().catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          off();
          reject(err);
        });
      });
    }

    // Classic fallback: snapshot existing handles, run action, poll for new one
    const before = new Set(await this.driver.getWindowHandles());
    await action();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const after = await this.driver.getWindowHandles();
      const newHandles = after.filter((h) => !before.has(h));
      if (newHandles.length > 0) {
        const handle = newHandles[0];
        return new Page(this.driver, handle, this.getDefaultTimeout);
      }
      await new Promise((r) => setTimeout(r, STATE_POLL_INTERVAL_MS));
    }
    throw new Error(`waitForPage() timed out after ${timeout}ms — no new tab or popup appeared`);
  }

  /** Poll open top-level pages until one matches `matcher`; see {@link waitForPage}. */
  private async _waitForMatchingPage(
    matcher: PageMatcher,
    opts?: { timeout?: number }
  ): Promise<Page> {
    if (matcher.url === undefined && matcher.title === undefined) {
      throw new Error('waitForPage(matcher): provide at least one of { url, title }.');
    }
    const timeout = opts?.timeout ?? this.defaults.navigationTimeout;
    const deadline = Date.now() + timeout;
    const seen = new Set<string>();
    for (;;) {
      for (const page of await this.pages()) {
        try {
          if (await this._pageMatches(page, matcher, seen)) {
            // Classic: make the matched window current so browser.find(...) targets
            // it too (BiDi drives through the returned Page's own context).
            if (!this.bidiSession?.isConnected()) {
              await this.driver.switchToWindow(page.id()).catch(() => {});
            }
            return page;
          }
        } catch (err) {
          // A window that closed mid-check (e.g. the splash) — skip it, keep looking.
          if (!isNoSuchWindowError(err)) throw err;
        }
      }
      if (Date.now() >= deadline) {
        const label = [
          matcher.title !== undefined ? `title ${String(matcher.title)}` : undefined,
          matcher.url !== undefined ? `url ${String(matcher.url)}` : undefined,
        ]
          .filter(Boolean)
          .join(' and ');
        throw new Error(
          `waitForPage(matcher) timed out after ${timeout}ms — no window matched ${label}. ` +
            `Saw: ${[...seen].join(' | ') || '(no readable windows)'}.`
        );
      }
      await new Promise((r) => setTimeout(r, STATE_POLL_INTERVAL_MS));
    }
  }

  private async _pageMatches(
    page: Page,
    matcher: PageMatcher,
    seen: Set<string>
  ): Promise<boolean> {
    const url = matcher.url !== undefined ? await page.url() : undefined;
    const title = matcher.title !== undefined ? await page.title() : undefined;
    seen.add([title !== undefined ? `"${title}"` : '', url ?? ''].filter(Boolean).join(' '));
    return matchPageFields({ url, title }, matcher);
  }

  // ─── User contexts (isolated profiles, BiDi-only) ────────────────────────

  /**
   * Create a new isolated user context (an "incognito profile"). Each
   * context has its own cookies, localStorage, and IndexedDB.
   *
   * Maps to BiDi `browser.createUserContext`. **BiDi-only** — throws in
   * Classic mode because WebDriver Classic has no equivalent.
   *
   * Optionally pre-seed the context with a previously-saved
   * `storageState` snapshot (object or path to JSON) — cookies are
   * applied immediately and localStorage entries land on first
   * navigation to each captured origin.
   *
   * @example
   * const alice = await browser.newContext();
   * const bob = await browser.newContext();
   * const aPage = await alice.newPage({ url: 'https://app.example.com/login' });
   * const bPage = await bob.newPage({ url: 'https://app.example.com/login' });
   * // logging in as Alice in aPage does not leak into bPage.
   *
   * @example
   * // Skip the login UI in every test by reusing a saved session.
   * const ctx = await browser.newContext({ storageState: '.auth/alice.json' });
   * const page = await ctx.newPage({ url: 'https://app.example.com/dashboard' });
   *
   * @example
   * // Pre-configure a context for a staging tenant: every relative URL
   * // resolves against staging, every request carries the tenant header.
   * const ctx = await browser.newContext({
   *   baseURL: 'https://staging.example.com',
   *   extraHTTPHeaders: { 'X-Tenant': 'acme' },
   * });
   * const page = await ctx.newPage({ url: '/dashboard' });  // → staging.example.com/dashboard
   */
  /**
   * Return the {@link BrowserContext} wrapper for a given BiDi user-context
   * id, constructing it on first access and caching it thereafter. Stable
   * across {@link defaultContext}, {@link newContext}, and {@link contexts}
   * so route handlers, event listeners, and init scripts always live on
   * the same instance the user holds.
   *
   * Caller must guarantee BiDi is connected (`bidiSession.isConnected()`).
   */
  private _wrapContext(
    id: string,
    config?: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }
  ): BrowserContext {
    const cached = this._contextsById.get(id);
    if (cached) return cached;
    const conn = this.bidiSession!.getConnection();
    const ctx = new BrowserContext(
      this.driver,
      conn,
      id,
      this.getDefaultTimeout,
      () => this.defaults.navigationTimeout,
      {
        getNetwork: () => this.network,
        getBrowserName: () => this._browserName,
        hasBrowserInitScripts: this.hasBrowserInitScripts,
      },
      config
    );
    this._contextsById.set(id, ctx);
    // Evict on close so long-running suites that create many contexts don't
    // accumulate dead wrappers.
    ctx.on('close', () => {
      this._contextsById.delete(id);
    });
    return ctx;
  }

  private _isInternalContextId(context: string | null | undefined): boolean {
    if (typeof context !== 'string') return false;
    for (const ctx of this._contextsById.values()) {
      if (ctx._isInternalPageId(context)) return true;
    }
    return false;
  }

  async newContext(opts?: {
    storageState?: SessionState | string;
    baseURL?: string;
    extraHTTPHeaders?: Record<string, string>;
    /**
     * Locale reported by `navigator.language`, `Intl.*`, and the
     * `Accept-Language` header. Cross-browser via BiDi
     * `emulation.setLocaleOverride`. Applies to every page in this
     * context, including pages opened later.
     */
    locale?: string;
    /**
     * IANA timezone applied to `Date` and `Intl.DateTimeFormat`.
     * Cross-browser via BiDi `emulation.setTimezoneOverride`. Applies to
     * every page in this context, including pages opened later.
     */
    timezoneId?: string;
    /**
     * Coordinates returned by `navigator.geolocation`. Cross-browser via
     * BiDi `emulation.setGeolocationOverride`. The page still needs the
     * `geolocation` permission \u2014 use {@link BrowserContext.grantPermissions}
     * once the origin is known.
     */
    geolocation?: { latitude: number; longitude: number; accuracy?: number };
  }): Promise<BrowserContext> {
    this.requireBiDi(
      'newContext()',
      'newContext() requires BiDi (enableBiDi: true). ' +
        'WebDriver Classic has no concept of user contexts.'
    );
    const conn = this.bidiSession!.getConnection();
    const created = await conn.send<{ userContext: string }>('browser.createUserContext', {});
    const ctx = this._wrapContext(created.userContext, {
      baseURL: opts?.baseURL,
      extraHTTPHeaders: opts?.extraHTTPHeaders,
    });
    try {
      if (opts?.storageState !== undefined) {
        await ctx._loadStorageState(opts.storageState, 'browser.newContext');
      }
      // Apply identity & device emulation options. Each setter is `userContexts`-scoped,
      // so future pages in this context inherit automatically.
      if (opts?.locale !== undefined) await ctx.setLocale(opts.locale);
      if (opts?.timezoneId !== undefined) await ctx.setTimezone(opts.timezoneId);
      if (opts?.geolocation !== undefined) await ctx.setGeolocation(opts.geolocation);
    } catch (err) {
      // Restore/emulation failed — tear the just-created context down so a
      // rejected newContext() never leaves an orphaned user context behind.
      await ctx.close().catch(() => {});
      throw err;
    }
    return ctx;
  }

  /**
   * Return all open user contexts, including the default one.
   *
   * Maps to BiDi `browser.getUserContexts`. **BiDi-only.**
   */
  async contexts(): Promise<BrowserContext[]> {
    this.requireBiDi(
      'contexts()',
      'contexts() requires BiDi (enableBiDi: true). ' +
        'WebDriver Classic has no concept of user contexts. ' +
        'Use browser.pages() to list tabs instead.'
    );
    const conn = this.bidiSession!.getConnection();
    const result = await conn.send<{ userContexts: Array<{ userContext: string }> }>(
      'browser.getUserContexts',
      {}
    );
    return (result.userContexts ?? []).map((uc) => this._wrapContext(uc.userContext));
  }

  /**
   * The implicit default user context the browser started in (id `'default'`).
   * Pages opened via `browser.openPage()` / `browser.waitForPage()` belong
   * to this context. **BiDi-only.**
   */
  get defaultContext(): BrowserContext {
    this.requireBiDi(
      'defaultContext',
      'defaultContext requires BiDi (enableBiDi: true). ' +
        'WebDriver Classic has no concept of user contexts.'
    );
    if (this._defaultContext) return this._defaultContext;
    this._defaultContext = this._wrapContext('default');
    return this._defaultContext;
  }

  private async _ensureTopLevelContextTracking(): Promise<void> {
    if (!this.bidiSession?.isConnected()) return;
    if (this._topLevelContextTracking) return this._topLevelContextTracking;
    this._topLevelContextTracking = this._startTopLevelContextTracking();
    return this._topLevelContextTracking;
  }

  /**
   * @param initialContexts  When provided (the normal path — passed via
   *   `BiDiSession.connect()`'s `onContextTree` callback), `contextCreated`/
   *   `contextDestroyed` are already subscribed as part of `connect()`'s
   *   merged batch and the tree is already fetched — this just registers
   *   handlers and seeds the cache from it, no extra round trip. Falls back
   *   to its own subscribe + `getTree` when called without a pre-fetched
   *   tree (defensive — e.g. if `_ensureTopLevelContextTracking()` is ever
   *   reached before `initBiDi()`'s callback has run).
   */
  private async _startTopLevelContextTracking(initialContexts?: BidiContextInfo[]): Promise<void> {
    const conn = this.bidiSession!.getConnection();

    if (!initialContexts) {
      // Defensive path only. In today's sequencing this branch is unreachable:
      // `initBiDi()` always seeds `_topLevelContextTracking` via `connect()`'s
      // `onContextTree` callback (with `initialContexts`) before `launch()`
      // returns, so no external caller can reach `_ensureTopLevelContextTracking()`
      // — and thus this arg-less path — before `connect()` has already subscribed.
      // The `subscribe()` is kept (unlike the redundant ones dropped from the
      // other context-tracking call sites) precisely because this branch's
      // contract is "connect()'s subscribe may NOT have run yet"; dropping it
      // would break that contract if a future refactor made the branch reachable.
      await conn
        .subscribe(['browsingContext.contextCreated', 'browsingContext.contextDestroyed'])
        .catch(() => {
          /* already subscribed or unsupported; fallback sync will cover us */
        });
    }

    const onCreated = (params: Record<string, unknown>) => {
      if (params.parent) return;
      const id = params.context;
      if (typeof id !== 'string') return;
      const userContext = typeof params.userContext === 'string' ? params.userContext : 'default';
      this._destroyedTopLevelContextIds.delete(id);
      const owner = this._wrapContext(userContext);
      void owner
        ._isInternalPageContext(id)
        .then((internal) => {
          if (internal || this._destroyedTopLevelContextIds.has(id)) return;
          this._topLevelContextUserContexts.set(id, userContext);
          this._topLevelContextCacheVersion++;
        })
        .catch(() => {});
    };
    const onDestroyed = (params: Record<string, unknown>) => {
      if (params.parent) return;
      if (typeof params.context === 'string') {
        this._destroyedTopLevelContextIds.add(params.context);
        this._topLevelContextUserContexts.delete(params.context);
        this._topLevelContextCacheVersion++;
      }
    };

    this._topLevelContextTrackingOffs.push(conn.on('browsingContext.contextCreated', onCreated));
    this._topLevelContextTrackingOffs.push(
      conn.on('browsingContext.contextDestroyed', onDestroyed)
    );

    if (initialContexts) {
      for (const ctx of initialContexts) {
        if (!ctx.parent) {
          this._topLevelContextUserContexts.set(ctx.context, ctx.userContext ?? 'default');
        }
      }
      this._topLevelContextCacheVersion++;
    } else {
      await this._refreshTopLevelContextCache(conn).catch(() => {});
    }
  }

  private async _refreshTopLevelContextCache(conn: BiDiConnection): Promise<void> {
    const version = this._topLevelContextCacheVersion;
    const tree = await conn.send<{ contexts: BidiContextInfo[] }>('browsingContext.getTree', {
      maxDepth: 0,
    });
    if (this._topLevelContextCacheVersion === version) {
      this._topLevelContextUserContexts.clear();
    }
    for (const ctx of tree.contexts ?? []) {
      if (!ctx.parent) {
        const owner = this._wrapContext(ctx.userContext ?? 'default');
        if (await owner._isInternalPageContext(ctx.context)) continue;
        this._topLevelContextUserContexts.set(ctx.context, ctx.userContext ?? 'default');
      }
    }
    this._topLevelContextCacheVersion++;
  }

  private _firstDefaultTopLevelContext(): string | undefined {
    for (const [id, userContext] of this._topLevelContextUserContexts) {
      if (userContext === 'default' && !this._isInternalContextId(id)) return id;
    }
    return undefined;
  }

  /**
   * Return the currently focused top-level page in `defaultContext`.
   *
   * This is the page that `browser.click()`, `browser.find()`,
   * `browser.evaluate()` and the other `Browser`-level DOM shortcuts
   * implicitly target. It **never** crosses into pages inside a
   * non-default `BrowserContext`.
   *
   * Use it to make multi-tab tests explicit:
   *
   * @example
   * const page = await browser.activePage();
   * await page.click('#submit');   // identical to browser.click('#submit')
   *
   * @example
   * const popup = await browser.openPage({ url: '/help' });
   * // browser.activePage() still returns the original page —
   * // openPage() does not steal focus.
   */
  async activePage(): Promise<Page> {
    if (this.bidiSession?.isConnected()) {
      const conn = this.bidiSession.getConnection();
      const handle = await this.driver.getCurrentWindowHandle().catch(() => '');
      await this._ensureTopLevelContextTracking();

      if (
        handle &&
        this._topLevelContextUserContexts.get(handle) === 'default' &&
        !this._isInternalContextId(handle)
      ) {
        return new Page(this.driver, handle, this.getDefaultTimeout, conn, this.defaultContext);
      }

      // Events should keep the cache warm, but a cheap top-level sync covers
      // missed startup events and direct protocol/browser changes.
      await this._refreshTopLevelContextCache(conn);
      if (
        handle &&
        this._topLevelContextUserContexts.get(handle) === 'default' &&
        !this._isInternalContextId(handle)
      ) {
        return new Page(this.driver, handle, this.getDefaultTimeout, conn, this.defaultContext);
      }

      const fallback = this._firstDefaultTopLevelContext();
      if (!fallback) {
        throw new Error('activePage(): no top-level page in the default context.');
      }
      return new Page(this.driver, fallback, this.getDefaultTimeout, conn, this.defaultContext);
    }
    // Classic mode: wrap the current window. If it was closed (e.g. a splash that
    // replaced itself), re-point to the sole remaining top-level window when there's
    // exactly one — unambiguous — and otherwise ask the caller to select explicitly,
    // rather than guessing among several or throwing an opaque "no such window".
    let handle: string | undefined;
    try {
      handle = await this.driver.getCurrentWindowHandle();
    } catch (err) {
      if (!isNoSuchWindowError(err)) throw err;
    }
    const handles = await this.driver.getWindowHandles();
    if (handle === undefined || !handles.includes(handle)) {
      if (handles.length === 0) {
        throw new Error('activePage(): all windows are closed.');
      }
      if (handles.length > 1) {
        throw new Error(
          'activePage(): the current window was closed and several windows are open. ' +
            'Select one with browser.waitForPage({ title } | { url }) or browser.pages().'
        );
      }
      handle = handles[0];
      await this.driver.switchToWindow(handle).catch(() => {});
    }
    return new Page(this.driver, handle, this.getDefaultTimeout);
  }

  /**
   * Wait for `by` to be visible, and on timeout say which failure it was.
   *
   * Shared by the action fast paths so `click`, `fill` and `clear` cannot
   * drift into reporting three different things for the same situation.
   */
  private _visibleOrDiagnosed(by: By, selector: string | By) {
    const described = selectorToString(selector) ?? String(selector);
    return (remaining: number) =>
      waitForVisibleDiagnosed(
        (t) => this.driver.wait(until.elementIsVisible(by), { timeout: t }),
        () => this.driver.findElements(by),
        described,
        remaining
      );
  }

  async click(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    return this._runTracedAction('click', undefined, selectorToString(selector), async () => {
      const by = typeof selector === 'string' ? By.css(selector) : selector;
      const timeout = opts?.timeout ?? this.defaults.timeout;
      await clickWithFastPath(
        () => this.driver.findElement(by),
        this._visibleOrDiagnosed(by, selector),
        timeout
      );
    });
  }

  async fill(selector: string | By, text: string, opts?: { timeout?: number }): Promise<void> {
    return this._runTracedAction('fill', [text], selectorToString(selector), async () => {
      const by = typeof selector === 'string' ? By.css(selector) : selector;
      const timeout = opts?.timeout ?? this.defaults.timeout;
      await fillWithFastPath(
        () => this.driver.findElement(by),
        this._visibleOrDiagnosed(by, selector),
        text,
        timeout
      );
    });
  }

  /** @internal Fill and submit through one resolved element and one key sequence. */
  async [INTERNAL_FILL_AND_SUBMIT](
    selector: string | By,
    text: string,
    opts?: { timeout?: number }
  ): Promise<void> {
    return this._runTracedAction('fill', [text], selectorToString(selector), async () => {
      const by = typeof selector === 'string' ? By.css(selector) : selector;
      const timeout = opts?.timeout ?? this.defaults.timeout;
      // Combining the text and Enter in one WebElement Send Keys command is
      // what makes this atomic for reactive controls: a zero-delay rerender
      // cannot steal focus between two protocol commands.
      await fillWithFastPath(
        () => this.driver.findElement(by),
        this._visibleOrDiagnosed(by, selector),
        `${text}${Key.Enter}`,
        timeout
      );
    });
  }

  async clear(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    return this._runTracedAction('clear', undefined, selectorToString(selector), async () => {
      const by = typeof selector === 'string' ? By.css(selector) : selector;
      const timeout = opts?.timeout ?? this.defaults.timeout;
      await clearWithFastPath(
        () => this.driver.findElement(by),
        this._visibleOrDiagnosed(by, selector),
        timeout
      );
    });
  }

  async getValue(selector: string | By, opts?: { timeout?: number }): Promise<string> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementLocated(by), {
      timeout: opts?.timeout ?? this.defaults.timeout,
    });
    const val = await el.getProperty('value');
    return String(val ?? '');
  }

  async getAttribute(
    selector: string | By,
    name: string,
    opts?: { timeout?: number }
  ): Promise<string | null> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementLocated(by), {
      timeout: opts?.timeout ?? this.defaults.timeout,
    });
    return await el.getAttribute(name);
  }

  gesture = {
    swipe: async ({
      from,
      to,
      durationMs = 300,
    }: {
      from: [number, number];
      to: [number, number];
      durationMs?: number;
    }) => {
      this.rejectTouchActionsOnLocalSafari('gesture.swipe()');
      await this.driver.performTouchSwipe(from, to, durationMs);
    },
    pinch: async ({
      center,
      scale = 0.5,
      distance = 100,
      durationMs = 250,
    }: {
      center: [number, number];
      scale?: number;
      distance?: number;
      durationMs?: number;
    }) => {
      this.rejectTouchActionsOnLocalSafari('gesture.pinch()');
      await this.driver.performTouchPinch(center, scale, distance, durationMs);
    },
  };

  /**
   * Local desktop Safari has no documented touch-pointer automation surface, so
   * fail loudly rather than let the action silently no-op. Local only: a remote
   * `safari` session may be a real iOS device with a touchscreen (BrowserStack
   * et al.), where these gestures are legitimate — forward those.
   */
  private rejectTouchActionsOnLocalSafari(feature: string): void {
    if (this._isRemote) return;
    if (this._engine !== 'safari') return;
    throw new CraftdriverError(
      ErrorCode.UNSUPPORTED,
      `${feature} sends a touch-pointer action, which local desktop Safari does not support. ` +
        'Use a remote real-device session for iPhone/iPad Safari coverage.',
      { detail: { browserName: 'safari', feature } }
    );
  }

  /**
   * Capture a screenshot of the active page (viewport by default), the
   * full scrollable document (`fullPage: true`), or an element matching
   * `selector`. Optionally write the PNG to `path`. Returns the raw PNG
   * buffer.
   *
   * Full-page capture uses BiDi `browsingContext.captureScreenshot` with
   * `origin: 'document'` and therefore requires `enableBiDi: true`
   * (the default). Viewport capture uses the same BiDi command with
   * `origin: 'viewport'` when connected and falls back to the Classic
   * screenshot command otherwise. Element capture composes auto-waiting via
   * the same resolution as `find()`.
   *
   * @example
   * const buf = await browser.screenshot();
   * await browser.screenshot({ path: 'viewport.png' });
   * await browser.screenshot({ fullPage: true, path: 'full.png' });
   * await browser.screenshot({ selector: '#chart', path: 'chart.png' });
   */
  async screenshot(opts?: {
    path?: string;
    selector?: string | By;
    fullPage?: boolean;
    timeout?: number;
  }): Promise<Buffer> {
    if (opts?.fullPage && opts?.selector !== undefined) {
      throw new Error(
        'screenshot: `fullPage` and `selector` are mutually exclusive. ' +
          'Use `selector` to capture an element, or `fullPage` to capture the whole document.'
      );
    }
    let buf: Buffer;
    if (opts?.selector !== undefined) {
      const by = typeof opts.selector === 'string' ? By.css(opts.selector) : opts.selector;
      const el = await this.driver.wait(until.elementIsVisible(by), {
        timeout: opts.timeout ?? this.defaults.timeout,
      });
      const b64 = await el.screenshotBase64();
      buf = Buffer.from(b64, 'base64');
    } else if (opts?.fullPage) {
      this.requireBiDi(
        'screenshot({ fullPage: true })',
        'screenshot({ fullPage: true }) requires BiDi (enableBiDi: true). ' +
          'Full-page screenshots use the W3C BiDi `browsingContext.captureScreenshot` ' +
          'command with `origin: "document"`, which has no Classic-WebDriver equivalent.'
      );
      const conn = this.bidiSession!.getConnection();
      const page = await this.activePage();
      const result = await conn.send<{ data: string }>('browsingContext.captureScreenshot', {
        context: page.id(),
        origin: 'document',
      });
      buf = Buffer.from(result.data, 'base64');
    } else if (this.bidiSession?.isConnected()) {
      const conn = this.bidiSession.getConnection();
      const page = await this.activePage();
      // Firefox's BiDi implementation currently includes classic scrollbars in
      // an origin:"viewport" capture, while Chromium excludes them. Keep the
      // public viewport-screenshot contract consistent by clipping Firefox to
      // the document's client area. Clip coordinates are CSS pixels relative
      // to the viewport origin, so BiDi still applies DPR when painting.
      const clip =
        this._engine === 'firefox'
          ? await page.evaluate<{ width: number; height: number }>(`
              return {
                width: document.documentElement.clientWidth,
                height: document.documentElement.clientHeight,
              };
            `)
          : undefined;
      const result = await conn.send<{ data: string }>('browsingContext.captureScreenshot', {
        context: page.id(),
        origin: 'viewport',
        ...(clip
          ? {
              clip: {
                type: 'box',
                x: 0,
                y: 0,
                width: clip.width,
                height: clip.height,
              },
            }
          : {}),
      });
      buf = Buffer.from(result.data, 'base64');
    } else {
      const b64 = await this.driver.screenshotBase64();
      buf = Buffer.from(b64, 'base64');
    }
    if (opts?.path) await fs.writeFile(opts.path, buf);
    return buf;
  }

  /**
   * Assert that a screenshot matches a baseline PNG on disk, auto-retrying
   * until it matches or `timeout` elapses. Returns the match result on success;
   * throws `VisualMismatchError` (code `VISUAL_MISMATCH`) carrying the final
   * actual and diff PNG buffers on failure.
   *
   * Baselines are managed for you, WebdriverIO-style:
   * - **Missing** (`expectedPath` doesn't exist): the screenshot is captured
   *   until it settles, written as the new baseline, and the assertion passes
   *   (`result.baseline === 'created'`). This is always on — no flag required.
   * - **Matches**: passes (`result.baseline === 'matched'`).
   * - **Differs**: throws `VisualMismatchError` — unless
   *   `CRAFTDRIVER_UPDATE_VISUAL_BASELINES=true`, in which case the baseline is
   *   overwritten with the new screenshot and the assertion passes
   *   (`result.baseline === 'updated'`). Creates and updates are reported to
   *   stderr; behaviour is identical locally and in CI.
   *
   * A baseline that is present but unreadable/corrupt stays a hard error even
   * under update mode — it is never overwritten. Comparison supports per-channel
   * RGB tolerance plus max different-pixel count and percentage; anti-aliasing
   * can optionally be ignored. `screenshot.fullPage` requires BiDi and is
   * mutually exclusive with `screenshot.selector`.
   *
   * @example
   * // First run creates 'baselines/home.png'; later runs assert against it.
   * await browser.expectScreenshot('baselines/home.png', {
   *   screenshot: { fullPage: true },
   *   maxDiffPixels: 100,
   * });
   */
  async expectScreenshot(
    expectedPath: string,
    options: ExpectScreenshotOptions = {}
  ): Promise<ScreenshotMatchResult> {
    // Parsed before the first capture so a malformed value fails fast.
    const update = shouldUpdateVisualBaselines(process.env.CRAFTDRIVER_UPDATE_VISUAL_BASELINES);
    const scope = options.screenshot;
    const capture = (remainingMs: number): Promise<Buffer> => {
      if (scope && 'selector' in scope && scope.selector !== undefined) {
        // Bound the element-visibility wait by the remaining assertion time so
        // one capture can't ignore the outer deadline. The wait still evaluates
        // visibility at least once even at 0 ms (see WebDriverWait.until), so a
        // present element is captured without extending the deadline.
        return this.screenshot({ selector: scope.selector, timeout: remainingMs });
      }
      if (scope && 'fullPage' in scope && scope.fullPage === true) {
        return this.screenshot({ fullPage: true });
      }
      return this.screenshot();
    };
    return runExpectScreenshot({
      expectedPath,
      options,
      defaultTimeout: this.defaults.timeout,
      capture,
      update,
    });
  }

  expect(): DocumentExpectApi;
  expect(selector: string | By): LocatorExpectApi;
  expect(selector?: string | By): DocumentExpectApi | LocatorExpectApi {
    if (selector === undefined) {
      return expectDocument({
        description: 'page',
        readUrl: () => this.url(),
        readTitle: () => this.title(),
        getDefaultTimeout: this.getDefaultTimeout,
      });
    }
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return expectSelector(this.driver, by, this.getDefaultTimeout);
  }

  find(selector: string | By): ElementHandle {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return new ElementHandle(this.driver, by, this.getDefaultTimeout).withBiDi(() => {
      if (!this.bidiSession?.isConnected()) return undefined;
      const contextId = this.bidiSession.getContext();
      return contextId ? { connection: this.bidiSession.getConnection(), contextId } : undefined;
    });
  }

  /**
   * Return a lazy, chainable `Locator` for the given selector.
   * Prefer `locator()` over `find()` when you need composition, filtering, or indexed access.
   */
  locator(selector: string | By): Locator {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return new Locator(this.driver, by, this.getDefaultTimeout).withBiDi(() => {
      if (!this.bidiSession?.isConnected()) return undefined;
      const contextId = this.bidiSession.getContext();
      return contextId ? { connection: this.bidiSession.getConnection(), contextId } : undefined;
    });
  }

  /**
   * Return snapshot `ElementHandle`s for all elements matching `selector` at call time.
   * Use `locator().all()` when you need filtering; use `findAll()` for the simple array case.
   */
  async findAll(selector: string | By): Promise<ElementHandle[]> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const webElements = await this.driver.findElements(by);
    return webElements.map((we) =>
      ElementHandle.fromWebElement(this.driver, we, this.getDefaultTimeout).withBiDi(() => {
        if (!this.bidiSession?.isConnected()) return undefined;
        const contextId = this.bidiSession.getContext();
        return contextId ? { connection: this.bidiSession.getConnection(), contextId } : undefined;
      })
    );
  }

  getByRole(
    role: string,
    opts?: { name?: string; exact?: boolean; includeHidden?: boolean }
  ): ElementHandle {
    return this.find(By.role(role, opts));
  }

  getByText(text: string, opts?: { exact?: boolean }): ElementHandle {
    return this.find(By.text(text, opts));
  }

  getByLabel(text: string, opts?: { exact?: boolean }): ElementHandle {
    return this.find(By.labelText(text, opts));
  }

  getByPlaceholder(text: string, opts?: { exact?: boolean }): ElementHandle {
    return this.find(By.placeholder(text, opts));
  }

  getByTestId(id: string): ElementHandle {
    return this.find(By.testId(id));
  }

  getByAltText(text: string, opts?: { exact?: boolean }): ElementHandle {
    return this.find(By.altText(text, opts));
  }

  getByTitle(text: string, opts?: { exact?: boolean }): ElementHandle {
    return this.find(By.title(text, opts));
  }

  // Keyboard controller and enum for nicer usage: browser.keyboard.press(Key.Enter)
  keyboard: Keyboard;

  // Mouse controller: browser.mouse.click(...), move, down, up, wheel, dragAndDrop
  mouse: Mouse;

  static Key = Key;

  async waitForVisible(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementIsVisible(by), {
      timeout: opts?.timeout ?? this.defaults.timeout,
    });
  }

  async waitForHidden(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementIsNotVisible(by), {
      timeout: opts?.timeout ?? this.defaults.timeout,
    });
  }

  async waitForAttached(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementExists(by), {
      timeout: opts?.timeout ?? this.defaults.timeout,
    });
  }

  async waitForDetached(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementNotExists(by), {
      timeout: opts?.timeout ?? this.defaults.timeout,
    });
  }

  /**
   * Wait for an element to reach the given state.
   *
   * Canonical wait API; the four `waitForVisible/Hidden/Attached/Detached`
   * methods are kept as one-line shortcuts.
   *
   * @example
   * await browser.waitFor('#spinner', { state: 'hidden' });
   * await browser.waitFor('#toast', { state: 'visible', timeout: 2000 });
   */
  async waitFor(
    selector: string | By,
    opts: { state: 'visible' | 'hidden' | 'attached' | 'detached'; timeout?: number }
  ): Promise<void> {
    switch (opts.state) {
      case 'visible':
        return this.waitForVisible(selector, opts);
      case 'hidden':
        return this.waitForHidden(selector, opts);
      case 'attached':
        return this.waitForAttached(selector, opts);
      case 'detached':
        return this.waitForDetached(selector, opts);
    }
  }

  actions() {
    return new ActionsBuilder(this.driver);
  }

  // Utility: pause execution for a given number of milliseconds
  async pause(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
  }
}
