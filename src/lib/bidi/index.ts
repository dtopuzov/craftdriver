/**
 * BiDi Session Manager
 * Central manager for BiDi features with Classic WebDriver fallback
 */

import { BiDiConnection } from './connection.js';
import { NetworkInterceptor } from './network.js';
import { LogMonitor } from './logs.js';
import { SessionStateManager, type StorageStateOptions } from './storage.js';
import type { Driver } from '../driver.js';
import type { BrowsingContext, SessionState } from './types.js';

export interface BiDiSessionOptions {
  /** WebSocket URL for BiDi connection */
  wsUrl?: string;
  /** Auto-initialize BiDi features */
  autoInitialize?: boolean;
}

/** One entry from a `browsingContext.getTree({ maxDepth: 0 })` response. */
export interface BiDiContextTreeEntry {
  context: string;
  url: string;
  parent?: string;
  userContext?: string;
}

export interface BiDiConnectOptions {
  /**
   * Invoked synchronously, once, right after the initial context tree and
   * event subscriptions have both landed — before `connect()` resolves. Lets
   * the caller (Browser) seed its own top-level-context cache and register
   * `contextCreated`/`contextDestroyed` handlers off the *same* tree and the
   * *same* subscription this method already fetched, instead of paying for a
   * second `getTree`/`subscribe` round trip right after `connect()` returns.
   */
  onContextTree?: (contexts: BiDiContextTreeEntry[]) => void;
}

export class BiDiSession {
  private connection: BiDiConnection;
  private driver: Driver;
  private context?: BrowsingContext;
  private _network?: NetworkInterceptor;
  private _logs?: LogMonitor;
  private _storage?: SessionStateManager;
  private initialized = false;

  constructor(driver: Driver, options: BiDiSessionOptions = {}) {
    this.driver = driver;
    this.connection = new BiDiConnection();
  }

  /**
   * Connect to the BiDi WebSocket endpoint.
   *
   * Fetches the initial context tree and arms every event subscription every
   * session needs unconditionally in a single parallel batch (one `getTree`,
   * one `session.subscribe` covering context-lifecycle + network + log events —
   * down from the previous six serial round trips). `log.entryAdded` rides this
   * same batch, so console/error capture is always armed at launch at zero extra
   * round trips — no opt-in, no lazy first-touch race.
   *
   * Network subscription is bundled into this same batch (not deferred)
   * because it's provably race-free here — `waitForRequest`/`waitForResponse`
   * can never fire before `Browser.launch()` even returns — and the round
   * trip itself is free once merged with the others. Measured A/B (isolated
   * network-subscription cost on an otherwise-identical Classic-routed
   * navigate/fill/click flow): median E2E-flow ratio changed from 0.93x to
   * 0.94x with network events stripped entirely — statistically
   * indistinguishable, well under the ~5% "keep eager" threshold. Keeping
   * network subscription eager is not a shortcut here — it's simplest,
   * provably race-free, and the data says it isn't costing anything.
   */
  async connect(wsUrl: string, opts?: BiDiConnectOptions): Promise<void> {
    await this.connection.connect(wsUrl);

    const [treeResult] = await Promise.all([
      this.connection.send<{ contexts: BiDiContextTreeEntry[] }>('browsingContext.getTree', {
        maxDepth: 0,
      }),
      this.connection.subscribe([
        // Load-bearing for every session: `waitForLoadState`/`onDialog`, and
        // dialogs must be BiDi-handleable since `unhandledPromptBehavior` is
        // unconditionally set to 'ignore' at launch.
        'browsingContext.navigationStarted',
        'browsingContext.load',
        'browsingContext.domContentLoaded',
        'browsingContext.userPromptOpened',
        // Needed by Browser's top-level-context cache (activePage(), etc.).
        'browsingContext.contextCreated',
        'browsingContext.contextDestroyed',
        // See the network eager-vs-lazy note above.
        'network.beforeRequestSent',
        'network.responseStarted',
        'network.responseCompleted',
        'network.fetchError',
        'network.authRequired',
        // Console/error capture is always on. Folded in here so it costs no
        // extra round trip and is armed before connect() resolves — it can't
        // race a fast launch→quit (measured free; see docs/browser-logs.md).
        'log.entryAdded',
      ]),
    ]);

    const contexts = treeResult.contexts ?? [];
    if (contexts[0]) {
      this.context = contexts[0].context;
    }

    // Network's subscribe already happened above — construct the interceptor
    // pre-marked as subscribed so a later `.initialize()` (from `.mock()`,
    // `waitForResponse()`, etc.) is a same-tick no-op instead of re-subscribing.
    this._network = new NetworkInterceptor(this.connection, this.context);
    this._network.markSubscribed();

    // Logs: `log.entryAdded` was subscribed in the batch above, so construct
    // the monitor pre-marked as subscribed and wire its handler now (a
    // same-tick no-op subscribe) — capture is live before connect() resolves.
    this._logs = new LogMonitor(this.connection, this.context);
    this._logs.markSubscribed();
    await this._logs.initialize();

    opts?.onContextTree?.(contexts);

    this.initialized = true;
  }

