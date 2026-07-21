/**
 * BiDi Network Interceptor
 * Provides request interception, mocking, and modification capabilities
 */

import type { BiDiConnection } from './connection.js';
import { DEFAULT_NAVIGATION_TIMEOUT_MS } from '../timing.js';
import type {
  BrowsingContext,
  InterceptPhase,
  NetworkBeforeRequestSentEvent,
  NetworkResponseEvent,
  NetworkIntercept,
  NetworkHeader,
  UrlPattern,
} from './types.js';

export interface MockResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | object;
}

export interface RequestHandler {
  (request: InterceptedRequest): MockResponse | void | Promise<MockResponse | void>;
}

export interface InterceptedRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  resourceType?: string;
  isBlocked: boolean;
  context: BrowsingContext | null;
}

export interface InterceptedResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
  fromCache: boolean;
  request: Pick<InterceptedRequest, 'id' | 'url' | 'method' | 'headers'>;
}

export interface InterceptRule {
  id: NetworkIntercept;
  patterns: UrlPattern[];
  phases: InterceptPhase[];
  handler?: RequestHandler;
  /**
   * Internal strict mode: on a handler or `provideResponse` failure, fail the
   * request rather than continuing it to the real network. Used by trusted
   * internal intercepts (e.g. storage hydration) that must own every request
   * they match — a fall-through would leak the request to the origin server.
   */
  strict?: boolean;
}

export class NetworkInterceptor {
  private connection: BiDiConnection;
  private intercepts = new Map<string, InterceptRule>();
  private handlers = new Map<string, RequestHandler>();
  private subscribed = false;
  private handlersWired = false;
  private context?: BrowsingContext;
  private requestListeners: Array<(req: InterceptedRequest) => void> = [];
  private responseListeners: Array<(res: InterceptedResponse) => void> = [];
  private isInternalContext: (context: BrowsingContext | null | undefined) => boolean = () => false;
  private internalRequestIds = new Set<string>();
  /** Set of request IDs currently in-flight (sent but not yet completed/errored). */
  private inFlightRequests = new Set<string>();
  /** Callbacks to notify when inFlightRequests changes — used by waitForNetworkIdle. */
  private idleListeners: Array<() => void> = [];

  constructor(connection: BiDiConnection, context?: BrowsingContext) {
    this.connection = connection;
    this.context = context;
  }

  /** @internal Exclude library-owned contexts from public network observation. */
  setInternalContextPredicate(
    predicate: (context: BrowsingContext | null | undefined) => boolean
  ): void {
    this.isInternalContext = predicate;
  }

  /**
   * Mark the WS subscription as already armed — e.g. done as part of
   * `BiDiSession.connect()`'s merged connect-time batch — without sending a
   * redundant `session.subscribe`. Event handlers still need wiring;
   * `initialize()` remains the thing to call before relying on events, but
   * its subscribe step becomes a same-tick no-op.
   */
  markSubscribed(): void {
    this.subscribed = true;
  }

