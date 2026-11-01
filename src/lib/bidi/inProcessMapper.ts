/**
 * Run chromium-bidi's BiDi-CDP mapper in this Node process and expose it as a
 * {@link BiDiTransport}.
 *
 * chromedriver normally runs the same mapper in a hidden Chrome tab and
 * proxies BiDi through its own WebSocket. Here the mapper talks CDP straight
 * to Chrome's DevTools endpoint from a worker thread. The bootstrap mirrors
 * chromium-bidi's in-tab entry point (and Puppeteer's `BidiOverCdp`): one
 * `MapperCdpConnection`, its browser session, then `BidiServer.createAndStart`.
 *
 * Why a worker: the mapper leaves some internal promises unhandled (e.g. CDP
 * calls that fail because a target or the connection closed). Inside
 * Chrome's tab that is harmless; in the caller's process it would trip Node's
 * default `unhandledRejection` crash. A worker has its own `process` events,
 * so the mapper's rejections are contained there without touching the
 * caller's handlers.
 */

import { Worker } from 'node:worker_threads';
import { mapperBundleUrl } from './mapperBundle.js';
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

/** Messages between the worker and this thread. BiDi payloads stay JSON text. */
type FromWorker =
  | { type: 'ready' }
  | { type: 'failed'; message: string }
  | { type: 'bidi'; data: string }
  | { type: 'closed' };

/**
 * The worker body (CommonJS, evaluated). It connects to Chrome with Node's
 * built-in WebSocket, starts the mapper with no parser (the validating parser
 * and its zod dependency are not in the bundle), opens the session with id 0
 * (BiDiConnection numbers from 1), and then relays JSON text both ways.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const post = (m) => parentPort.postMessage(m);
process.on('unhandledRejection', () => {});

(async () => {
  const { BidiServer, MapperCdpConnection } = await import(workerData.bundleUrl);
  const ws = new WebSocket(workerData.cdpWsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket failed to open')), { once: true });
  });
  let onCdp = () => {};
  ws.addEventListener('message', (e) => onCdp(e.data));
  ws.addEventListener('close', () => post({ type: 'closed' }));
  const cdp = new MapperCdpConnection({
    setOnMessage: (h) => { onCdp = h; },
    sendMessage: (m) => ws.send(m),
    close: () => ws.close(),
  });

  let toMapper = () => {};
  let sessionOpened;
  const opened = new Promise((r) => { sessionOpened = r; });
  const server = await BidiServer.createAndStart(
    {
      setOnMessage: (h) => { toMapper = h; },
      sendMessage: (m) => {
        if (m.id === 0) sessionOpened(m);
        else post({ type: 'bidi', data: JSON.stringify(m) });
      },
      close: () => {},
    },
    cdp,
    await cdp.createBrowserSession(),
    ''
  );

  parentPort.on('message', (m) => {
    if (m.type === 'bidi') void toMapper(JSON.parse(m.data));
    else if (m.type === 'close') {
      try { server.close(); } finally { cdp.close(); }
    }
  });

  toMapper({ id: 0, method: 'session.new', params: { capabilities: { alwaysMatch: workerData.capabilities } } });
  const reply = await opened;
  if (reply.type === 'error') throw new Error('BiDi session.new failed [' + reply.error + ']: ' + reply.message);
  post({ type: 'ready' });
})().catch((err) => post({ type: 'failed', message: String(err && err.message || err) }));
`;

class WorkerMapperTransport implements BiDiTransport {
  private messageHandler: (data: string) => void = () => {};
  private closeHandlers: Array<() => void> = [];
  private closed = false;

  constructor(private worker: Worker) {
    worker.on('message', (m: FromWorker) => {
      if (m.type === 'bidi') this.messageHandler(m.data);
      else if (m.type === 'closed') this.markClosed();
    });
    worker.on('error', () => this.markClosed());
    worker.on('exit', () => this.markClosed());
  }

  send(message: string): void {
    if (this.closed) throw new Error('BiDi connection not established');
    this.worker.postMessage({ type: 'bidi', data: message });
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  isOpen(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Mapper first, then the CDP socket it was using, then the thread.
    this.worker.postMessage({ type: 'close' });
    this.markClosed();
    await this.worker.terminate();
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
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { bundleUrl: mapperBundleUrl(), cdpWsUrl, capabilities: opts.capabilities },
  });
  // Don't hold the caller's process open; quit() terminates the worker.
  worker.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`BiDi mapper did not start within ${timeoutMs}ms`)),
        timeoutMs
      );
      const done = (err?: Error) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        if (err) reject(err);
        else resolve();
      };
      const onMessage = (m: FromWorker) => {
        if (m.type === 'ready') done();
        else if (m.type === 'failed') done(new Error(`BiDi mapper failed to start: ${m.message}`));
        else if (m.type === 'closed') done(new Error('Chrome closed the CDP connection'));
      };
      const onError = (err: Error) => done(err);
      const onExit = (code: number) => done(new Error(`BiDi mapper worker exited (${code})`));
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
    });
  } catch (err) {
    await worker.terminate().catch(() => {});
    throw err;
  }
  return new WorkerMapperTransport(worker);
}
