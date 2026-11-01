/**
 * Run chromium-bidi's BiDi-CDP mapper inside this Node process and expose it
 * as a {@link BiDiTransport}.
 *
 * chromedriver normally runs the same mapper in a hidden Chrome tab and
 * proxies BiDi through its own WebSocket. Here the mapper talks CDP straight
 * to Chrome's DevTools endpoint, and BiDi messages reach it by function call.
 * The bootstrap mirrors chromium-bidi's in-tab entry point (and Puppeteer's
 * `BidiOverCdp`): one `MapperCdpConnection`, its browser session, then
 * `BidiServer.createAndStart`.
 */

import { WebSocket } from 'ws';
import { loadMapper, type BidiServer, type MapperBidiCommand } from './mapperBundle.js';
import type { BiDiTransport } from './transport.js';
import { BIDI_TIMEOUT_MS } from '../timing.js';

export interface InProcessMapperOptions {
  /**
   * `session.new` `alwaysMatch` capabilities. Pass the same
   * `unhandledPromptBehavior` the Classic session uses: the mapper's default
   * dismisses dialogs before Classic or `onDialog` can see them.
   */
  capabilities: Record<string, unknown>;
  timeoutMs?: number;
}

function openCdpSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`CDP connection timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

class InProcessMapperTransport implements BiDiTransport {
  private messageHandler: (data: string) => void = () => {};
  private closeHandlers: Array<() => void> = [];
  /** The mapper's inbound-command handler, set by `BidiServer.createAndStart`. */
  toMapper: (command: MapperBidiCommand) => Promise<void> | void = () => {};
  /** Responses the bootstrap waits for itself, before the transport is handed out. */
  readonly internal = new Map<number, (message: Record<string, unknown>) => void>();
  server?: BidiServer;
  private closed = false;

  constructor(
    private cdp: WebSocket,
    private closeCdp: () => void
  ) {
    cdp.on('close', () => this.markClosed());
  }

  /** Called by the mapper with each response or event. */
  fromMapper(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id === 'number' && this.internal.has(id)) {
      const resolve = this.internal.get(id)!;
      this.internal.delete(id);
      resolve(message);
      return;
    }
    this.messageHandler(JSON.stringify(message));
  }

  send(message: string): void {
    if (this.closed) throw new Error('BiDi connection not established');
    void this.toMapper(JSON.parse(message) as MapperBidiCommand);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  isOpen(): boolean {
    return !this.closed && this.cdp.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Mapper first, then the CDP socket it was using.
    try {
      this.server?.close();
    } finally {
      this.closeCdp();
      this.markClosed();
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }
}

/**
 * Connect to Chrome's browser-level CDP endpoint, start the mapper, and open
 * the BiDi session. The returned transport is ready for `BiDiConnection`.
 */
export async function startInProcessMapper(
  cdpWsUrl: string,
  opts: InProcessMapperOptions
): Promise<BiDiTransport> {
  const timeoutMs = opts.timeoutMs ?? BIDI_TIMEOUT_MS;
  const [{ BidiServer, MapperCdpConnection }, cdp] = await Promise.all([
    loadMapper(),
    openCdpSocket(cdpWsUrl, timeoutMs),
  ]);

  let onCdpMessage: (message: string) => Promise<void> | void = () => {};
  cdp.on('message', (data: Buffer | string) => void onCdpMessage(data.toString()));
  // Errors after open are followed by 'close', which the transport handles.
  cdp.on('error', () => {});
  const cdpConnection = new MapperCdpConnection({
    setOnMessage: (handler) => {
      onCdpMessage = handler;
    },
    sendMessage: (message) => cdp.send(message),
    close: () => cdp.close(),
  });

  const transport = new InProcessMapperTransport(cdp, () => cdpConnection.close());
  try {
    const browserClient = await cdpConnection.createBrowserSession();
    transport.server = await BidiServer.createAndStart(
      {
        setOnMessage: (handler) => {
          transport.toMapper = handler;
        },
        sendMessage: (message) => transport.fromMapper(message),
        close: () => {},
      },
      cdpConnection,
      browserClient,
      /* selfTargetId= */ ''
    );

    // BiDiConnection numbers its commands from 1, so id 0 never collides.
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`BiDi session.new timeout after ${timeoutMs}ms`)),
        timeoutMs
      );
      transport.internal.set(0, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      void transport.toMapper({
        id: 0,
        method: 'session.new',
        params: { capabilities: { alwaysMatch: opts.capabilities } },
      });
    });
    if (reply.type === 'error') {
      throw new Error(`BiDi session.new failed [${String(reply.error)}]: ${String(reply.message)}`);
    }
    return transport;
  } catch (err) {
    await transport.close().catch(() => {});
    throw err;
  }
}