  /**
   * Initialize network event subscriptions
   */
  async initialize(): Promise<void> {
    if (this.handlersWired) return;

    if (!this.subscribed) {
      // Subscribe to network events
      await this.connection.subscribe([
        'network.beforeRequestSent',
        'network.responseStarted',
        'network.responseCompleted',
        'network.fetchError',
        'network.authRequired',
      ]);
      this.subscribed = true;
    }

    // Handle intercepted requests + track in-flight
    this.connection.on('network.beforeRequestSent', async (params) => {
      const event = params as unknown as NetworkBeforeRequestSentEvent;
      const internal = this.isInternalContext(event.context);
      if (internal) this.internalRequestIds.add(event.request.request);
      else this.inFlightRequests.add(event.request.request);
      await this.handleBeforeRequestSent(event);
      // Notify passive request listeners (waitForRequest)
      if (!internal && this.requestListeners.length > 0) {
        const req: InterceptedRequest = {
          id: event.request.request,
          url: event.request.url,
          method: event.request.method,
          headers: this.headersToObject(event.request.headers),
          isBlocked: event.isBlocked,
          context: event.context,
        };
        for (const l of [...this.requestListeners]) l(req);
      }
    });

    // Track completed responses + notify waitForResponse listeners
    this.connection.on('network.responseCompleted', (params) => {
      const event = params as unknown as NetworkResponseEvent;
      if (this.internalRequestIds.delete(event.request.request)) return;
      this.inFlightRequests.delete(event.request.request);
      this._notifyIdleListeners();
      if (this.responseListeners.length > 0) {
        const res: InterceptedResponse = {
          url: event.response.url,
          status: event.response.status,
          statusText: event.response.statusText,
          headers: this.headersToObject(event.response.headers),
          mimeType: event.response.mimeType,
          fromCache: event.response.fromCache,
          request: {
            id: event.request.request,
            url: event.request.url,
            method: event.request.method,
            headers: this.headersToObject(event.request.headers),
          },
        };
        for (const l of [...this.responseListeners]) l(res);
      }
    });

    // Track fetch errors (request failed before a response)
    this.connection.on('network.fetchError', (params) => {
      const reqId = (params as Record<string, Record<string, string>>)?.request?.request;
      if (reqId) {
        if (this.internalRequestIds.delete(reqId)) return;
        this.inFlightRequests.delete(reqId);
        this._notifyIdleListeners();
      }
    });

    this.handlersWired = true;
  }

  /**
   * Add a network intercept for specific URL patterns
   */
  async intercept(
    patterns: string | string[] | UrlPattern | UrlPattern[],
    handler: RequestHandler,
    phases: InterceptPhase[] = ['beforeRequestSent'],
    contexts?: BrowsingContext[],
    opts?: { strict?: boolean }
  ): Promise<string> {
    await this.initialize();

    const urlPatterns = this.normalizePatterns(patterns);

    const ctxs = contexts ?? (this.context ? [this.context] : undefined);
    const result = await this.connection.send<{ intercept: string }>('network.addIntercept', {
      phases,
      urlPatterns,
      ...(ctxs ? { contexts: ctxs } : {}),
    });

    const interceptId = result.intercept;

    this.intercepts.set(interceptId, {
      id: interceptId,
      patterns: urlPatterns,
      phases,
      handler,
      strict: opts?.strict,
    });

    this.handlers.set(interceptId, handler);

    return interceptId;
  }

  /**
   * Mock all requests matching pattern with a fixed response
   */
  async mock(
    pattern: string | string[] | UrlPattern | UrlPattern[],
    response: MockResponse | ((req: InterceptedRequest) => MockResponse)
  ): Promise<string> {
    const handler: RequestHandler = (req) => {
      if (typeof response === 'function') {
        return response(req);
      }
      return response;
    };

    return this.intercept(pattern, handler);
  }

  /**
   * Block all requests matching pattern
   */
  async block(pattern: string | string[]): Promise<string> {
    return this.intercept(pattern, () => ({
      status: 0,
      body: '',
    }));
  }

  /**
   * Modify request headers for matching patterns
   */
  async setExtraHeaders(
    headers: Record<string, string>,
    contexts?: BrowsingContext[]
  ): Promise<void> {
    const headerList: NetworkHeader[] = Object.entries(headers).map(([name, value]) => ({
      name,
      value: { type: 'string', value },
    }));

    await this.connection.send('network.setExtraHeaders', {
      headers: headerList,
      ...(contexts ? { contexts } : {}),
    });
  }

