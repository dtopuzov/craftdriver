/**
 * Message transports for a WebDriver BiDi connection.
 *
 * `BiDiConnection` speaks JSON text over a `BiDiTransport`. The default is a
 * WebSocket to the driver's `webSocketUrl`; the in-process chromium-bidi
 * mapper (see inProcessMapper.ts) implements the same interface, so the
 * connection and everything above it can't tell the two apart. Messages stay
 * JSON text on both paths: the serialization boundary keeps the mapper's
 * objects and the caller's objects from ever sharing references.
 */

import { WebSocket } from 'ws';

export interface BiDiTransport {
  /** Send one serialized BiDi command. */
  send(message: string): void;
  /** Register the handler for every incoming message (responses and events). */
  onMessage(handler: (data: string) => void): void;
  /** Register the handler called once when the transport closes for any reason. */
  onClose(handler: () => void): void;
  isOpen(): boolean;
  close(): Promise<void>;
}

/** BiDi over a WebSocket, the transport every driver-provided `webSocketUrl` uses. */
export class WebSocketTransport implements BiDiTransport {
  private messageHandler: (data: string) => void = () => {};
  private closeHandler: () => void = () => {};

  private constructor(private ws: WebSocket) {
    ws.on('message', (data: Buffer | string) => this.messageHandler(data.toString()));
    ws.on('close', () => this.closeHandler());
    // A post-open socket error is always followed by 'close', which is what
    // the connection reacts to; without a listener `ws` would throw instead.
    ws.on('error', () => {});
  }

  /** Open a WebSocket to `url`; rejects on error or after `timeoutMs`. */
  static open(url: string, timeoutMs: number): Promise<WebSocketTransport> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      const timeout = setTimeout(() => {
        reject(new Error(`BiDi connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      try {
        ws = new WebSocket(url);
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }
      ws.once('open', () => {
        clearTimeout(timeout);
        resolve(new WebSocketTransport(ws));
      });
      ws.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  send(message: string): void {
    this.ws.send(message);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}
