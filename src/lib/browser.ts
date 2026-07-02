import { Builder } from './builder.js';
import { ChromeService } from './chrome.js';
import { FirefoxService } from './firefox.js';
import { Driver } from './driver.js';
import { By } from './by.js';
import { Condition, WaitOptions, until } from './wait.js';
import { ElementHandle } from './elementHandle.js';
import { Locator } from './locator.js';
import { expectSelector } from './expect.js';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { Keyboard } from './keyboard.js';
import { Key } from './keys.js';
import { Mouse } from './mouse.js';
import { ActionsBuilder } from './actions.js';
import { Capabilities } from './types.js';
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
import { Page } from './page.js';
import { BrowserContext } from './browserContext.js';
import { Tracer, type TraceStartOptions } from './tracing.js';
import { A11y } from './a11y.js';
import { Clock } from './clock.js';
import { CraftdriverError, ErrorCode } from './errors.js';

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
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  },
  'iPhone 14 Pro Max': {
    deviceMetrics: { width: 430, height: 932, pixelRatio: 3, mobile: true, touch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  },
  'iPhone SE': {
    deviceMetrics: { width: 375, height: 667, pixelRatio: 2, mobile: true, touch: true },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  },
  'Pixel 7': {
    deviceMetrics: { width: 412, height: 915, pixelRatio: 2.625, mobile: true, touch: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  },
  'Pixel 7 Pro': {
    deviceMetrics: { width: 412, height: 892, pixelRatio: 3.5, mobile: true, touch: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  },
  'Samsung Galaxy S23': {
    deviceMetrics: { width: 360, height: 780, pixelRatio: 3, mobile: true, touch: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  },
  'iPad Pro 11': {
    deviceMetrics: { width: 834, height: 1194, pixelRatio: 2, mobile: true, touch: true },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  },
  'iPad Mini': {
    deviceMetrics: { width: 768, height: 1024, pixelRatio: 2, mobile: true, touch: true },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  },
} as const;

export type DeviceName = keyof typeof devices;

export interface LaunchOptions {
  browserName?: 'chrome' | 'chromium' | 'firefox';
  chromeService?: ChromeService;
  firefoxService?: FirefoxService;
  /**
   * Enable WebDriver BiDi for network interception, logs, tracing, multi-tab,
   * isolated contexts, and other BiDi-only capabilities. **Defaults to
   * `true`.** Classic-equivalent commands (navigation, element interactions)
   * still prefer the fastest correct protocol per command — usually Classic,
   * since it's cheaper for the common case — rather than always routing
   * through BiDi. Set `false` only if your environment cannot negotiate a
   * BiDi WebSocket; doing so also disables every BiDi-only feature (each
   * throws a `requires BiDi (enableBiDi: true)` error if called).
   */
  enableBiDi?: boolean;
  /**
   * Start console/error log capture immediately at launch instead of lazily
   * on first `browser.logs`/`onConsole`/`onError`/`waitForConsole` access.
   * **Defaults to `false`** — log capture is lazy by default so sessions that
   * never touch `browser.logs` don't pay its subscription cost. Set `true` if
   * you need to guarantee capture of console/error output emitted between
   * `Browser.launch()` and your first `browser.logs` touch.
   */
  captureLogs?: boolean;
  /** Load session state from file on launch. BiDi is always used when this is set. */
  storageState?: string;
  /** Enable mobile device emulation (Chrome/Chromium only) */
  mobileEmulation?: MobileEmulation | DeviceName;
  /**
   * Directory where downloaded files are saved.
   * Defaults to a temporary directory unique to this browser session.
   */
  downloadsDir?: string;
}

/**
 * When to consider a navigation complete.
 * - `'load'` — page `load` event has fired (default)
 * - `'domcontentloaded'` — `DOMContentLoaded` has fired (faster, no waiting for images/fonts)
 * - `'networkidle'` — `load` + no in-flight requests for 500 ms
 * - `'none'` — do not wait; return as soon as the navigation is initiated
 */
export type LoadState = 'load' | 'domcontentloaded' | 'networkidle' | 'none';

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
      value: Object.entries(v as Record<string, unknown>).map(
        ([k, val]) => [k, serializeLocalValue(val)]
      ),
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
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': return v.value;
    case 'boolean': return v.value;
    case 'bigint': return BigInt(v.value);
    case 'number': {
      if (v.value === 'NaN') return NaN;
      if (v.value === 'Infinity') return Infinity;
      if (v.value === '-Infinity') return -Infinity;
      if (v.value === '-0') return -0;
      return v.value;
    }
    case 'array': return (v.value ?? []).map(unwrapRemoteValue);
    case 'object':
      return Object.fromEntries(
        (v.value ?? []).map(([k, val]) => [
          typeof k === 'string' ? k : String(unwrapRemoteValue(k as RemoteValue)),
          unwrapRemoteValue(val),
        ])
      );
    case 'date': return new Date(v.value);
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
function findIframeContext(
  ctx: BidiContextInfo,
  iframeSrc: string | null
): string | undefined {
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
  private _logs?: LogMonitor;
  private _tracer?: Tracer;
  private _storage?: SessionStateManager;
  private _a11y?: A11y;
  private _clock?: Clock;
  private _downloadsDir?: string;
  private _driverService?: { stop: () => Promise<void> };
  private _browserName: 'chrome' | 'chromium' | 'firefox' = 'chrome';
  /** Active emulation overrides, re-applied to new top-level contexts. */
  private _emulation: EmulateOptions = {};

  /** Mutable browser-level defaults. Use setDefaultTimeout() / setDefaultNavigationTimeout() to change. */
  private defaults = { timeout: 5000, navigationTimeout: 30000 };

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

  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const name = options.browserName ?? 'chrome';
    const isFirefox = name === 'firefox';
    const isChromeFamily = name === 'chrome' || name === 'chromium';

    if (options.mobileEmulation && !isChromeFamily) {
      throw new Error(
        `mobileEmulation is only supported on Chrome/Chromium (got "${name}"). ` +
        `Firefox does not expose a device-emulation API equivalent to goog:chromeOptions.mobileEmulation.`
      );
    }

    // Handle headless mode via env var
    const headlessEnv = process.env.HEADLESS;
    const isHeadless = headlessEnv === 'true' || headlessEnv === '1';

    // Set up downloads directory
    const downloadsDir = options.downloadsDir ?? path.join(
      os.tmpdir(), 'craftdriver-downloads', `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(downloadsDir, { recursive: true });

    let caps: Capabilities = {};

    if (isChromeFamily) {
      const chromeOptions: Record<string, unknown> = {
        args: isHeadless ? ['--headless=new'] : [],
        prefs: {
          'download.default_directory': downloadsDir,
          'download.prompt_for_download': false,
          'safebrowsing.enabled': true,
        },
      };

      // Add mobile emulation if specified
      if (options.mobileEmulation) {
        const emulation = typeof options.mobileEmulation === 'string'
          ? devices[options.mobileEmulation]
          : options.mobileEmulation;

        if ('deviceName' in emulation && emulation.deviceName) {
          // Use Chrome's built-in device name
          chromeOptions.mobileEmulation = { deviceName: emulation.deviceName };
        } else {
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

          chromeOptions.mobileEmulation = mobileConfig;
        }
      }

      caps['goog:chromeOptions'] = chromeOptions;
    } else if (isFirefox) {
      const firefoxArgs: string[] = [];
      if (isHeadless) firefoxArgs.push('-headless');
      caps['moz:firefoxOptions'] = {
        args: firefoxArgs,
        prefs: {
          'browser.download.folderList': 2,
          'browser.download.dir': downloadsDir,
          'browser.download.useDownloadDir': true,
          'browser.helperApps.neverAsk.saveToDisk':
            'application/octet-stream,application/pdf,text/plain,text/csv,application/zip',
          'pdfjs.disabled': true,
        },
      };
    }

    if (options.enableBiDi !== false) {
      // Request BiDi WebSocket URL
      caps.webSocketUrl = true;
      // Set all prompt types to 'ignore' so BiDi events fire and we can handle them
      caps.unhandledPromptBehavior = {
        alert: 'ignore',
        confirm: 'ignore',
        prompt: 'ignore',
        beforeUnload: 'ignore',
      };
    }

    const builder = new Builder().forBrowser(name);
    let driverService: ChromeService | FirefoxService;
    if (isChromeFamily) {
      driverService = options.chromeService ?? new ChromeService();
      builder.setChromeService(driverService as ChromeService);
    } else {
      driverService = options.firefoxService ?? new FirefoxService();
      builder.setFirefoxService(driverService as FirefoxService);
    }
    builder.withCapabilities(caps);
    const driver = await builder.build();
    const browser = new Browser(driver);
    browser._downloadsDir = downloadsDir;
    browser._driverService = driverService;
    browser._browserName = name;

    // Initialize BiDi session if WebSocket URL available
    const wsUrl = (driver as any).__wsUrl;
    if (wsUrl && options.enableBiDi !== false) {
      await browser.initBiDi(wsUrl);
      if (options.captureLogs && browser.bidiSession?.isConnected()) {
        // Arm log capture now instead of lazily on first browser.logs touch.
        void browser.bidiSession.logs.initialize();
      }
    }

    // Load session state if provided
    if (options.storageState) {
      await browser.loadState(options.storageState);
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
    const maxAttempts = 8;
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
        await this._ensureTopLevelContextTracking().catch(() => { });
        return; // success
      } catch (err) {
        if (attempt < maxAttempts) {
          // Back-off: 300ms, 600ms, 900ms, 1200ms …
          await new Promise((r) => setTimeout(r, 300 * attempt));
        } else {
          // All attempts failed; fall back to Classic-only mode.
          console.warn('BiDi connection failed after retries, using Classic WebDriver only:', err);
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

  // === BiDi Feature Accessors ===

  /**
   * Network interception API (BiDi)
   * Mock, intercept, and modify network requests
   */
  get network(): NetworkInterceptor {
    if (!this._network) {
      if (!this.bidiSession?.isConnected()) {
        throw new Error(
          'Network interception requires BiDi. ' +
          'BiDi negotiation may have failed at launch — check browser logs for WebSocket errors.'
        );
      }
      this._network = this.bidiSession.network;
    }
    return this._network;
  }

  /**
   * Console/error log monitoring (BiDi)
   */
  get logs(): LogMonitor {
    if (!this._logs) {
      if (!this.bidiSession?.isConnected()) {
        throw new Error(
          'Log monitoring requires BiDi. ' +
          'BiDi negotiation may have failed at launch — check browser logs for WebSocket errors.'
        );
      }
      this._logs = this.bidiSession.logs;
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
        this.bidiSession?.isConnected() ? this.bidiSession.getConnection() : null
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
   * Accessibility audits via axe-core (optional peer dependency).
   *
   * ```ts
   * await browser.a11y.check({ disableRules: ['color-contrast'] });
   * ```
   *
   * Requires `axe-core` to be installed: `npm install --save-dev axe-core`.
   */
  get a11y(): A11y {
    if (!this._a11y) {
      this._a11y = new A11y({ driver: this.driver });
    }
    return this._a11y;
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
  async loadState(path: string): Promise<void> {
    return this.storage.loadState(path);
  }

  async navigateTo(url: string, opts?: { waitUntil?: LoadState }): Promise<void> {
    this._tracer?.recordAction('navigateTo', [url, opts], url);
    const waitUntil: LoadState = opts?.waitUntil ?? 'load';

    // Classic-first: the default `waitUntil: 'load'` has an exact Classic
    // equivalent — Classic navigateTo() already blocks until
    // `document.readyState === 'complete'` — so there's no reason to spend a
    // BiDi round trip on the common case. BiDi is reserved for wait semantics
    // Classic cannot express: 'none' (return immediately), 'domcontentloaded'
    // (early return before full load), and 'networkidle' (needs real network
    // visibility).
    const context = waitUntil !== 'load' ? this.bidiSession?.getContext() : undefined;
    if (context && this.bidiSession?.isConnected()) {
      const conn = this.bidiSession.getConnection();
      const bidiWait =
        waitUntil === 'none' ? 'none'
          : waitUntil === 'domcontentloaded' ? 'interactive'
            : 'complete'; // 'networkidle'

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
      await new Promise(r => setTimeout(r, 500));
    }
  }

  /**
   * Navigate the active page back one step in its session history.
   * Proxies to {@link Page.goBack} on {@link activePage}.
   */
  async goBack(): Promise<void> {
    this._tracer?.recordAction('goBack');
    const page = await this.activePage();
    await page.goBack();
  }

  /**
   * Navigate the active page forward one step in its session history.
   * Proxies to {@link Page.goForward} on {@link activePage}.
   */
  async goForward(): Promise<void> {
    this._tracer?.recordAction('goForward');
    const page = await this.activePage();
    await page.goForward();
  }

  /**
   * Reload the active page. Proxies to {@link Page.reload} on
   * {@link activePage}.
   */
  async reload(): Promise<void> {
    this._tracer?.recordAction('reload');
    const page = await this.activePage();
    await page.reload();
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
    this._tracer?.recordAction('setContent', [opts]);
    const page = await this.activePage();
    await page.setContent(html, opts);
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
    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        'grantPermissions() requires BiDi (enableBiDi: true). ' +
        'Permission overrides use the W3C BiDi `permissions.setPermission` command, ' +
        'which has no Classic-WebDriver equivalent.'
      );
    }
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new Error('grantPermissions: pass a non-empty array of permission names.');
    }
    const conn = this.bidiSession.getConnection();
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
  async clearPermissions(
    permissions: string[],
    opts?: { origin?: string }
  ): Promise<void> {
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
    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        'setGeolocation() requires BiDi (enableBiDi: true). ' +
        'Geolocation overrides use the W3C BiDi `emulation.setGeolocationOverride` ' +
        'command, which has no Classic-WebDriver equivalent.'
      );
    }
    const conn = this.bidiSession.getConnection();
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
        coords.latitude < -90 || coords.latitude > 90 ||
        coords.longitude < -180 || coords.longitude > 180
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

    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        'emulate() requires BiDi (enableBiDi: true). ' +
        'Emulation overrides use the W3C BiDi `emulation.*` commands ' +
        '(and the BiDi+CDP bridge for media features and offline), ' +
        'which have no Classic-WebDriver equivalent.'
      );
    }

    // Validate Chromium-only fields up front so we fail before mutating state.
    const chromiumOnly = ['colorScheme', 'reducedMotion', 'forcedColors', 'offline'] as const;
    const isFirefox = this._browserName === 'firefox';
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

    const conn = this.bidiSession.getConnection();
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
      else { await new Promise(r => setTimeout(r, 500)); }
      return;
    }

    // --- 'load' or 'domcontentloaded' ---

    if (this.bidiSession?.isConnected()) {
      const context = this.bidiSession.getContext();

      // Check readyState first. If already satisfied, return immediately —
      // this avoids creating a timeout-Promise that could reject before the
      // caller attaches a handler (unhandled-rejection warning).
      const readyState = await this.driver.executeScript<string>('return document.readyState', []);
      const satisfied = state === 'load'
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
        let unsubscribe = state === 'load'
          ? this.bidiSession!.onLoad(handler)
          : this.bidiSession!.onDomContentLoaded(handler);
      });
    }

    // Classic fallback: poll document.readyState
    const target = state === 'load' ? 'complete' : 'interactive';
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const readyState = await this.driver.executeScript<string>('return document.readyState', []);
      if (readyState === 'complete' || (target === 'interactive' && readyState === 'interactive')) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new CraftdriverError(
      ErrorCode.TIMEOUT_WAITING_LOAD,
      `waitForLoadState('${state}') timed out after ${timeout}ms`,
      { detail: { state, timeout } }
    );
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
    // Close BiDi connection first
    if (this.bidiSession) {
      await this.bidiSession.close().catch(() => { });
    }
    for (const off of this._topLevelContextTrackingOffs) off();
    this._topLevelContextTrackingOffs = [];
    this._topLevelContextTracking = undefined;
    this._topLevelContextUserContexts.clear();
    this._topLevelContextCacheVersion++;
    // DELETE the WebDriver session — this tells the driver service to close the browser.
    await this.driver.quit().catch(() => { });
    // Give the browser process a moment to fully release any ports (e.g. Firefox BiDi
    // WebSocket port 9222) before we kill the driver service. Without this pause, a
    // subsequent launch may see a 404 when connecting to the new session's WebSocket.
    await new Promise((r) => setTimeout(r, 500));
    // Stop the underlying driver service (chromedriver / geckodriver)
    // so we don't leak processes between sessions.
    if (this._driverService) {
      await this._driverService.stop().catch(() => { });
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
        { detail: { feature: 'startTrace' } }
      );
    }
    if (!this._tracer) {
      this._tracer = new Tracer(this, this.bidiSession.getConnection());
    }
    await this._tracer.start(opts);
  }

  /**
   * Stop the active trace: drain in-flight screenshots, write the closing
   * `meta` line, and close the file. If your test threw and never reached
   * here, the file is still valid NDJSON — just without the closing line.
   */
  async stopTrace(): Promise<void> {
    if (!this._tracer || !this._tracer.isRunning) {
      throw new CraftdriverError(
        ErrorCode.STATE_INVALID,
        'stopTrace(): no trace is running. Call startTrace() first.',
        { detail: { feature: 'stopTrace' } }
      );
    }
    await this._tracer.stop();
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

    if (this.bidiSession?.isConnected()) {
      const conn = this.bidiSession.getConnection();
      const context = this.bidiSession.getContext();
      const target: Record<string, unknown> = context ? { context } : {};

      let result: ScriptEvaluateResult;
      if (typeof fn === 'function') {
        result = await conn.send<ScriptEvaluateResult>('script.callFunction', {
          functionDeclaration: fnSrc,
          target,
          arguments: args.map(serializeLocalValue),
          awaitPromise: true,
        });
      } else {
        // String form: wrap in a function so `return` statements are valid,
        // matching the behaviour of Classic WebDriver executeScript.
        result = await conn.send<ScriptEvaluateResult>('script.callFunction', {
          functionDeclaration: `function() { ${fnSrc} }`,
          target,
          arguments: [],
          awaitPromise: true,
        });
      }

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
    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        'addInitScript() requires BiDi. ' +
        'BiDi is enabled by default — check that your browser supports it.'
      );
    }

    const conn = this.bidiSession.getConnection();
    const fnSrc =
      typeof fnOrSrc === 'function'
        ? fnOrSrc.toString()
        : `() => { ${fnOrSrc} }`;

    const result = await conn.send<{ script: string }>('script.addPreloadScript', {
      functionDeclaration: fnSrc,
    });

    const scriptId = result.script;
    return {
      remove: async () => {
        await conn.send('script.removePreloadScript', { script: scriptId });
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
    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        'waitForRequest() requires BiDi. BiDi is enabled by default — check your browser supports it.'
      );
    }
    return this.network.waitForRequest(pattern, { timeout: opts?.timeout ?? this.defaults.navigationTimeout });
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
    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        'waitForResponse() requires BiDi. BiDi is enabled by default \u2014 check your browser supports it.'
      );
    }
    return this.network.waitForResponse(pattern, { timeout: opts?.timeout ?? this.defaults.navigationTimeout });
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
    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        `browser.on('${event}') requires BiDi (enableBiDi: true). ` +
        'Network event listeners use the W3C BiDi `network` module, which has no Classic-WebDriver equivalent.'
      );
    }
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
    const dir = this._downloadsDir;
    if (!dir) {
      throw new Error('waitForDownload() requires a downloads directory. Browser was not launched correctly.');
    }
    const timeout = opts?.timeout ?? this.defaults.navigationTimeout;

    // Snapshot existing files before action
    const before = new Set(fsSync.readdirSync(dir));

    await action();

    // Poll for a new non-.crdownload file
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const after = fsSync.readdirSync(dir);
      const newFiles = after.filter(f => !before.has(f) && !f.endsWith('.crdownload'));
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
      await new Promise(r => setTimeout(r, 100));
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
    // Classic: no push events — callers must use the imperative API below
    // Return a no-op unsubscribe
    return () => { /* no-op */ };
  }

  /**
   * Accept the currently open dialog (OK / confirm).
   * For prompt dialogs, pass `text` to type into the input first.
   * Uses BiDi when available, Classic WebDriver otherwise.
   */
  async acceptDialog(text?: string): Promise<void> {
    this._tracer?.recordAction('acceptDialog', text !== undefined ? [text] : undefined);
    if (this.bidiSession?.isConnected()) {
      await this.bidiSession.handleUserPrompt(true, text);
      return;
    }
    if (text !== undefined) await this.driver.sendAlertText(text);
    await this.driver.acceptAlert();
  }

  /**
   * Dismiss the currently open dialog (Cancel / close).
   * Uses BiDi when available, Classic WebDriver otherwise.
   */
  async dismissDialog(): Promise<void> {
    this._tracer?.recordAction('dismissDialog');
    if (this.bidiSession?.isConnected()) {
      await this.bidiSession.handleUserPrompt(false);
      return;
    }
    await this.driver.dismissAlert();
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
      const tid = timeout > 0
        ? setTimeout(() => { off(); reject(new Error(`waitForDialog timed out after ${timeout}ms`)); }, timeout)
        : undefined;

      const off = this.onDialog((dialog) => {
        if (tid !== undefined) clearTimeout(tid);
        off();
        resolve(dialog);
      });
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
      accept: async (text?: string) => { await this.acceptDialog(text); },
      dismiss: async () => { await this.dismissDialog(); },
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
          const tree = await conn.send<{ contexts: BidiContextInfo[] }>(
            'browsingContext.getTree',
            { root: topContextId }
          );
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
        tree = await conn.send<{ contexts: BidiContextInfo[] }>(
          'browsingContext.getTree',
          { root: topContextId }
        );
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
        new Frame(this.driver, iframe.getId(), this.getDefaultTimeout,
          conn ? { bidiContextId, conn } : undefined)
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
      const tree = await conn.send<{ contexts: BidiContextInfo[] }>(
        'browsingContext.getTree',
        { maxDepth: 0 }
      );
      return (tree.contexts ?? []).map(
        (ctx) => new Page(
          this.driver,
          ctx.context,
          this.getDefaultTimeout,
          conn,
          this._wrapContext(ctx.userContext ?? 'default')
        )
      );
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
    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        'openPage() requires BiDi (enableBiDi: true). ' +
        'WebDriver Classic cannot create top-level browsing contexts.'
      );
    }
    const conn = this.bidiSession.getConnection();
    const created = await conn.send<{ context: string }>('browsingContext.create', {
      type: opts?.type ?? 'tab',
    });
    const page = new Page(this.driver, created.context, this.getDefaultTimeout, conn, this.defaultContext);
    if (opts?.url) {
      await page.navigateTo(opts.url);
    }
    return page;
  }

  /**
   * Run `action` and wait for a new top-level browsing context (tab / popup)
   * to open. Returns a `Page` bound to the new context.
   *
   * @example
   * const popup = await browser.waitForPage(() => browser.click('#open-popup'));
   * await popup.waitForLoadState();
   * const title = await popup.title();
   */
  async waitForPage(
    action: () => Promise<void>,
    opts?: { timeout?: number }
  ): Promise<Page> {
    const timeout = opts?.timeout ?? this.defaults.navigationTimeout;

    if (this.bidiSession?.isConnected()) {
      const conn = this.bidiSession.getConnection();

      // Subscribe to contextCreated if not already subscribed
      await conn.subscribe(['browsingContext.contextCreated']).catch(() => {/* already subscribed */ });

      return new Promise<Page>((resolve, reject) => {
        const timer = setTimeout(() => {
          off();
          reject(new Error(`waitForPage() timed out after ${timeout}ms`));
        }, timeout);

        const off = conn.on('browsingContext.contextCreated', (params: Record<string, unknown>) => {
          // Only top-level contexts have no parent
          if (!params.parent) {
            clearTimeout(timer);
            off();
            resolve(new Page(
              this.driver,
              params.context as string,
              this.getDefaultTimeout,
              conn,
              this._wrapContext((params.userContext as string | undefined) ?? 'default')
            ));
          }
        });

        action().catch((err) => {
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
      const newHandles = after.filter(h => !before.has(h));
      if (newHandles.length > 0) {
        const handle = newHandles[0];
        return new Page(
          this.driver,
          handle,
          this.getDefaultTimeout
        );
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`waitForPage() timed out after ${timeout}ms — no new tab or popup appeared`);
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
   * const ctx = await browser.newContext({ storageState: 'auth/alice.json' });
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
      { getNetwork: () => this.network, getBrowserName: () => this._browserName },
      config
    );
    this._contextsById.set(id, ctx);
    // Evict on close so long-running suites that create many contexts don't
    // accumulate dead wrappers.
    ctx.on('close', () => { this._contextsById.delete(id); });
    return ctx;
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
    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        'newContext() requires BiDi (enableBiDi: true). ' +
        'WebDriver Classic has no concept of user contexts.'
      );
    }
    const conn = this.bidiSession.getConnection();
    const created = await conn.send<{ userContext: string }>('browser.createUserContext', {});
    const ctx = this._wrapContext(created.userContext, {
      baseURL: opts?.baseURL,
      extraHTTPHeaders: opts?.extraHTTPHeaders,
    });
    if (opts?.storageState !== undefined) {
      await ctx.loadStorageState(opts.storageState);
    }
    // Apply Milestone-C emulation options. Each setter is `userContexts`-scoped,
    // so future pages in this context inherit automatically.
    if (opts?.locale !== undefined) await ctx.setLocale(opts.locale);
    if (opts?.timezoneId !== undefined) await ctx.setTimezone(opts.timezoneId);
    if (opts?.geolocation !== undefined) await ctx.setGeolocation(opts.geolocation);
    return ctx;
  }

  /**
   * Return all open user contexts, including the default one.
   *
   * Maps to BiDi `browser.getUserContexts`. **BiDi-only.**
   */
  async contexts(): Promise<BrowserContext[]> {
    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        'contexts() requires BiDi (enableBiDi: true). ' +
        'WebDriver Classic has no concept of user contexts. ' +
        'Use browser.pages() to list tabs instead.'
      );
    }
    const conn = this.bidiSession.getConnection();
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
    if (!this.bidiSession?.isConnected()) {
      throw new Error(
        'defaultContext requires BiDi (enableBiDi: true). ' +
        'WebDriver Classic has no concept of user contexts.'
      );
    }
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
  private async _startTopLevelContextTracking(
    initialContexts?: BidiContextInfo[]
  ): Promise<void> {
    const conn = this.bidiSession!.getConnection();

    if (!initialContexts) {
      await conn
        .subscribe(['browsingContext.contextCreated', 'browsingContext.contextDestroyed'])
        .catch(() => { /* already subscribed or unsupported; fallback sync will cover us */ });
    }

    const onCreated = (params: Record<string, unknown>) => {
      if (params.parent) return;
      const id = params.context;
      if (typeof id !== 'string') return;
      this._topLevelContextUserContexts.set(
        id,
        typeof params.userContext === 'string' ? params.userContext : ''
      );
      this._topLevelContextCacheVersion++;
    };
    const onDestroyed = (params: Record<string, unknown>) => {
      if (params.parent) return;
      if (typeof params.context === 'string') {
        this._topLevelContextUserContexts.delete(params.context);
        this._topLevelContextCacheVersion++;
      }
    };

    this._topLevelContextTrackingOffs.push(conn.on('browsingContext.contextCreated', onCreated));
    this._topLevelContextTrackingOffs.push(conn.on('browsingContext.contextDestroyed', onDestroyed));

    if (initialContexts) {
      for (const ctx of initialContexts) {
        if (!ctx.parent) {
          this._topLevelContextUserContexts.set(ctx.context, ctx.userContext ?? 'default');
        }
      }
      this._topLevelContextCacheVersion++;
    } else {
      await this._refreshTopLevelContextCache(conn).catch(() => { });
    }
  }

  private async _refreshTopLevelContextCache(conn: BiDiConnection): Promise<void> {
    const version = this._topLevelContextCacheVersion;
    const tree = await conn.send<{ contexts: BidiContextInfo[] }>(
      'browsingContext.getTree',
      { maxDepth: 0 }
    );
    if (this._topLevelContextCacheVersion === version) {
      this._topLevelContextUserContexts.clear();
    }
    for (const ctx of tree.contexts ?? []) {
      if (!ctx.parent) {
        this._topLevelContextUserContexts.set(ctx.context, ctx.userContext ?? 'default');
      }
    }
    this._topLevelContextCacheVersion++;
  }

  private _firstDefaultTopLevelContext(): string | undefined {
    for (const [id, userContext] of this._topLevelContextUserContexts) {
      if (userContext === 'default') return id;
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

      if (handle && this._topLevelContextUserContexts.get(handle) === 'default') {
        return new Page(this.driver, handle, this.getDefaultTimeout, conn, this.defaultContext);
      }

      // Events should keep the cache warm, but a cheap top-level sync covers
      // missed startup events and direct protocol/browser changes.
      await this._refreshTopLevelContextCache(conn);
      if (handle && this._topLevelContextUserContexts.get(handle) === 'default') {
        return new Page(this.driver, handle, this.getDefaultTimeout, conn, this.defaultContext);
      }

      const fallback = this._firstDefaultTopLevelContext();
      if (!fallback) {
        throw new Error('activePage(): no top-level page in the default context.');
      }
      return new Page(this.driver, fallback, this.getDefaultTimeout, conn, this.defaultContext);
    }
    // Classic mode: no user-context concept; just wrap the current window.
    const handle = await this.driver.getCurrentWindowHandle();
    return new Page(this.driver, handle, this.getDefaultTimeout);
  }

  async click(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    if (this._tracer?.isRunning) this._tracer.recordAction('click', undefined, selectorToString(selector));
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementIsVisible(by), { timeout: opts?.timeout ?? this.defaults.timeout });
    await el.click();
  }

  async fill(
    selector: string | By,
    text: string,
    opts?: { timeout?: number }
  ): Promise<void> {
    if (this._tracer?.isRunning) this._tracer.recordAction('fill', [text], selectorToString(selector));
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementIsVisible(by), {
      timeout: opts?.timeout ?? this.defaults.timeout,
    });
    await el.click();
    await el.clear();
    await el.sendKeys(text);
  }

  async clear(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    if (this._tracer?.isRunning) this._tracer.recordAction('clear', undefined, selectorToString(selector));
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementIsVisible(by), {
      timeout: opts?.timeout ?? this.defaults.timeout,
    });
    await el.clear();
  }

  async getValue(selector: string | By, opts?: { timeout?: number }): Promise<string> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const el = await this.driver.wait(until.elementLocated(by), {
      timeout: opts?.timeout ?? this.defaults.timeout,
    });
    const val = await el.getProperty('value');
    return String(val ?? '');
  }

  async getAttribute(selector: string | By, name: string, opts?: { timeout?: number }): Promise<string | null> {
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
      await this.driver.performTouchPinch(center, scale, distance, durationMs);
    },
  };

  /**
   * Capture a screenshot of the active page (viewport by default), the
   * full scrollable document (`fullPage: true`), or an element matching
   * `selector`. Optionally write the PNG to `path`. Returns the raw PNG
   * buffer.
   *
   * Full-page capture uses BiDi `browsingContext.captureScreenshot` with
   * `origin: 'document'` and therefore requires `enableBiDi: true`
   * (the default). Element capture composes auto-waiting via the same
   * resolution as `find()`.
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
      if (!this.bidiSession?.isConnected()) {
        throw new Error(
          'screenshot({ fullPage: true }) requires BiDi (enableBiDi: true). ' +
          'Full-page screenshots use the W3C BiDi `browsingContext.captureScreenshot` ' +
          'command with `origin: "document"`, which has no Classic-WebDriver equivalent.'
        );
      }
      const conn = this.bidiSession.getConnection();
      const page = await this.activePage();
      const result = await conn.send<{ data: string }>('browsingContext.captureScreenshot', {
        context: page.id(),
        origin: 'document',
      });
      buf = Buffer.from(result.data, 'base64');
    } else {
      const b64 = await this.driver.screenshotBase64();
      buf = Buffer.from(b64, 'base64');
    }
    if (opts?.path) await fs.writeFile(opts.path, buf);
    return buf;
  }

  expect(selector: string | By) {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return expectSelector(this.driver, by, this.getDefaultTimeout);
  }

  find(selector: string | By): ElementHandle {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return new ElementHandle(this.driver, by, this.getDefaultTimeout);
  }

  /**
   * Return a lazy, chainable `Locator` for the given selector.
   * Prefer `locator()` over `find()` when you need composition, filtering, or indexed access.
   */
  locator(selector: string | By): Locator {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    return new Locator(this.driver, by, this.getDefaultTimeout);
  }

  /**
   * Return snapshot `ElementHandle`s for all elements matching `selector` at call time.
   * Use `locator().all()` when you need filtering; use `findAll()` for the simple array case.
   */
  async findAll(selector: string | By): Promise<ElementHandle[]> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    const webElements = await this.driver.findElements(by);
    return webElements.map((we) => ElementHandle.fromWebElement(this.driver, we, this.getDefaultTimeout));
  }

  getByRole(role: string, opts?: { name?: string; exact?: boolean; includeHidden?: boolean }): ElementHandle {
    return new ElementHandle(this.driver, By.role(role, opts), this.getDefaultTimeout);
  }

  getByText(text: string, opts?: { exact?: boolean }): ElementHandle {
    return new ElementHandle(this.driver, By.text(text, opts), this.getDefaultTimeout);
  }

  getByLabel(text: string, opts?: { exact?: boolean }): ElementHandle {
    return new ElementHandle(this.driver, By.labelText(text, opts), this.getDefaultTimeout);
  }

  getByPlaceholder(text: string, opts?: { exact?: boolean }): ElementHandle {
    return new ElementHandle(this.driver, By.placeholder(text, opts), this.getDefaultTimeout);
  }

  getByTestId(id: string): ElementHandle {
    return new ElementHandle(this.driver, By.testId(id), this.getDefaultTimeout);
  }

  // Keyboard controller and enum for nicer usage: browser.keyboard.press(Key.Enter)
  keyboard: Keyboard;

  // Mouse controller: browser.mouse.click(...), move, down, up, wheel, dragAndDrop
  mouse: Mouse;

  static Key = Key;

  async waitForVisible(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementIsVisible(by), { timeout: opts?.timeout ?? this.defaults.timeout });
  }

  async waitForHidden(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementIsNotVisible(by), { timeout: opts?.timeout ?? this.defaults.timeout });
  }

  async waitForAttached(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementExists(by), { timeout: opts?.timeout ?? this.defaults.timeout });
  }

  async waitForDetached(selector: string | By, opts?: { timeout?: number }): Promise<void> {
    const by = typeof selector === 'string' ? By.css(selector) : selector;
    await this.driver.wait(until.elementNotExists(by), { timeout: opts?.timeout ?? this.defaults.timeout });
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
      case 'visible': return this.waitForVisible(selector, opts);
      case 'hidden': return this.waitForHidden(selector, opts);
      case 'attached': return this.waitForAttached(selector, opts);
      case 'detached': return this.waitForDetached(selector, opts);
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