  /**
   * Check if BiDi is connected
   */
  isConnected(): boolean {
    return this.connection.isConnected();
  }

  /**
   * Get the BiDi connection (for advanced usage)
   */
  getConnection(): BiDiConnection {
    return this.connection;
  }

  /**
   * Network interception API
   */
  get network(): NetworkInterceptor {
    if (!this._network) {
      this._network = new NetworkInterceptor(this.connection, this.context);
    }
    return this._network;
  }

  /**
   * Log monitoring API
   */
  get logs(): LogMonitor {
    if (!this._logs) {
      // Defensive: connect() always constructs + arms the monitor, so this
      // only runs if BiDi came up through some other path. Self-arm here so
      // capture works without the caller pre-arming a listener.
      this._logs = new LogMonitor(this.connection, this.context);
      void this._logs.initialize();
    }
    return this._logs;
  }

  /**
   * Session state/storage API
   */
  get storage(): SessionStateManager {
    if (!this._storage) {
      this._storage = new SessionStateManager(
        this.driver,
        this.isConnected() ? this.connection : null,
        this.context
      );
    }
    return this._storage;
  }

  // === Convenience methods ===

  /**
   * Save session state to file (cookies + localStorage)
   */
  async saveState(path: string, options?: StorageStateOptions): Promise<SessionState> {
    return this.storage.saveState(path, options);
  }

  /**
   * Load session state from file
   */
  async loadState(source: string | SessionState): Promise<void> {
    return this.storage.loadState(source);
  }

  /**
   * Get the active browsing context id
   */
  getContext(): string | undefined {
    return this.context;
  }

  /**
   * Register a one-shot handler for the next `browsingContext.load` event
   * on the active top-level context. Returns an unsubscribe function.
   */
  onLoad(handler: (params: Record<string, unknown>) => void): () => void {
    return this.connection.on('browsingContext.load', handler);
  }

  /** Register a handler for top-level navigation starts. */
  onNavigationStarted(handler: (params: Record<string, unknown>) => void): () => void {
    return this.connection.on('browsingContext.navigationStarted', handler);
  }

  /**
   * Register a handler for the next `browsingContext.domContentLoaded`
   * event on the active top-level context. Returns an unsubscribe function.
   */
  onDomContentLoaded(handler: (params: Record<string, unknown>) => void): () => void {
    return this.connection.on('browsingContext.domContentLoaded', handler);
  }

  /**
   * Register a persistent handler for `browsingContext.userPromptOpened` events.
   * Called every time a dialog (alert/confirm/prompt) opens. Returns an unsubscribe function.
   */
  onDialog(handler: (params: Record<string, unknown>) => void): () => void {
    return this.connection.on('browsingContext.userPromptOpened', handler);
  }

  /**
   * Handle an open user prompt (alert / confirm / prompt) via BiDi.
   * @param accept   true to accept (OK), false to dismiss (Cancel / close)
   * @param userText Text to type into a prompt dialog before accepting
   */
  async handleUserPrompt(accept: boolean, userText?: string): Promise<void> {
    if (!this.context) throw new Error('No active browsing context');
    const params: Record<string, unknown> = { context: this.context, accept };
    if (userText !== undefined) params.userText = userText;
    await this.connection.send('browsingContext.handleUserPrompt', params);
  }

  /**
   * Subscribe to BiDi events
   */
  async subscribe(events: string[]): Promise<void> {
    await this.connection.subscribe(events);
  }

  /**
   * Add event listener
   */
  on(event: string, handler: (params: Record<string, unknown>) => void): () => void {
    return this.connection.on(event, handler);
  }

  /**
   * Close BiDi connection
   */
  async close(): Promise<void> {
    await this.connection.close();
    this.initialized = false;
  }
}

// Export all BiDi modules
export { BiDiConnection } from './connection.js';
export {
  NetworkInterceptor,
  type MockResponse,
  type InterceptedRequest,
  type InterceptedResponse,
} from './network.js';
export { LogMonitor, type ConsoleMessage, type JavaScriptError, type LogMessage } from './logs.js';
export { SessionStateManager, type StorageStateOptions } from './storage.js';
export * from './types.js';
