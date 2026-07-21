/**
 * BrowserContext — a WebDriver BiDi user context (an isolated browser
 * profile, equivalent to "open a new incognito window").
 *
 * Each `BrowserContext` owns its own cookies, localStorage, and
 * IndexedDB, isolated from every other context including the default
 * one. Use it to run multi-user scenarios (log in as Alice in one
 * context, as Bob in another) without cookie cross-talk.
 *
 * **BiDi-only.** Maps directly onto BiDi `browser.createUserContext`
 * (§7.2.4.2) and friends. Classic WebDriver has no equivalent and
 * `browser.newContext()` throws there.
 *
 * Obtain via:
 *   - `browser.newContext()` — create a fresh isolated profile.
 *   - `browser.contexts()`  — list all open user contexts.
 *   - `browser.defaultContext` — the implicit context the browser
 *     started in (id = `'default'`).
 */

import { writeSecureFile } from './secureFile.js';
import { CraftdriverError, ErrorCode } from './errors.js';
import {
  parseSessionState,
  hasNonEmptySessionStorage,
  isStorageStateError,
  nonEmptyOrigins,
  normalizeCookieForRestore,
  storageStateDetail,
  type StorageStateErrorContext,
} from './sessionStateValidation.js';
import type { Driver } from './driver.js';
import type { BiDiConnection } from './bidi/connection.js';
import { Page } from './page.js';
import { AUTH_STATE_HYDRATE_PATH, publicPageInitScript } from './initScript.js';
import type { NetworkInterceptor, RequestHandler } from './bidi/network.js';
import type {
  BrowsingContextInfo,
  Cookie,
  CookieInput,
  GetCookiesResult,
  RawNetworkCookie,
  RawPartialCookie,
  SessionState,
  UrlPattern,
} from './bidi/types.js';

/** Filter applied to {@link BrowserContext.clearCookies}. */
export interface ClearCookiesFilter {
  /** Match cookies whose `name` equals this string. */
  name?: string;
  /** Match cookies whose `domain` equals this string. */
  domain?: string;
  /** Match cookies whose `path` equals this string. */
  path?: string;
}

/** Options for {@link BrowserContext.storageState}. */
export interface ContextStorageStateOptions {
  /** Include cookies in the snapshot. Default `true`. */
  includeCookies?: boolean;
  /**
   * Include localStorage in the snapshot. Default `true`.
   * Only origins of currently-open pages in this context are captured;
   * BiDi has no API to read localStorage for an origin that no page is
   * currently visiting.
   */
  includeLocalStorage?: boolean;
}

/** Internal hooks the owning {@link Browser} passes to a new context. */
export interface BrowserContextHooks {
  /** Returns the singleton {@link NetworkInterceptor} — used by {@link BrowserContext.route}. */
  getNetwork: () => NetworkInterceptor;
  /** Returns the engine name, used by the emulation setters to gate engine-specific BiDi calls. */
  getBrowserName?: () => string;
  /** True when browser-level preload scripts can run in this context's pages. */
  hasBrowserInitScripts?: () => boolean;
}

/** Per-context options stored at creation time. */
export interface BrowserContextConfig {
  /**
   * Base URL used to resolve relative paths passed to `page.navigateTo()`.
   * Absolute URLs are unaffected.
   */
  baseURL?: string;
  /**
   * Extra HTTP headers added to every request from every page in this
   * context. Applied via BiDi `network.setExtraHeaders` on context
   * creation and re-applied to each new page that opens here.
   */
  extraHTTPHeaders?: Record<string, string>;
}

/** A handle returned by {@link BrowserContext.addInitScript}. */
export interface InitScriptHandle {
  /** BiDi preload-script id. */
  id: string;
  /** Remove the init script. Safe to call more than once. */
  remove(): Promise<void>;
}

/** Pattern accepted by {@link BrowserContext.route}. Same shape as the browser-level interceptor. */
export type RoutePattern = string | string[] | UrlPattern | UrlPattern[];

/** Event listener signatures. */
type PageListener = (page: Page) => void;
type CloseListener = () => void;

export class BrowserContext {
  /** Monotonic counter for synthetic route ids returned by `route()`. */
  private static _routeCounter = 0;
  private driver: Driver;
  private conn: BiDiConnection;
  private getDefaultTimeout: () => number;
  private getNavigationTimeout: () => number;
  private _id: string;
  private _closed = false;
  private _hooks?: BrowserContextHooks;
  /** Per-context config (baseURL, extraHTTPHeaders). Read by Page for URL resolution. */
  private _config: BrowserContextConfig;
  /** Preload-script ids registered via {@link addInitScript}. */
  private _initScriptIds = new Set<string>();
  /**
   * Per-route bookkeeping for `route()`. The synthetic id we return to
   * the user maps to its pattern, handler, and the live BiDi intercept
   * ids — one per page that currently belongs to this user context.
   *
   * BiDi `network.addIntercept` does not accept a user-context filter,
   * so we register a separate intercept per page (with `contexts: [pageId]`)
   * and add/remove them as pages open and close.
   */
  private _routes = new Map<
    string,
    { pattern: RoutePattern; handler: RequestHandler; perPage: Map<string, string> }
  >();
  /** Top-level browsing-context (page) ids currently inside this user context. */
  private _pageIds = new Set<string>();
  /**
   * Page ids we've already fired `'page'` listeners for. Tracked
   * separately from `_pageIds` so that the listener fires exactly once
   * regardless of whether `newPage()` populates `_pageIds` before or
   * after the `browsingContext.contextCreated` event arrives.
   */
  private _notifiedPageIds = new Set<string>();
  /**
   * Ids of internal (hydration) top-level contexts that must stay invisible to
   * page tracking — never surfaced as a `'page'`, added to `_pageIds`, or given
   * user routes/headers. See {@link _hydrateLocalStorage}.
   */
  private _internalPageIds = new Set<string>();
  /**
   * `> 0` while an internal `browsingContext.create` is awaiting its id.
   * Top-level `contextCreated` events that arrive in that window are quarantined
   * (the event can beat the create response), then the internal one is dropped
   * and the rest replayed in order once the id is known.
   */
  private _internalCreateInFlight = 0;
  private _quarantinedCreated: Array<Record<string, unknown>> = [];
  private _internalClassificationWaiters = new Set<() => void>();
  /** Settled tail used to serialize state overlays within this user context. */
  private _restoreTail: Promise<void> = Promise.resolve();
  /**
   * The in-flight promise from the most recent call to {@link _ensurePageTracking}.
   * Doubles as the "is tracking armed?" flag — truthy after the first call,
   * cleared in {@link close}. Used to await readiness when `on('page')` is
   * followed immediately by `newPage()` — Firefox fires `contextCreated`
   * before `session.subscribe` round-trips, so we must defer page creation
   * until the listener is attached.
   */
  private _trackingPromise?: Promise<void>;
  /** Unsubscribe handles for the contextCreated/Destroyed listeners. */
  private _trackingOffs: Array<() => void> = [];
  private _pageListeners = new Set<PageListener>();
  private _closeListeners = new Set<CloseListener>();

