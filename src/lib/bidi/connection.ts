/**
 * WebDriver BiDi WebSocket connection manager
 * Handles bidirectional communication with the browser
 */

import type {
  BiDiCommand,
  BiDiMessage,
  BiDiResponse,
  BiDiEvent,
} from './types.js';
import { BIDI_TIMEOUT_MS, BIDI_RECONNECT_DELAY_MS } from '../timing.js';
import { WebSocketTransport, type BiDiTransport } from './transport.js';

export type EventHandler = (params: Record<string, unknown>) => void;

export interface ConnectionOptions {
  /** Connection timeout in ms (default: {@link BIDI_TIMEOUT_MS}) */
  timeout?: number;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
}

export class BiDiConnection {
  private transport: BiDiTransport | null = null;
  private messageId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private connected = false;
  private wsUrl: string = '';
  private options: ConnectionOptions;

  constructor(options: ConnectionOptions = {}) {
    this.options = {
      timeout: options.timeout ?? BIDI_TIMEOUT_MS,
      autoReconnect: options.autoReconnect ?? false,
    };
  }

  /**
   * Connect to WebDriver BiDi WebSocket endpoint
   */
  async connect(wsUrl: string): Promise<void> {
    if (this.connected && this.transport) {
      return;
    }

    this.wsUrl = wsUrl;
    this.attach(await WebSocketTransport.open(wsUrl, this.options.timeout!));
  }

  /**
   * Connect over an already-open transport (e.g. the in-process mapper).
   * Auto-reconnect never applies: there is no URL to reconnect to.
   */
  connectTransport(transport: BiDiTransport): void {
    this.wsUrl = '';
    this.attach(transport);
  }

  private attach(transport: BiDiTransport): void {
    this.transport = transport;
    this.connected = true;
    transport.onMessage((data) => this.handleMessage(data));
    transport.onClose(() => {
      this.connected = false;
      this.rejectAllPending(new Error('WebSocket connection closed'));
      if (this.options.autoReconnect && this.wsUrl) {
        setTimeout(() => this.connect(this.wsUrl).catch(() => { }), BIDI_RECONNECT_DELAY_MS);
      }
    });
  }

  /**
   * Check if connected to BiDi endpoint
   */
  isConnected(): boolean {
    return this.connected && (this.transport?.isOpen() ?? false);
  }

  /**
   * Send a BiDi command and wait for response
   */
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.isConnected()) {
      throw new Error('BiDi connection not established');
    }

    const id = ++this.messageId;
    const command: BiDiCommand = { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`BiDi command timeout: ${method}`));
      }, this.options.timeout);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.transport!.send(JSON.stringify(command));
    });
  }

  /**
   * Subscribe to BiDi events
   */
  async subscribe(events: string[], contexts?: string[]): Promise<void> {
    const params: Record<string, unknown> = { events };
    if (contexts?.length) {
      params.contexts = contexts;
    }
    await this.send('session.subscribe', params);
  }

  /**
   * Unsubscribe from BiDi events
   */
  async unsubscribe(events: string[], contexts?: string[]): Promise<void> {
    const params: Record<string, unknown> = { events };
    if (contexts?.length) {
      params.contexts = contexts;
    }
    await this.send('session.unsubscribe', params);
  }

  /**
   * Add event listener for specific BiDi event
   */
  on(event: string, handler: EventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.eventHandlers.get(event)?.delete(handler);
    };
  }

  /**
   * Remove event listener
   */
  off(event: string, handler: EventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  /**
   * Wait for a specific event (one-time)
   */
  once<T = Record<string, unknown>>(
    event: string,
    predicate?: (params: Record<string, unknown>) => boolean,
    timeout?: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutId = timeout
        ? setTimeout(() => {
          unsubscribe();
          reject(new Error(`Timeout waiting for event: ${event}`));
        }, timeout)
        : null;

      const unsubscribe = this.on(event, (params) => {
        if (!predicate || predicate(params)) {
          if (timeoutId) clearTimeout(timeoutId);
          unsubscribe();
          resolve(params as T);
        }
      });
    });
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this.transport) {
      const transport = this.transport;
      this.transport = null;
      await transport.close();
      this.connected = false;
      this.rejectAllPending(new Error('Connection closed'));
    }
  }

  private handleMessage(data: string): void {
    let message: BiDiMessage;
    try {
      message = JSON.parse(data) as BiDiMessage;
    } catch {
      console.error('Failed to parse BiDi message:', data);
      return;
    }

    if ('id' in message && message.id !== undefined) {
      // Command response
      this.handleResponse(message as BiDiResponse);
    } else if (message.type === 'event') {
      // Event
      this.handleEvent(message as BiDiEvent);
    }
  }

  private handleResponse(response: BiDiResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);

    if (response.type === 'error') {
      pending.reject(
        new Error(`BiDi error [${response.error}]: ${response.message}`)
      );
    } else {
      pending.resolve(response.result);
    }
  }

  private handleEvent(event: BiDiEvent): void {
    const handlers = this.eventHandlers.get(event.method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event.params);
        } catch (err) {
          console.error(`Error in BiDi event handler for ${event.method}:`, err);
        }
      }
    }

    // Also emit to wildcard handlers
    const wildcardHandlers = this.eventHandlers.get('*');
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler({ method: event.method, ...event.params });
        } catch (err) {
          console.error('Error in BiDi wildcard event handler:', err);
        }
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
