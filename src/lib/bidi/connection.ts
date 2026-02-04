/**
 * WebDriver BiDi WebSocket connection manager
 * Handles bidirectional communication with the browser
 */

import { WebSocket } from 'ws';
import type {
  BiDiCommand,
  BiDiMessage,
  BiDiResponse,
  BiDiEvent,
} from './types.js';

export type EventHandler = (params: Record<string, unknown>) => void;

export interface ConnectionOptions {
  /** Connection timeout in ms (default: 30000) */
  timeout?: number;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
}

export class BiDiConnection {
  private ws: WebSocket | null = null;
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
      timeout: options.timeout ?? 30000,
      autoReconnect: options.autoReconnect ?? false,
    };
  }

  /**
   * Connect to WebDriver BiDi WebSocket endpoint
   */
  async connect(wsUrl: string): Promise<void> {
    if (this.connected && this.ws) {
      return;
    }

    this.wsUrl = wsUrl;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`BiDi connection timeout after ${this.options.timeout}ms`));
      }, this.options.timeout);

      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          clearTimeout(timeout);
          this.connected = true;
          resolve();
        });

        this.ws.on('message', (data: Buffer | string) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', () => {
          this.connected = false;
          this.rejectAllPending(new Error('WebSocket connection closed'));
          if (this.options.autoReconnect && this.wsUrl) {
            setTimeout(() => this.connect(this.wsUrl).catch(() => { }), 1000);
          }
        });

        this.ws.on('error', (err) => {
          clearTimeout(timeout);
          this.connected = false;
          reject(err);
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  /**
   * Check if connected to BiDi endpoint
   */
  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
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

      this.ws!.send(JSON.stringify(command));
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
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