  constructor(
    driver: Driver,
    conn: BiDiConnection,
    userContextId: string,
    getDefaultTimeout: () => number,
    getNavigationTimeout: () => number,
    hooks?: BrowserContextHooks,
    config: BrowserContextConfig = {}
  ) {
    this.driver = driver;
    this.conn = conn;
    this._id = userContextId;
    this.getDefaultTimeout = getDefaultTimeout;
    this.getNavigationTimeout = getNavigationTimeout;
    this._hooks = hooks;
    this._config = { ...config };
  }

  /** The BiDi user-context id. The implicit default context has id `'default'`. */
  get id(): string {
    return this._id;
  }

  /** True after `close()` has removed the context. */
  get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Base URL used to resolve relative paths in `page.navigateTo()`.
   * Configured via `browser.newContext({ baseURL })`. Read by {@link Page}.
   */
  get baseURL(): string | undefined {
    return this._config.baseURL;
  }

  private assertOpen(): void {
    if (this._closed) {
      throw new Error(
        `BrowserContext "${this._id}" is closed; create a new one with browser.newContext().`
      );
    }
  }

  /** @internal Used by Page to keep preload-backed navigations on BiDi. */
  _hasInitScriptsForNavigation(): boolean {
    return (
      this._initScriptIds.size > 0 ||
      this._hooks?.hasBrowserInitScripts?.() === true
    );
  }

  /** BiDi partition descriptor for storage operations scoped to this user context. */
  private partition(): { type: 'storageKey'; userContext: string } {
    return { type: 'storageKey', userContext: this._id };
  }

  /**
   * Open a new top-level browsing context (a tab or a window) inside this
   * user context. Maps to BiDi `browsingContext.create` with the
   * `userContext` parameter bound to this id.
   */
  async newPage(opts?: { url?: string; type?: 'tab' | 'window' }): Promise<Page> {
    this.assertOpen();
    // If any code path has armed page tracking (typically `on('page', …)`),
    // wait for the subscription to be in place before we trigger
    // `contextCreated` — Firefox emits the event before `session.subscribe`
    // round-trips, and we must not lose it.
    if (this._trackingPromise) await this._trackingPromise;
    const created = await this.conn.send<{ context: string }>('browsingContext.create', {
      type: opts?.type ?? 'tab',
      userContext: this._id,
    });
    const page = new Page(this.driver, created.context, this.getDefaultTimeout, this.conn, this);
    // Track and apply extra headers before navigation so the first request carries them.
    this._pageIds.add(created.context);
    await this._applyExtraHeadersTo([created.context]);
    // Register any existing routes on this new page before navigation.
    for (const sid of this._routes.keys()) {
      await this._registerRouteOnPage(sid, created.context).catch(() => { });
    }
    if (opts?.url) {
      await page.navigateTo(opts.url);
    }
    return page;
  }

  /**
   * Return all open top-level pages that belong to this user context.
   */
  async pages(): Promise<Page[]> {
    this.assertOpen();
    const tree = await this.conn.send<{ contexts: BrowsingContextInfo[] }>(
      'browsingContext.getTree',
      { maxDepth: 0 }
    );
    // The create event can beat the command response that tells us which id is
    // internal. Wait for that classification before exposing this tree.
    await this._waitForInternalClassification();
    return (tree.contexts ?? [])
      .filter(
        (c) => c.userContext === this._id && !c.parent && !this._internalPageIds.has(c.context)
      )
      .map((c) => new Page(this.driver, c.context, this.getDefaultTimeout, this.conn, this));
  }

