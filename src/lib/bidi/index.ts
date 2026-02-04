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
   * Connect to BiDi WebSocket endpoint
   */
  async connect(wsUrl: string): Promise<void> {
    await this.connection.connect(wsUrl);

    // Get the current browsing context
    const result = await this.connection.send<{
      contexts: Array<{ context: string; url: string }>;
    }>('browsingContext.getTree', {});

    if (result.contexts?.[0]) {
      this.context = result.contexts[0].context;
    }

    // Eagerly initialize log monitoring so console/error capture starts immediately
    this._logs = new LogMonitor(this.connection, this.context);
    await this._logs.initialize();

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
      this._logs = new LogMonitor(this.connection, this.context);
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
  async loadState(path: string): Promise<void> {
    return this.storage.loadState(path);
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
export { NetworkInterceptor, type MockResponse, type InterceptedRequest } from './network.js';
export { LogMonitor, type ConsoleMessage, type JavaScriptError, type LogMessage } from './logs.js';
export { SessionStateManager, type StorageStateOptions } from './storage.js';
export * from './types.js';
