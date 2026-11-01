/**
 * Hand-written types for the vendored chromium-bidi mapper bundle
 * (chromium-bidi-mapper.js). Only the surface craftdriver calls is typed, and
 * CDP payloads stay `unknown` so nothing depends on devtools-protocol.
 *
 * Mirrors the upstream declarations recorded in chromium-bidi-mapper.api.txt.
 * When `npm run mapper:update` reports an API change, update this file to
 * match; never edit the bundle itself.
 */

/** Raw text transport to Chrome's CDP endpoint (a WebSocket, a pipe, ...). */
export interface MapperTransport {
  setOnMessage(handler: (message: string) => Promise<void> | void): void;
  sendMessage(message: string): Promise<void> | void;
  close(): void;
}

/** A BiDi command as the mapper receives it: already parsed, not JSON text. */
export interface MapperBidiCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
  /** Present when the command targets a chromium-bidi channel. */
  channel?: string;
}

/** Object transport between the BiDi client and the mapper. */
export interface BidiTransport {
  setOnMessage(handler: (message: MapperBidiCommand) => Promise<void> | void): void;
  /** Responses and events, as plain objects. */
  sendMessage(message: Record<string, unknown>): Promise<void> | void;
  close(): void;
}

/** CDP client for one session; opaque to craftdriver. */
export interface MapperCdpClient {
  sendCommand(method: string, params?: unknown): Promise<unknown>;
}

export declare class MapperCdpConnection {
  constructor(transport: MapperTransport);
  /** Closes the connection to the browser. */
  close(): void;
  /** Attaches to the browser target; the result is `createAndStart`'s third argument. */
  createBrowserSession(): Promise<MapperCdpClient>;
}

export declare class BidiServer {
  private constructor();
  /**
   * Creates and starts a mapper instance. With no `parser`, commands go
   * through chromium-bidi's no-op parser; the validating parser is not in the
   * bundle.
   */
  static createAndStart(
    bidiTransport: BidiTransport,
    cdpConnection: MapperCdpConnection,
    browserCdpClient: MapperCdpClient,
    selfTargetId: string
  ): Promise<BidiServer>;
  close(): void;
}
