/**
 * Tracer — lightweight per-test recorder.
 *
 * Captures a chronological event log (console messages, errors, network
 * requests/responses, navigations) plus optional periodic screenshots,
 * and writes it all to a JSON bundle on `stop()`. The output is meant
 * to be `cat`/`jq`-friendly, not rendered by a viewer.
 *
 * **BiDi-only.** Tracing relies on the same subscriptions that power
 * `browser.logs` and `browser.network` and is unavailable in Classic mode.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Browser } from './browser.js';
import type { BiDiConnection } from './bidi/connection.js';

export interface TraceStartOptions {
  /** Capture periodic viewport screenshots (default: false). */
  screenshots?: boolean;
  /** Interval between screenshots in ms (default: 1000). Ignored unless `screenshots` is true. */
  screenshotInterval?: number;
}

export type TraceEvent =
  | { t: number; type: 'console'; level: string; text: string }
  | { t: number; type: 'error'; text: string }
  | { t: number; type: 'request'; url: string; method: string; requestId?: string }
  | { t: number; type: 'response'; url: string; status: number; requestId?: string }
  | { t: number; type: 'navigation'; url: string; context?: string }
  | { t: number; type: 'screenshot'; file: string };

export interface TraceBundle {
  startedAt: string;
  endedAt: string;
  events: TraceEvent[];
}

export class Tracer {
  private browser: Browser;
  private conn: BiDiConnection;
  private startedAtMs = 0;
  private startedAtIso = '';
  private events: TraceEvent[] = [];
  private unsubs: Array<() => void> = [];
  private screenshotTimer?: NodeJS.Timeout;
  private screenshotIndex = 0;
  private screenshots: Array<{ idx: number; data: Buffer }> = [];
  private running = false;

  constructor(browser: Browser, conn: BiDiConnection) {
    this.browser = browser;
    this.conn = conn;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(opts?: TraceStartOptions): Promise<void> {
    if (this.running) {
      throw new Error('Tracer is already running. Call stopTrace() first.');
    }
    this.running = true;
    this.startedAtMs = Date.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();
    this.events = [];
    this.screenshots = [];
    this.screenshotIndex = 0;

    // Subscribe to the streams we care about. These subscriptions may
    // already be active (LogMonitor / NetworkInterceptor); BiDi accepts
    // duplicate subscribes.
    await this.conn.subscribe([
      'log.entryAdded',
      'network.beforeRequestSent',
      'network.responseCompleted',
      'browsingContext.navigationStarted',
    ]).catch(() => { /* already subscribed */ });

    this.unsubs.push(this.conn.on('log.entryAdded', (params) => {
      const p = params as Record<string, unknown>;
      const text = String(p.text ?? '');
      if (p.type === 'console') {
        this.push({ type: 'console', level: String(p.level ?? 'info'), text });
      } else {
        this.push({ type: 'error', text });
      }
    }));

    this.unsubs.push(this.conn.on('network.beforeRequestSent', (params) => {
      const p = params as Record<string, unknown>;
      const req = (p.request ?? {}) as Record<string, unknown>;
      this.push({
        type: 'request',
        url: String(req.url ?? ''),
        method: String(req.method ?? ''),
        requestId: req.request as string | undefined,
      });
    }));

    this.unsubs.push(this.conn.on('network.responseCompleted', (params) => {
      const p = params as Record<string, unknown>;
      const req = (p.request ?? {}) as Record<string, unknown>;
      const res = (p.response ?? {}) as Record<string, unknown>;
      this.push({
        type: 'response',
        url: String(req.url ?? res.url ?? ''),
        status: Number(res.status ?? 0),
        requestId: req.request as string | undefined,
      });
    }));

    this.unsubs.push(this.conn.on('browsingContext.navigationStarted', (params) => {
      const p = params as Record<string, unknown>;
      this.push({
        type: 'navigation',
        url: String(p.url ?? ''),
        context: p.context as string | undefined,
      });
    }));

    if (opts?.screenshots) {
      const interval = Math.max(100, opts.screenshotInterval ?? 1000);
      this.screenshotTimer = setInterval(async () => {
        if (!this.running) return;
        try {
          const buf = await this.browser.screenshot();
          const idx = ++this.screenshotIndex;
          this.screenshots.push({ idx, data: buf });
          // Record the event with a placeholder filename; final path
          // is resolved on stop() once we know the bundle location.
          this.push({
            type: 'screenshot',
            file: `screenshots/${String(idx).padStart(4, '0')}.png`,
          });
        } catch {
          // Browser may be navigating; skip this tick silently.
        }
      }, interval);
    }
  }

  /**
   * Stop tracing and write the JSON bundle to `path`. Screenshots, if any,
   * are written to a sibling `screenshots/` folder next to that path.
   * Returns the in-memory bundle.
   */
  async stop(path: string): Promise<TraceBundle> {
    if (!this.running) {
      throw new Error('Tracer is not running. Call startTrace() first.');
    }

    if (this.screenshotTimer) {
      clearInterval(this.screenshotTimer);
      this.screenshotTimer = undefined;
    }
    for (const un of this.unsubs) un();
    this.unsubs = [];

    const bundle: TraceBundle = {
      startedAt: this.startedAtIso,
      endedAt: new Date().toISOString(),
      events: [...this.events],
    };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(bundle, null, 2), 'utf8');

    if (this.screenshots.length > 0) {
      const dir = join(dirname(path), 'screenshots');
      mkdirSync(dir, { recursive: true });
      for (const { idx, data } of this.screenshots) {
        writeFileSync(join(dir, `${String(idx).padStart(4, '0')}.png`), data);
      }
    }

    this.running = false;
    this.screenshots = [];
    return bundle;
  }

  /** Stop the tracer without writing a file. Used by `Browser.quit()`. */
  abort(): void {
    if (this.screenshotTimer) {
      clearInterval(this.screenshotTimer);
      this.screenshotTimer = undefined;
    }
    for (const un of this.unsubs) un();
    this.unsubs = [];
    this.running = false;
    this.screenshots = [];
  }

  private push(ev: { type: TraceEvent['type'] } & Record<string, unknown>): void {
    if (!this.running) return;
    this.events.push({ t: Date.now() - this.startedAtMs, ...ev } as TraceEvent);
  }
}