  /**
   * Run `action` and resolve to the next new top-level page that opens
   * **inside this user context**. Useful when a click in one of this
   * context's pages spawns a popup.
   */
  async waitForPage(
    action: () => Promise<void>,
    opts?: { timeout?: number }
  ): Promise<Page> {
    this.assertOpen();
    const timeout = opts?.timeout ?? this.getNavigationTimeout();

    // Make sure any prior `on('page')` subscription is fully installed before
    // we run `action()` — otherwise a fast popup could fire before we listen.
    // `browsingContext.contextCreated` is already subscribed session-wide by
    // `BiDiSession.connect()`, so no per-call `subscribe()` is needed here.
    if (this._trackingPromise) await this._trackingPromise;

    return new Promise<Page>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        off();
        reject(new Error(`waitForPage() timed out after ${timeout}ms`));
      }, timeout);

      const off = this.conn.on('browsingContext.contextCreated', (params: Record<string, unknown>) => {
        if (params.parent) return; // nested frames
        if (params.userContext !== this._id) return;
        const id = params.context as string;
        void this._isInternalPageContext(id).then((internal) => {
          if (internal || settled) return;
          settled = true;
          clearTimeout(timer);
          off();
          resolve(new Page(
            this.driver,
            id,
            this.getDefaultTimeout,
            this.conn,
            this
          ));
        }).catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          off();
          reject(err);
        });
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

  // ── Cookies ──────────────────────────────────────────────────────────────

  /**
   * Return cookies scoped to this user context.
   *
   * Optionally filter by URL(s): only cookies whose `domain`/`path` would
   * be sent on a request to that URL are returned. Mirrors Playwright's
   * `BrowserContext.cookies(urls)` shape.
   *
   * @example
   * ```ts
   * const session = await alice.cookies(['https://app.example.com']);
   * expect(session.find(c => c.name === 'sid')).toBeDefined();
   * ```
   */
  async cookies(urls?: string | string[]): Promise<Cookie[]> {
    this.assertOpen();
    const result = await this.conn.send<GetCookiesResult>('storage.getCookies', {
      partition: this.partition(),
    });
    const all = (result.cookies ?? []).map(normalizeCookie);
    if (urls === undefined) return all;
    const urlList = Array.isArray(urls) ? urls : [urls];
    const parsed = urlList.map((u) => new URL(u));
    return all.filter((c) => parsed.some((u) => cookieMatchesUrl(c, u)));
  }

  /**
   * Add cookies to this user context. The `domain` field is required —
   * BiDi rejects host-less cookies. Use `expiry` (UNIX seconds) or omit
   * for a session cookie.
   *
   * @example
   * ```ts
   * // Pre-seed an authenticated session before the first navigation.
   * await alice.addCookies([
   *   { name: 'sid', value: 'eyJhbGciOi…', domain: 'app.example.com', path: '/', secure: true, sameSite: 'lax' },
   * ]);
   * ```
   */
  async addCookies(cookies: CookieInput[]): Promise<void> {
    this.assertOpen();
    for (const c of cookies) {
      // BiDi rejects `sameSite: 'none'` without `secure: true`. Be loud
      // instead of silently rewriting the cookie.
      if (c.sameSite === 'none' && !c.secure) {
        throw new Error(
          `addCookies: cookie "${c.name}" has sameSite "none" but secure is false. ` +
          `Set secure: true or change sameSite to 'lax'/'strict'.`
        );
      }
      const partial: RawPartialCookie = {
        name: c.name,
        value: typeof c.value === 'string' ? { type: 'string', value: c.value } : c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        expiry: c.expiry,
      };
      await this.conn.send('storage.setCookie', {
        cookie: partial,
        partition: this.partition(),
      });
    }
  }

  /**
   * Remove cookies from this user context.
   *
   * - No filter: clears every cookie in this context.
   * - Filter fields are AND-combined: a cookie must match every provided
   *   field to be removed.
   *
   * @example
   * ```ts
   * await alice.clearCookies({ name: 'sid' });           // sign Alice out
   * await alice.clearCookies({ domain: 'tracker.io' });  // wipe a single host
   * await alice.clearCookies();                          // full reset
   * ```
   */
  async clearCookies(filter?: ClearCookiesFilter): Promise<void> {
    this.assertOpen();
    await this.conn.send('storage.deleteCookies', {
      filter: filter ?? {},
      partition: this.partition(),
    });
  }

  // ── Storage state (Playwright-shape JSON) ────────────────────────────────

  /**
   * Snapshot cookies + localStorage for this context.
   *
   * Returns `{ cookies, localStorage }` — a superset of Playwright's
   * `storageState()` JSON shape, kept close enough that dumped files
   * are interchangeable on a best-effort basis.
   *
   * **Limitation.** localStorage can only be read for origins that a page
   * in this context is currently visiting — BiDi has no out-of-band
   * storage read API. Open one page per origin you want captured before
   * snapshotting.
   */
  async storageState(opts?: ContextStorageStateOptions): Promise<SessionState> {
    this.assertOpen();
    const state: SessionState = {};

    if (opts?.includeCookies !== false) {
      state.cookies = await this.cookies();
    }

    if (opts?.includeLocalStorage !== false) {
      const local = await this.collectLocalStorage();
      if (Object.keys(local).length > 0) {
        state.localStorage = local;
      }
    }

    return state;
  }

  /**
   * Snapshot the context's state and write it to `path` as JSON.
   * Returns the snapshot for inspection.
   *
   * @example
   * ```ts
   * // tests/setup/login.ts — runs once, before the test suite.
   * const alice = await browser.newContext();
   * const page = await alice.newPage({ url: 'https://app.example.com/login' });
   * await loginAs(page, 'alice');
   * await alice.saveStorageState('auth/alice.json');
   * await alice.close();
   * ```
   */
  async saveStorageState(
    path: string,
    opts?: ContextStorageStateOptions
  ): Promise<SessionState> {
    const state = await this.storageState(opts);
    await writeSecureFile(path, JSON.stringify(state, null, 2));
    return state;
  }

  /**
   * Apply a previously-captured snapshot to this context.
   *
   * - Cookies are written immediately.
   * - localStorage is seeded once per captured origin through a private,
   *   intercepted same-origin document (BiDi has no "set localStorage for
   *   origin" command). Because it runs once — not as a per-navigation
   *   preload — the application owns the values afterward, so its own writes
   *   survive a reload.
   *
   * @param source A `SessionState` object, or a path to a JSON file
   *   produced by {@link saveStorageState}.
   */
  async loadStorageState(source: SessionState | string): Promise<void> {
    return this._loadStorageState(source, 'BrowserContext.loadStorageState');
  }

  /** @internal Same public contract with an owning API name for structured errors. */
  async _loadStorageState(source: SessionState | string, operation: string): Promise<void> {
    this.assertOpen();
    const errorContext = this._storageStateErrorContext(operation);
    const state = await parseSessionState(source, errorContext);

    // A context/launch restore cannot carry tab-scoped sessionStorage to the
    // caller's future pages — reject before any mutation rather than silently
    // dropping it. (browser.loadState() takes the active-page path for that.)
    if (hasNonEmptySessionStorage(state)) {
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        'restoring sessionStorage is not supported for context/launch APIs (it is ' +
          'tab-scoped); use browser.loadState() after navigating to the origin',
        {
          detail: storageStateDetail(errorContext, 'validation', { section: 'sessionStorage' }),
          hint: 'Navigate to the origin and call browser.loadState(), or omit sessionStorage.',
        }
      );
    }

    await this._runSerializedRestore(async () => {
      let partialApplied = false;

      // localStorage first — its private hydration page is where a restore failure
      // would surface; applying cookies last means a hydration failure never
      // leaves cookies behind.
      if (nonEmptyOrigins(state.localStorage).length > 0) {
        try {
          partialApplied = await this._hydrateLocalStorage(
            state.localStorage as Record<string, Record<string, string>>,
            errorContext
          );
        } catch (err) {
          if (isStorageStateError(err)) throw err;
          throw this._restoreDriverError(err, errorContext, 'localStorage', partialApplied);
        }
      }

      if (state.cookies?.length) {
        for (const captured of state.cookies) {
          try {
            await this.addCookies([normalizeCookieForRestore(captured)]);
            partialApplied = true;
          } catch (err) {
            throw this._restoreDriverError(err, errorContext, 'cookies', partialApplied);
          }
        }
      }
    });
  }

  /**
   * Remove this user context. All of its pages are closed and any
   * subsequent operation on this `BrowserContext` instance throws.
   * Fires the `'close'` event before tearing down.
   *
   * The default context (`id === 'default'`) cannot be removed.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    if (this._id === 'default') {
      throw new Error(
        'Cannot close the default BrowserContext. ' +
        'Quit the browser instead with browser.quit().'
      );
    }

    // Best-effort cleanup of init scripts and routes before the context
    // goes away — keeps the browser-level interceptor map from leaking.
    for (const id of this._initScriptIds) {
      await this.conn.send('script.removePreloadScript', { script: id }).catch(() => { });
    }
    this._initScriptIds.clear();
    if (this._hooks && this._routes.size > 0) {
      const net = this._hooks.getNetwork();
      for (const entry of this._routes.values()) {
        for (const realId of entry.perPage.values()) {
          if (!realId) continue;
          await net.removeIntercept(realId).catch(() => { });
        }
      }
    }
    this._routes.clear();
    for (const off of this._trackingOffs) off();
    this._trackingOffs = [];
    this._trackingPromise = undefined;
    this._internalPageIds.clear();
    this._resolveInternalClassificationWaiters();

    await this.conn.send('browser.removeUserContext', { userContext: this._id });
    this._closed = true;

    // Fire close listeners last, after the context is fully gone.
    for (const fn of this._closeListeners) {
      try { fn(); } catch { /* listener errors must not break close() */ }
    }
    this._closeListeners.clear();
    this._pageListeners.clear();
  }

  // ── Events ───────────────────────────────────────────────────────────────

  /**
   * Subscribe to context-scoped events.
   *
   * - `'page'`: fires whenever a new top-level page opens inside this
   *   context — programmatic (`ctx.newPage()`), `window.open()` from one
   *   of this context's pages, or `target="_blank"` clicks. Use this when
   *   you want a hook that applies to *every* page, current and future
   *   (e.g. console capture on a multi-tab flow).
   * - `'close'`: fires once after this context has been removed.
   *
   * Returns an unsubscribe function. Listeners that throw are caught and
   * ignored so a bad handler can't take down navigation.
   *
   * @example
   * ```ts
   * // Log every page's console output across the whole context,
   * // including popups that haven't been opened yet.
   * const off = ctx.on('page', (page) => {
   *   page.url().then((url) => console.log(`[ctx ${ctx.id}] page opened: ${url}`));
   * });
   * // …later…
   * off();
   * ```
   */
  on(event: 'page', listener: PageListener): () => void;
  on(event: 'close', listener: CloseListener): () => void;
  on(event: 'page' | 'close', listener: PageListener | CloseListener): () => void {
    if (event === 'close') {
      this._closeListeners.add(listener as CloseListener);
      return () => this._closeListeners.delete(listener as CloseListener);
    }
    this._pageListeners.add(listener as PageListener);
    // Page tracking is what powers the 'page' event AND `route` membership
    // filtering. Start it lazily on first listener.
    this._ensurePageTracking().catch(() => { });
    return () => this._pageListeners.delete(listener as PageListener);
  }

  /** Remove a previously-registered listener. */
  off(event: 'page', listener: PageListener): void;
  off(event: 'close', listener: CloseListener): void;
  off(event: 'page' | 'close', listener: PageListener | CloseListener): void {
    if (event === 'close') this._closeListeners.delete(listener as CloseListener);
    else this._pageListeners.delete(listener as PageListener);
  }

  // ── Init scripts ─────────────────────────────────────────────────────────

  /**
   * Register a script that runs in every page of this context, **before
   * any page script**, on every navigation including popups. Scoped to
   * this user context via BiDi `script.addPreloadScript`'s `userContexts`
   * parameter.
   *
   * Use it for the "every page in this profile gets this hook" patterns:
   * feature flags, fake clocks, auth shims, deterministic Math.random.
   *
   * @example
   * ```ts
   * // Mark every page as running under E2E so the app can skip
   * // animations and disable analytics — no per-page wiring needed.
   * await ctx.addInitScript(() => {
   *   window.__E2E__ = true;
   * });
   * ```
   */
  async addInitScript(
    script: string | ((...args: unknown[]) => unknown)
  ): Promise<InitScriptHandle> {
    this.assertOpen();
    const fnDecl =
      typeof script === 'function' ? script.toString() : `() => { ${script} }`;
    const result = await this.conn.send<{ script: string }>('script.addPreloadScript', {
      functionDeclaration: publicPageInitScript(fnDecl),
      userContexts: [this._id],
    });
    this._initScriptIds.add(result.script);
    return {
      id: result.script,
      remove: async () => {
        if (!this._initScriptIds.has(result.script)) return;
        this._initScriptIds.delete(result.script);
        await this.conn
          .send('script.removePreloadScript', { script: result.script })
          .catch(() => { });
      },
    };
  }

  /**
   * Remove an init script by its handle id. Alternative to calling
   * `handle.remove()` on the value returned by {@link addInitScript}.
   */
  async removeInitScript(id: string): Promise<void> {
    if (!this._initScriptIds.has(id)) return;
    this._initScriptIds.delete(id);
    await this.conn.send('script.removePreloadScript', { script: id }).catch(() => { });
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  /**
   * Intercept network requests originating from any page in this
   * context. The handler runs for every matching request; return a
   * `MockResponse` to fulfill it, or `void`/`undefined` to let it
   * continue to the network unmodified.
   *
   * Routes are registered as a separate BiDi `network.addIntercept`
   * per page, scoped to that page's browsing-context id. Pages opened
   * later inherit every route automatically; closed pages have their
   * intercept removed. Requests from *other* contexts are not seen.
   *
   * @example
   * ```ts
   * // Mock the authenticated user endpoint just for Alice's context.
   * await alice.route('**\/api/me', (req) => ({
   *   status: 200,
   *   headers: { 'content-type': 'application/json' },
   *   body: { id: 1, name: 'Alice' },
   * }));
   * ```
   */
  async route(pattern: RoutePattern, handler: RequestHandler): Promise<string> {
    this.assertOpen();
    if (!this._hooks) {
      throw new Error(
        'ctx.route() requires a network interceptor — this BrowserContext was ' +
        'constructed without one. Create the context via browser.newContext().'
      );
    }
    await this._ensurePageTracking();
    // Synthetic id returned to the user. Stable across page churn.
    const syntheticId = `ctx-route-${++BrowserContext._routeCounter}`;
    const entry = { pattern, handler, perPage: new Map<string, string>() };
    this._routes.set(syntheticId, entry);
    // Register intercept on every page that already exists in this context.
    await Promise.all(
      [...this._pageIds].map((pageId) =>
        this._registerRouteOnPage(syntheticId, pageId).catch(() => { })
      )
    );
    return syntheticId;
  }

  /**
   * Remove a route previously registered with {@link route}. With no
   * argument, removes every route registered on this context.
   *
   * @example
   * ```ts
   * const id = await ctx.route('**\/api/feature-flags', mockFlags);
   * // …test runs…
   * await ctx.unroute(id);
   * ```
   */
  async unroute(id?: string): Promise<void> {
    if (!this._hooks) return;
    const net = this._hooks.getNetwork();
    const remove = async (syntheticId: string) => {
      const entry = this._routes.get(syntheticId);
      if (!entry) return;
      this._routes.delete(syntheticId);
      for (const realId of entry.perPage.values()) {
        if (!realId) continue; // placeholder for an in-flight registration
        await net.removeIntercept(realId).catch(() => { });
      }
    };
    if (id) {
      await remove(id);
      return;
    }
    for (const sid of [...this._routes.keys()]) {
      await remove(sid);
    }
  }

  // ── Extra HTTP headers ───────────────────────────────────────────────────

  /**
   * Replace this context's extra-HTTP-headers map. Applied to every
   * currently-open page in this context, and re-applied to each new page
   * that opens afterwards.
   *
   * Pass `{}` to clear.
   *
   * @example
   * ```ts
   * await alice.setExtraHTTPHeaders({ 'X-Tenant': 'acme', 'X-Test': 'true' });
   * ```
   */
  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    this.assertOpen();
    this._config.extraHTTPHeaders = { ...headers };
    await this._ensurePageTracking();
    if (this._pageIds.size > 0) {
      await this._applyExtraHeadersTo([...this._pageIds]);
    }
  }

  // ── Identity & device emulation ──────────────────────────────────────────

  /**
   * Override the locale reported to every page in this context.
   *
   * Mapped to BiDi `emulation.setLocaleOverride` scoped to
   * `userContexts: [this.id]`, so the override applies to every page
   * currently open in this context **and** every page opened later.
   * Pass `null` to clear the override.
   *
   * Cross-browser: works on Chrome and Firefox.
   *
   * @example
   * ```ts
   * // Render the UI in German for a checkout-translation test.
   * await ctx.setLocale('de-DE');
   * const page = await ctx.newPage({ url: '/checkout' });
   * await page.expect(page.find('h1')).toContainText('Kasse');
   * ```
   */
  async setLocale(locale: string | null): Promise<void> {
    this.assertOpen();
    await this.conn.send('emulation.setLocaleOverride', {
      userContexts: [this._id],
      locale,
    });
  }

  /**
   * Override the timezone reported to every page in this context.
   *
   * Mapped to BiDi `emulation.setTimezoneOverride` scoped to
   * `userContexts: [this.id]`. Pass `null` to clear the override.
   * Accepts any IANA timezone id (e.g. `'Europe/Berlin'`,
   * `'America/Los_Angeles'`).
   *
   * Cross-browser: works on Chrome and Firefox.
   *
   * @example
   * ```ts
   * await ctx.setTimezone('Asia/Tokyo');
   * const page = await ctx.newPage({ url: '/dashboard' });
   * // `new Date().getTimezoneOffset()` in the page now reflects JST.
   * ```
   */
  async setTimezone(timezoneId: string | null): Promise<void> {
    this.assertOpen();
    await this.conn.send('emulation.setTimezoneOverride', {
      userContexts: [this._id],
      timezone: timezoneId,
    });
  }

  /**
   * Override `navigator.geolocation` for every page in this context.
   *
   * Mapped to BiDi `emulation.setGeolocationOverride` scoped to
   * `userContexts: [this.id]`. Pass `null` to clear and return to the
   * real device location.
   *
   * The page still has to be granted the `geolocation` permission \u2014 use
   * {@link grantPermissions} once the origin is known.
   *
   * @example
   * ```ts
   * await ctx.setGeolocation({ latitude: 51.5074, longitude: -0.1278 });
   * const page = await ctx.newPage({ url: 'https://app.example.com' });
   * await ctx.grantPermissions(['geolocation'], { origin: 'https://app.example.com' });
   * ```
   */
  async setGeolocation(
    coords: { latitude: number; longitude: number; accuracy?: number } | null
  ): Promise<void> {
    this.assertOpen();
    const params: Record<string, unknown> = { userContexts: [this._id] };
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
    try {
      await this.conn.send('emulation.setGeolocationOverride', params);
    } catch (err) {
      const engine = this._hooks?.getBrowserName?.() ?? 'this browser';
      throw new Error(
        `setGeolocation() failed on ${engine}: ${(err as Error).message}. ` +
        'BiDi `emulation.setGeolocationOverride` coverage is still uneven ' +
        'across engines; Chrome is the reliable target today.'
      );
    }
  }

  /**
   * Grant (or deny) one or more permissions for an origin in this context.
   *
   * Mapped to BiDi `permissions.setPermission` with the `userContext`
   * parameter, so the grant only affects pages inside **this** context.
   * The set of valid permission names is the W3C Permissions catalogue
   * (`'geolocation'`, `'notifications'`, `'clipboard-read'`,
   * `'clipboard-write'`, `'camera'`, `'microphone'`, \u2026).
   *
   * `opts.origin` is required \u2014 BiDi has no "all origins" wildcard.
   * `opts.state` defaults to `'granted'`.
   *
   * @example
   * ```ts
   * await ctx.grantPermissions(['geolocation'], { origin: 'https://app.example.com' });
   * await ctx.grantPermissions(['notifications'], {
   *   origin: 'https://app.example.com',
   *   state: 'denied',
   * });
   * ```
   */
  async grantPermissions(
    permissions: string[],
    opts: { origin: string; state?: 'granted' | 'denied' | 'prompt' }
  ): Promise<void> {
    this.assertOpen();
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new Error('grantPermissions: pass a non-empty array of permission names.');
    }
    if (!opts || typeof opts.origin !== 'string' || opts.origin.length === 0) {
      throw new Error(
        'grantPermissions: `origin` is required \u2014 BiDi `permissions.setPermission` ' +
        'has no "all origins" wildcard.'
      );
    }
    const state = opts.state ?? 'granted';
    for (const name of permissions) {
      try {
        await this.conn.send('permissions.setPermission', {
          descriptor: { name },
          state,
          origin: opts.origin,
          userContext: this._id,
        });
      } catch (err) {
        const engine = this._hooks?.getBrowserName?.() ?? 'this browser';
        throw new Error(
          `grantPermissions(${JSON.stringify(name)}) failed on ${engine}: ` +
          `${(err as Error).message}.`
        );
      }
    }
  }

  /**
   * Reset the listed permissions for an origin back to the browser
   * default (`'prompt'`). Convenience wrapper around
   * {@link grantPermissions} with `state: 'prompt'`.
   */
  async clearPermissions(
    permissions: string[],
    opts: { origin: string }
  ): Promise<void> {
    await this.grantPermissions(permissions, { ...opts, state: 'prompt' });
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Read localStorage for every origin currently open in this context.
   * Returns `{ origin: { key: value, ... }, ... }`.
   */
  private async collectLocalStorage(): Promise<
    Record<string, Record<string, string>>
  > {
    const pages = await this.pages();
    const byOrigin: Record<string, Record<string, string>> = {};
    for (const page of pages) {
      try {
        const url = await page.url();
        if (!url || url === 'about:blank') continue;
        const origin = new URL(url).origin;
        if (byOrigin[origin]) continue; // first page wins
        const entries = await page.evaluate<Record<string, string>>(
          `const out = {};
           for (let i = 0; i < localStorage.length; i++) {
             const k = localStorage.key(i);
             if (k !== null) out[k] = localStorage.getItem(k) ?? '';
           }
           return out;`
        );
        if (entries && Object.keys(entries).length > 0) {
          byOrigin[origin] = entries;
        }
      } catch {
        // Page may have been closed mid-snapshot; skip.
      }
    }
    return byOrigin;
  }

  /**
   * Seed localStorage for each captured origin exactly once.
   *
   * BiDi has no command to set localStorage for an arbitrary origin, so we
   * visit each origin in a throwaway top-level context whose navigation is
   * fulfilled locally (never reaching the network), write the entries, and
   * close it. Unlike a preload script this runs once — the application owns the
   * values afterward, so its own writes survive a reload.
   *
   * The private context is created at the connection level (not via `newPage`),
   * so it never enters `_pageIds`, the `'page'` event, routes, or active-page
   * selection. The intercept is scoped to it, and navigation is forced onto
   * BiDi — a Classic-initiated navigation would stall against a BiDi intercept.
   */
  private async _hydrateLocalStorage(
    byOrigin: Record<string, Record<string, string>>,
    errorContext: StorageStateErrorContext
  ): Promise<boolean> {
    const origins = Object.keys(byOrigin).filter(
      (o) => byOrigin[o] && Object.keys(byOrigin[o]).length > 0
    );
    if (origins.length === 0) return false;

    const net = this._hooks?.getNetwork();
    if (!net) {
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        'restoring localStorage requires a BiDi session with network interception',
        { detail: storageStateDetail(errorContext, 'setup', { section: 'localStorage' }) }
      );
    }

    // Reserve the internal-context slot before the create so page tracking hides
    // it even if its contextCreated event beats the create response.
    this._internalCreateInFlight++;
    let privId: string | undefined;
    try {
      const created = await this.conn.send<{ context: string }>('browsingContext.create', {
        type: 'tab',
        userContext: this._id,
      });
      privId = created.context;
      this._internalPageIds.add(privId);
    } catch (err) {
      throw this._restoreDriverError(err, errorContext, 'localStorage', false);
    } finally {
      this._internalCreateInFlight--;
      this._drainQuarantine();
      this._resolveInternalClassificationWaiters();
    }
    if (!privId) return false;
    const priv = new Page(this.driver, privId, this.getDefaultTimeout, this.conn, this);

    let interceptId: string | undefined;
    let partialApplied = false;
    try {
      // Fulfil this private context's top-level navigations with a minimal
      // document, locally — the request never reaches the network. The pattern
      // is specific (a bare `**/*` does not register a working intercept): only
      // this context's deterministic hydrate URL is fulfilled, and the intercept
      // is scoped to `privId`, so no user page is ever touched.
      interceptId = await net.intercept(
        `**${AUTH_STATE_HYDRATE_PATH}*`,
        () => ({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<!doctype html><html><head></head><body></body></html>',
        }),
        ['beforeRequestSent'],
        [privId],
        { strict: true } // never let a hydration request reach the real network
      );

      for (const origin of origins) {
        // The path is fixed and irrelevant — the intercept fulfils it locally.
        // `domcontentloaded` forces the BiDi navigate path so the intercept
        // applies (a default-context Classic `load` navigation would stall).
        await priv.navigateTo(`${origin}${AUTH_STATE_HYDRATE_PATH}`, {
          waitUntil: 'domcontentloaded',
        });
        // Confirm the realm is on the requested origin (an HSTS upgrade or other
        // rewrite could land elsewhere), then write the entries in one call. The
        // values travel as structured string arguments — never interpolated into
        // the source; the source is a string, so the DOM globals it names are the
        // browser's, not Node's.
        const res = await this.conn.send<{ type: string; result?: { value?: unknown } }>(
          'script.callFunction',
          {
            functionDeclaration:
              'function (expected, json) {' +
              ' if (location.origin !== expected) return "MISMATCH:" + location.origin;' +
              ' var e = JSON.parse(json);' +
              ' for (var k in e) localStorage.setItem(k, e[k]);' +
              ' return "OK"; }',
            target: { context: privId },
            arguments: [
              { type: 'string', value: origin },
              { type: 'string', value: JSON.stringify(byOrigin[origin]) },
            ],
            awaitPromise: false,
          }
        );
        const value = res.type === 'success' ? res.result?.value : undefined;
        if (value !== 'OK') {
          const mismatch = new CraftdriverError(
            ErrorCode.STATE_INVALID,
            `could not hydrate localStorage for origin ${origin}`,
            { detail: storageStateDetail(errorContext, 'localStorage', { origin }) }
          );
          if (!partialApplied) throw mismatch;
          throw this._restoreDriverError(mismatch, errorContext, 'localStorage', true, { origin });
        }
        partialApplied = true;
      }
      return partialApplied;
    } catch (err) {
      if (isStorageStateError(err)) throw err;
      throw this._restoreDriverError(err, errorContext, 'localStorage', partialApplied);
    } finally {
      if (interceptId) await net.removeIntercept(interceptId).catch(() => {});
      await this.conn.send('browsingContext.close', { context: privId }).catch(() => {});
    }
  }

  /** @internal Serialize restores without coupling independent user contexts. */
  _runSerializedRestore<T>(task: () => Promise<T>): Promise<T> {
    const run = this._restoreTail.then(task, task);
    this._restoreTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** @internal Synchronous filter for events emitted after an internal id is known. */
  _isInternalPageId(id: string | null | undefined): boolean {
    return typeof id === 'string' && this._internalPageIds.has(id);
  }

  /** @internal Wait through the create-response race, then classify an event id. */
  async _isInternalPageContext(id: string): Promise<boolean> {
    await this._waitForInternalClassification();
    return this._internalPageIds.has(id);
  }

  private _waitForInternalClassification(): Promise<void> {
    if (this._internalCreateInFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this._internalClassificationWaiters.add(resolve));
  }

  private _resolveInternalClassificationWaiters(): void {
    if (this._internalCreateInFlight !== 0) return;
    for (const resolve of this._internalClassificationWaiters) resolve();
    this._internalClassificationWaiters.clear();
  }

  private _storageStateErrorContext(operation: string): StorageStateErrorContext {
    return {
      operation,
      browserName: this._hooks?.getBrowserName?.() ?? 'unknown',
      protocol: 'bidi',
    };
  }

  private _restoreDriverError(
    cause: unknown,
    context: StorageStateErrorContext,
    phase: string,
    partialApplied: boolean,
    extra?: Record<string, unknown>
  ): CraftdriverError {
    return new CraftdriverError(
      ErrorCode.DRIVER_ERROR,
      `storage state restore failed while applying ${phase}`,
      {
        cause,
        detail: storageStateDetail(context, phase, { partialApplied, ...extra }),
        hint: partialApplied
          ? 'Restore into a fresh browser context when failure isolation is required.'
          : undefined,
      }
    );
  }

  /**
   * Subscribe (once) to BiDi page-creation / page-destruction events and
   * seed `_pageIds` with currently-open pages in this context. Powers
   * both the `'page'` event and route membership filtering.
   */
  /** Apply the normal new-page handling (tracking, headers, routes, the `'page'`
   *  event) for a real top-level context. */
  private _handleContextCreated(id: string): void {
    this._pageIds.add(id);
    // Headers must be applied before the first request from this page.
    this._applyExtraHeadersTo([id]).catch(() => { });
    // Register every existing route on the new page.
    for (const sid of this._routes.keys()) {
      this._registerRouteOnPage(sid, id).catch(() => { });
    }
    // Notify page listeners exactly once per page.
    if (this._notifiedPageIds.has(id)) return;
    this._notifiedPageIds.add(id);
    if (this._pageListeners.size > 0) {
      const page = new Page(this.driver, id, this.getDefaultTimeout, this.conn, this);
      for (const fn of this._pageListeners) {
        try { fn(page); } catch { /* listener errors must not break events */ }
      }
    }
  }

  /** Replay contextCreated events buffered during an internal create, once none
   *  is in flight — dropping any that turned out to be internal. */
  private _drainQuarantine(): void {
    if (this._internalCreateInFlight > 0) return;
    const buffered = this._quarantinedCreated;
    this._quarantinedCreated = [];
    for (const params of buffered) {
      const id = params.context as string;
      if (this._internalPageIds.has(id)) continue; // internal → stay hidden
      this._handleContextCreated(id);
    }
  }

  private _ensurePageTracking(): Promise<void> {
    if (this._closed) return Promise.resolve();
    if (this._trackingPromise) return this._trackingPromise;
    this._trackingPromise = this._startPageTracking();
    return this._trackingPromise;
  }

  private async _startPageTracking(): Promise<void> {
    // No `subscribe()` here: `browsingContext.contextCreated`/`contextDestroyed`
    // are already subscribed session-wide in `BiDiSession.connect()`'s batch,
    // and this method can only run once BiDi is connected. Handlers register
    // independently via `conn.on(...)` below, so we just attach them.
    const onCreated = (params: Record<string, unknown>) => {
      if (params.parent) return; // nested frames
      if (params.userContext !== this._id) return;
      const id = params.context as string;
      // Internal hydration context — stays invisible to page tracking.
      if (this._internalPageIds.has(id)) return;
      // Its id may not be known yet (the event can beat the create response):
      // quarantine every top-level create in this context while one is in
      // flight, then drop the internal one and replay the rest.
      if (this._internalCreateInFlight > 0) {
        this._quarantinedCreated.push(params);
        return;
      }
      this._handleContextCreated(id);
    };
    const onDestroyed = (params: Record<string, unknown>) => {
      if (params.parent) return;
      const id = params.context as string;
      if (this._internalPageIds.has(id)) {
        return; // internal hydration context — never tracked, nothing to tear down
      }
      this._pageIds.delete(id);
      this._notifiedPageIds.delete(id);
      // Tear down any per-page intercepts registered against this page.
      const net = this._hooks?.getNetwork();
      for (const entry of this._routes.values()) {
        const realId = entry.perPage.get(id);
        if (realId && net) {
          entry.perPage.delete(id);
          net.removeIntercept(realId).catch(() => { });
        } else if (realId === '') {
          // In-flight registration — drop the placeholder; the registration
          // will detect the missing page and clean itself up.
          entry.perPage.delete(id);
        }
      }
    };

    this._trackingOffs.push(this.conn.on('browsingContext.contextCreated', onCreated));
    this._trackingOffs.push(this.conn.on('browsingContext.contextDestroyed', onDestroyed));

    // Seed with currently-open pages AFTER handlers are attached so we don't
    // miss a contextCreated event that races with this seeding.
    try {
      const tree = await this.conn.send<{ contexts: BrowsingContextInfo[] }>(
        'browsingContext.getTree',
        { maxDepth: 0 }
      );
      await this._waitForInternalClassification();
      for (const c of tree.contexts ?? []) {
        if (
          c.userContext === this._id &&
          !c.parent &&
          !this._internalPageIds.has(c.context)
        ) {
          this._pageIds.add(c.context);
        }
      }
    } catch { /* not fatal — set will fill from events */ }
  }

  /**
   * Push the current `extraHTTPHeaders` onto a specific set of page ids.
   * No-op when no headers are configured.
   */
  private async _applyExtraHeadersTo(contexts: string[]): Promise<void> {
    const headers = this._config.extraHTTPHeaders;
    if (!headers || Object.keys(headers).length === 0 || contexts.length === 0) return;
    if (!this._hooks) return;
    await this._hooks.getNetwork().setExtraHeaders(headers, contexts);
  }

  /**
   * Register a single route's BiDi intercept against one page id. Records
   * the live intercept id in the route's `perPage` map so it can be
   * cleaned up when the page closes or the route is removed.
   *
   * Reserves the slot synchronously (before awaiting `intercept`) so that
   * concurrent callers — typically `newPage()` and the `contextCreated`
   * event firing for the same page — don't both create an intercept.
   */
  private async _registerRouteOnPage(syntheticId: string, pageId: string): Promise<void> {
    const entry = this._routes.get(syntheticId);
    if (!entry || !this._hooks) return;
    if (entry.perPage.has(pageId)) return;
    // Reserve before the await with a placeholder so a parallel registration
    // call observes `perPage.has(pageId)` === true and bails out early.
    entry.perPage.set(pageId, '');
    try {
      const realId = await this._hooks.getNetwork().intercept(
        entry.pattern,
        entry.handler,
        ['beforeRequestSent'],
        [pageId]
      );
      // The route may have been unrouted, or the page destroyed (which
      // clears the placeholder via `onDestroyed`), while we were awaiting.
      // In either case, drop the intercept and leave no stale entry behind.
      if (!this._routes.has(syntheticId) || !this._pageIds.has(pageId)) {
        entry.perPage.delete(pageId);
        await this._hooks.getNetwork().removeIntercept(realId).catch(() => { });
        return;
      }
      entry.perPage.set(pageId, realId);
    } catch (err) {
      // Roll back the placeholder so a later retry can succeed.
      if (entry.perPage.get(pageId) === '') entry.perPage.delete(pageId);
      throw err;
    }
  }
}

// ── Module-private helpers ─────────────────────────────────────────────────

function normalizeCookie(raw: RawNetworkCookie): Cookie {
  return {
    name: raw.name,
    value: typeof raw.value === 'string' ? raw.value : raw.value.value,
    domain: raw.domain,
    path: raw.path,
    size: raw.size,
    httpOnly: raw.httpOnly,
    secure: raw.secure,
    sameSite: raw.sameSite,
    expiry: raw.expiry,
  };
}

/** Would `cookie` be sent on a request to `url`? RFC-6265 domain/path match (best effort). */
function cookieMatchesUrl(cookie: Cookie, url: URL): boolean {
  const cookieDomain = cookie.domain.replace(/^\./, '').toLowerCase();
  const reqHost = url.hostname.toLowerCase();
  const domainOk = reqHost === cookieDomain || reqHost.endsWith('.' + cookieDomain);
  if (!domainOk) return false;

  const cookiePath = cookie.path || '/';
  const reqPath = url.pathname || '/';
  const pathOk =
    cookiePath === '/' ||
    reqPath === cookiePath ||
    reqPath.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/');
  if (!pathOk) return false;

  if (cookie.secure && url.protocol !== 'https:') return false;

  return true;
}