  /**
   * Continue a blocked request (optionally with modifications)
   */
  async continueRequest(
    requestId: string,
    options?: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<void> {
    const params: Record<string, unknown> = { request: requestId };

    if (options?.url) params.url = options.url;
    if (options?.method) params.method = options.method;
    if (options?.headers) {
      params.headers = Object.entries(options.headers).map(([name, value]) => ({
        name,
        value: { type: 'string', value },
      }));
    }
    if (options?.body) {
      params.body = { type: 'string', value: options.body };
    }

    await this.connection.send('network.continueRequest', params);
  }

  /**
   * Provide a custom response for a blocked request
   */
  async provideResponse(requestId: string, response: MockResponse): Promise<void> {
    const params: Record<string, unknown> = { request: requestId };

    if (response.status !== undefined) params.statusCode = response.status;
    if (response.statusText) params.reasonPhrase = response.statusText;
    if (response.headers) {
      params.headers = Object.entries(response.headers).map(([name, value]) => ({
        name,
        value: { type: 'string', value },
      }));
    }
    if (response.body !== undefined) {
      let bodyStr: string;
      let bodyType: 'string' | 'base64' = 'string';

      if (typeof response.body === 'string') {
        bodyStr = response.body;
      } else if (Buffer.isBuffer(response.body)) {
        bodyStr = response.body.toString('base64');
        bodyType = 'base64';
      } else {
        // Object - serialize as JSON
        bodyStr = JSON.stringify(response.body);
      }
      params.body = { type: bodyType, value: bodyStr };
    }

    await this.connection.send('network.provideResponse', params);
  }

  /**
   * Fail a blocked request
   */
  async failRequest(requestId: string): Promise<void> {
    await this.connection.send('network.failRequest', { request: requestId });
  }

  /**
   * Number of network requests currently in-flight (sent but no response yet).
   * Used to implement `waitForNetworkIdle`.
   */
  get inFlightCount(): number {
    return this.inFlightRequests.size;
  }

  /**
   * Resolves when no network requests have been in-flight for `idleDuration` ms.
   * Event-driven: subscribes to network events internally; no polling.
   *
   * @param idleDuration Milliseconds of network silence required (default: 500)
   */
  async waitForNetworkIdle(opts?: { idleDuration?: number; timeout?: number }): Promise<void> {
    await this.initialize();
    // Validate-or-fallback to bound timer durations (defends against resource
    // exhaustion from a hostile / buggy caller). CodeQL does not treat
    // Math.min as a sanitizer, so we use explicit range checks.
    const MAX_IDLE_MS = 60_000;
    const MAX_TIMEOUT_MS = 300_000;
    const reqIdle = opts?.idleDuration;
    const reqTimeout = opts?.timeout;
    const idleDuration =
      typeof reqIdle === 'number' && reqIdle >= 0 && reqIdle <= MAX_IDLE_MS ? reqIdle : 500;
    const timeout =
      typeof reqTimeout === 'number' && reqTimeout >= 0 && reqTimeout <= MAX_TIMEOUT_MS
        ? reqTimeout
        : 30_000;

    return new Promise<void>((resolve, reject) => {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const timeoutTimer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitForNetworkIdle() timed out after ${timeout}ms`));
      }, timeout);

      const scheduleIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (this.inFlightRequests.size === 0) {
          idleTimer = setTimeout(() => { cleanup(); resolve(); }, idleDuration);
        }
      };

      const onNetworkChange = () => scheduleIdle();

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (idleTimer) clearTimeout(idleTimer);
        this.idleListeners = this.idleListeners.filter(l => l !== onNetworkChange);
      };

      this.idleListeners.push(onNetworkChange);
      // Kick off immediately in case already idle
      scheduleIdle();
    });
  }

  private _notifyIdleListeners(): void {
    for (const l of [...this.idleListeners]) l();
  }

  /**
   * Subscribe to **every** matching request or response. Returns an
   * `off()` function that unsubscribes the listener.
   *
   * Unlike {@link waitForRequest} / {@link waitForResponse}, this is
   * persistent — the callback fires for the lifetime of the browser
   * session (or until you call `off()`).
   *
   * @example
   * const off = network.on('response', (res) => {
   *   console.log(res.status, res.url);
   * });
   * // …
   * off();
   */
  on(event: 'request', listener: (req: InterceptedRequest) => void): () => void;
  on(event: 'response', listener: (res: InterceptedResponse) => void): () => void;
  on(
    event: 'request' | 'response',
    listener: ((req: InterceptedRequest) => void) | ((res: InterceptedResponse) => void)
  ): () => void {
    if (event === 'request') {
      const fn = listener as (req: InterceptedRequest) => void;
      this.requestListeners.push(fn);
      // Ensure subscriptions are active so events arrive
      this.initialize().catch(() => { /* surfaced elsewhere */ });
      return () => {
        this.requestListeners = this.requestListeners.filter((l) => l !== fn);
      };
    }
    const fn = listener as (res: InterceptedResponse) => void;
    this.responseListeners.push(fn);
    this.initialize().catch(() => { /* surfaced elsewhere */ });
    return () => {
      this.responseListeners = this.responseListeners.filter((l) => l !== fn);
    };
  }

  /**
   * Wait for the first request matching a URL glob or predicate.
   * Must be registered **before** the action that triggers the request.
   */
  waitForRequest(
    pattern: string | ((req: InterceptedRequest) => boolean),
    opts?: { timeout?: number }
  ): Promise<InterceptedRequest> {
    return this._waitFor('request', pattern as string | ((v: InterceptedRequest | InterceptedResponse) => boolean), opts) as Promise<InterceptedRequest>;
  }

  /**
   * Wait for the first completed response matching a URL glob or predicate.
   * Must be registered **before** the action that triggers the request.
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
    return this._waitFor('response', pattern as string | ((v: InterceptedRequest | InterceptedResponse) => boolean), opts) as Promise<InterceptedResponse>;
  }

  private _waitFor(
    kind: 'request' | 'response',
    pattern: string | ((v: InterceptedRequest | InterceptedResponse) => boolean),
    opts?: { timeout?: number }
  ): Promise<InterceptedRequest | InterceptedResponse> {
    const timeout = opts?.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    const matcher =
      typeof pattern === 'function'
        ? pattern
        : (v: { url: string }) => this._matchesGlob(v.url, pattern as string);

    return new Promise((resolve, reject) => {
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        const desc = typeof pattern === 'string' ? `"${pattern}"` : '[predicate]';
        reject(new Error(`waitFor${kind === 'request' ? 'Request' : 'Response'}(${desc}) timed out after ${timeout}ms`));
      }, timeout);

      const listener = (v: InterceptedRequest | InterceptedResponse) => {
        if (done) return;
        if (matcher(v as InterceptedRequest & InterceptedResponse)) {
          done = true;
          cleanup();
          resolve(v as InterceptedRequest & InterceptedResponse);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        if (kind === 'request') {
          this.requestListeners = this.requestListeners.filter(l => l !== listener);
        } else {
          this.responseListeners = this.responseListeners.filter(l => l !== listener);
        }
      };

      if (kind === 'request') {
        this.requestListeners.push(listener as (req: InterceptedRequest) => void);
      } else {
        this.responseListeners.push(listener as (res: InterceptedResponse) => void);
      }

      // Ensure we are subscribed so events arrive
      this.initialize().catch(reject);
    });
  }

  private _matchesGlob(url: string, pattern: string): boolean {
    // Re-use the same logic as normalizePatterns but do a JS-side string match
    // so callers can use Playwright-style ** globs without relying on BiDi
    // pattern registration.
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url;
    }
    if (pattern.includes('**') || pattern.includes('*')) {
      let pat = pattern;
      pat = pat.replace(/^\*\*/, '');
      pat = pat.replace(/\/?\*\*$/, '');
      pat = pat.replace(/\/?\*$/, '');
      pat = pat.replace(/\*/g, '');
      if (!pat.startsWith('/')) pat = '/' + pat;
      pat = pat.replace(/\/+/g, '/');
      return pathname.includes(pat);
    }
    // Exact string match against full URL
    return url === pattern || url.startsWith(pattern);
  }

  /**
   * Remove an intercept
   */
  async removeIntercept(interceptId: string): Promise<void> {
    await this.connection.send('network.removeIntercept', { intercept: interceptId });
    this.intercepts.delete(interceptId);
    this.handlers.delete(interceptId);
  }

  /**
   * Remove all intercepts
   */
  async removeAllIntercepts(): Promise<void> {
    const ids = [...this.intercepts.keys()];
    for (const id of ids) {
      await this.removeIntercept(id);
    }
  }

  /**
   * Set cache behavior
   */
  async setCacheBehavior(
    behavior: 'default' | 'bypass',
    contexts?: BrowsingContext[]
  ): Promise<void> {
    await this.connection.send('network.setCacheBehavior', {
      cacheBehavior: behavior,
      ...(contexts ? { contexts } : {}),
    });
  }

  private async handleBeforeRequestSent(event: NetworkBeforeRequestSentEvent): Promise<void> {
    if (!event.isBlocked || !event.intercepts?.length) return;

    const requestId = event.request.request;
    const internal = this.isInternalContext(event.context);
    // Internal contexts are owned by strict library intercepts. Never invoke a
    // user's browser-global mock/route for those requests, even when its URL
    // pattern also matches the reserved hydration URL.
    const interceptIds = internal
      ? event.intercepts.filter((id) => this.intercepts.get(id)?.strict === true)
      : event.intercepts;

    // Find matching handler
    for (const interceptId of interceptIds) {
      const handler = this.handlers.get(interceptId);
      if (!handler) continue;

      const interceptedRequest: InterceptedRequest = {
        id: requestId,
        url: event.request.url,
        method: event.request.method,
        headers: this.headersToObject(event.request.headers),
        isBlocked: event.isBlocked,
        context: event.context,
      };

      const strict = this.intercepts.get(interceptId)?.strict === true;
      try {
        const result = await handler(interceptedRequest);

        if (result) {
          // Provide mock response
          await this.provideResponse(requestId, result);
        } else if (strict) {
          // A strict internal intercept must own every request it matches — a
          // handler returning nothing is a bug, not a pass-through.
          await this.failRequest(requestId);
        } else {
          // Continue with original request
          await this.continueRequest(requestId);
        }
        return;
      } catch (err) {
        if (strict) {
          // Never fall through to the real network for a strict internal
          // intercept: fail the request so the caller sees the error rather
          // than a surprise real response reaching the origin server.
          await this.failRequest(requestId).catch(() => { });
          return;
        }
        console.error('Error in network intercept handler:', err);
        await this.continueRequest(requestId);
        return;
      }
    }

    // A library-owned request without its strict owner must never escape to the
    // real origin. Public requests retain the normal pass-through behavior.
    if (internal) await this.failRequest(requestId);
    else await this.continueRequest(requestId);
  }

  private normalizePatterns(patterns: string | string[] | UrlPattern | UrlPattern[]): UrlPattern[] {
    // Handle single UrlPattern object
    if (typeof patterns === 'object' && !Array.isArray(patterns) && 'type' in patterns) {
      return [patterns];
    }
    const arr = Array.isArray(patterns) ? patterns : [patterns];
    return arr.map((p) => {
      if (typeof p === 'string') {
        // BiDi URL patterns don't support wildcards - they use exact component matching
        // Extract pathname from glob-style patterns for simple prefix matching
        if (p.includes('**') || p.includes('*')) {
          // Extract pathname from glob pattern
          // e.g., "**/api/users" -> pathname: "/api/users"
          // Note: BiDi will only match exact pathnames, not prefixes
          let pathname = p;
          // Remove leading **
          pathname = pathname.replace(/^\*\*/, '');
          // Remove trailing wildcards (can't do prefix matching in BiDi)
          pathname = pathname.replace(/\/?\*\*$/, '');
          pathname = pathname.replace(/\/?\*$/, '');
          // Remove any remaining wildcards
          pathname = pathname.replace(/\*/g, '');
          if (!pathname.startsWith('/')) {
            pathname = '/' + pathname;
          }
          // Clean up double slashes
          pathname = pathname.replace(/\/+/g, '/');
          return {
            type: 'pattern' as const,
            pathname,
          };
        }
        // For full URLs, use UrlPatternString
        return { type: 'string' as const, pattern: p };
      }
      return p;
    });
  }

  private headersToObject(headers: NetworkHeader[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const h of headers) {
      result[h.name] = h.value.value;
    }
    return result;
  }
}
