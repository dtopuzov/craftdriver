/**
 * Tracer — append-only, crash-resilient session recorder for bug
 * investigation.
 *
 * Streams events to `<outDir>/trace.ndjson` synchronously, one line per
 * event. Screenshots are written to `<outDir>/screenshots/NNNN.png` as
 * their captures resolve. There is **no finalisation step** — if the
 * test throws (or the process is killed) every event up to that point is
 * already on disk and the partial file is still valid NDJSON.
 *
 * **BiDi-only.** Tracing relies on the same subscriptions that power
 * `browser.logs` and `browser.network` and is unavailable in Classic mode.
 */

import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from './browser.js';
import type { BiDiConnection } from './bidi/connection.js';
import { writeVibiumTraceZip } from './vibiumTrace.js';

/** Screenshot mode for tracing. */
export type TraceScreenshotMode = boolean | 'auto' | 'off';

export interface TraceStartOptions {
  /**
   * Output directory. Created if missing. The trace itself lives at
   * `<outDir>/trace.ndjson`; screenshots, if any, at
   * `<outDir>/screenshots/NNNN.png`.
   */
  outDir: string;
  /**
   * Snap screenshots tied to evidence moments rather than a timer:
   *  - `'auto'` / `true` *(default)* — one PNG before every logged action
   *    and one on every page error.
   *  - `'off'` / `false` — no screenshots.
   */
  screenshots?: TraceScreenshotMode;
  /** Log public-API actions (click, fill, navigateTo, …). Default true. */
  actions?: boolean;
  /** Record network request/response events. Default true. */
  network?: boolean;
  /** Capture console + page errors. Default true. */
  console?: boolean;
  /** Title shown in Vibium Player when exporting a zip. */
  title?: string;
}

export interface TraceStopOptions {
  /** Write a Vibium/Playwright-compatible trace zip to this path. */
  path: string;
}

export type TraceEvent =
  | { t: number; type: 'meta'; startedAt?: string; endedAt?: string; opts?: unknown }
  | { t: number; type: 'console'; level: string; text: string }
  | { t: number; type: 'error'; text: string }
  | { t: number; type: 'request'; url: string; method: string; requestId?: string }
  | { t: number; type: 'response'; url: string; status: number; mimeType?: string; fromCache?: true; requestId?: string }
  | { t: number; type: 'navigation'; url: string; context?: string }
  | { t: number; type: 'screenshot'; file: string; actionIndex?: number; reason: 'action' | 'error' | 'final' }
  | { t: number; type: 'action'; actionIndex?: number; name: string; args?: unknown[]; selector?: string }
  | { t: number; type: 'action-end'; actionIndex: number; error?: string };

export class Tracer {
  private browser: Browser;
  private conn: BiDiConnection;
  private startedAtMs = 0;
  private startedAtIso = '';
  private outDir = '';
  private fd: number | null = null;
  private unsubs: Array<() => void> = [];
  private screenshotIndex = 0;
  private screenshotDirEnsured = false;
  private running = false;
  private actionsEnabled = true;
  private screenshotMode: 'auto' | 'off' = 'auto';
  private traceTitle?: string;
  private actionIndex = 0;
  /** Tracks in-flight screenshot captures so `stop()` can drain them. */
  private pendingCaptures: Array<Promise<void>> = [];

  constructor(
    browser: Browser,
    conn: BiDiConnection,
    private browserName: 'chrome' | 'chromium' | 'firefox',
  ) {
    this.browser = browser;
    this.conn = conn;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(opts: TraceStartOptions): Promise<void> {
    if (this.running) {
      throw new Error('Tracer is already running. Call stopTrace() first.');
    }
    if (!opts || typeof opts.outDir !== 'string' || opts.outDir.length === 0) {
      throw new Error('startTrace() requires { outDir: string }.');
    }
    this.running = true;
    this.startedAtMs = Date.now();
    this.startedAtIso = new Date(this.startedAtMs).toISOString();
    this.outDir = opts.outDir;
    this.screenshotIndex = 0;
    this.screenshotDirEnsured = false;
    this.actionIndex = 0;
    this.traceTitle = opts.title;
    this.pendingCaptures = [];

    this.actionsEnabled = opts.actions ?? true;
    const networkOn = opts.network ?? true;
    const consoleOn = opts.console ?? true;
    this.screenshotMode = normalizeScreenshotMode(opts.screenshots);

    mkdirSync(this.outDir, { recursive: true });
    this.fd = openSync(join(this.outDir, 'trace.ndjson'), 'w');

    // First line: start meta. Readers can match `type === 'meta'` to find
    // start/end markers and ignore the rest of the schema.
    this.writeLine({
      t: 0,
      type: 'meta',
      startedAt: this.startedAtIso,
      opts: {
        actions: this.actionsEnabled,
        network: networkOn,
        console: consoleOn,
        screenshots: this.screenshotMode,
        title: opts.title,
      },
    });

    const wantedSubs: string[] = ['browsingContext.navigationStarted'];
    if (consoleOn) wantedSubs.push('log.entryAdded');
    if (networkOn) wantedSubs.push('network.beforeRequestSent', 'network.responseCompleted');
    // BiDi accepts duplicate subscribes (LogMonitor / NetworkInterceptor may already be subscribed).
    await this.conn.subscribe(wantedSubs).catch(() => { /* already subscribed */ });

    if (consoleOn) {
      this.unsubs.push(this.conn.on('log.entryAdded', (params) => {
        const p = params as Record<string, unknown>;
        const text = String(p.text ?? '');
        if (p.type === 'console') {
          this.push({ type: 'console', level: String(p.level ?? 'info'), text });
        } else {
          this.push({ type: 'error', text });
          if (this.screenshotMode === 'auto') this.scheduleScreenshot('error');
        }
      }));
    }

    if (networkOn) {
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
        const ev: Record<string, unknown> = {
          type: 'response',
          url: String(req.url ?? res.url ?? ''),
          status: Number(res.status ?? 0),
          requestId: req.request as string | undefined,
        };
        const mime = res.mimeType;
        if (typeof mime === 'string' && mime.length > 0) ev.mimeType = mime;
        if (res.fromCache === true) ev.fromCache = true;
        this.push(ev as { type: TraceEvent['type'] } & Record<string, unknown>);
      }));
    }

    this.unsubs.push(this.conn.on('browsingContext.navigationStarted', (params) => {
      const p = params as Record<string, unknown>;
      this.push({
        type: 'navigation',
        url: String(p.url ?? ''),
        context: p.context as string | undefined,
      });
    }));
  }

  /**
   * Record a public-API action. Fire-and-forget — the event is written
   * **synchronously** to `trace.ndjson` before returning, so a thrown
   * `expect` on the next line cannot lose it. When `screenshots: 'auto'`
   * is on, also enqueues a pre-action screenshot capture (async; doesn't
   * block the caller).
   *
   * Zero-cost when no tracer is running or `actions: false`.
   */
  recordAction(name: string, args?: unknown[], selector?: string): number | undefined {
    if (!this.running || !this.actionsEnabled) return undefined;
    const idx = ++this.actionIndex;
    this.writeLine({
      t: Date.now() - this.startedAtMs,
      type: 'action',
      actionIndex: idx,
      name,
      args: args && args.length ? args.map(safeArg) : undefined,
      selector,
    });
    if (this.screenshotMode === 'auto') this.scheduleScreenshot('action', idx);
    return idx;
  }

  /** Complete an action marker with its real duration and optional error. */
  recordActionEnd(actionIndex: number | undefined, error?: unknown): void {
    if (!this.running || actionIndex === undefined) return;
    const event: Extract<TraceEvent, { type: 'action-end' }> = {
      t: Date.now() - this.startedAtMs,
      type: 'action-end',
      actionIndex,
    };
    if (error !== undefined) {
      event.error = error instanceof Error ? error.message : String(error);
    }
    this.writeLine(event);
  }

  private scheduleScreenshot(reason: 'action' | 'error' | 'final', actionIndex?: number): void {
    const startedAtMs = Date.now();
    const p = this.browser.screenshot().then(
      (buf) => {
        if (!this.running) return;
        const idx = ++this.screenshotIndex;
        const rel = `screenshots/${String(idx).padStart(4, '0')}.png`;
        if (!this.screenshotDirEnsured) {
          mkdirSync(join(this.outDir, 'screenshots'), { recursive: true });
          this.screenshotDirEnsured = true;
        }
        try {
          writeFileSync(join(this.outDir, rel), buf);
        } catch {
          return; // disk error; skip this frame
        }
        const ev: TraceEvent = {
          t: startedAtMs - this.startedAtMs,
          type: 'screenshot',
          file: rel,
          reason,
        };
        if (actionIndex !== undefined) ev.actionIndex = actionIndex;
        this.writeLine(ev);
      },
      () => { /* browser may be navigating or quitting; skip silently */ }
    );
    this.pendingCaptures.push(p);
  }

  /**
   * Stop tracing cleanly: drain in-flight screenshots, write the closing
   * `meta` line, and close the file. If the test throws and `stop()` is
   * never called, the file is still a valid NDJSON trace — just without
   * the closing marker.
   */
  async stop(opts?: TraceStopOptions): Promise<void> {
    if (!this.running) {
      throw new Error('stopTrace(): no trace is running. Call startTrace() first.');
    }
    // Capture the state left by the last action/assertion. This is especially
    // useful for keep-on-failure test hooks and removes the need for callers to
    // create a magic `final.png` file themselves.
    if (this.screenshotMode === 'auto') this.scheduleScreenshot('final');

    for (const un of this.unsubs) un();
    this.unsubs = [];

    if (this.pendingCaptures.length > 0) {
      await Promise.allSettled(this.pendingCaptures);
      this.pendingCaptures = [];
    }

    this.writeLine({
      t: Date.now() - this.startedAtMs,
      type: 'meta',
      endedAt: new Date().toISOString(),
    });

    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
    this.running = false;

    if (opts) {
      await writeVibiumTraceZip({
        sourceDir: this.outDir,
        path: opts.path,
        browserName: this.browserName,
        title: this.traceTitle,
      });
    }
  }

  /** Close the file without writing an end marker. Used by `Browser.quit()`. */
  abort(): void {
    for (const un of this.unsubs) un();
    this.unsubs = [];
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
    this.running = false;
    this.pendingCaptures = [];
  }

  private push(ev: { type: TraceEvent['type'] } & Record<string, unknown>): void {
    if (!this.running) return;
    this.writeLine({ t: Date.now() - this.startedAtMs, ...ev } as TraceEvent);
  }

  private writeLine(ev: TraceEvent): void {
    if (this.fd === null) return;
    try {
      writeSync(this.fd, JSON.stringify(ev) + '\n');
    } catch {
      // Disk full / fd closed unexpectedly. Stop trying so we don't
      // throw from inside a hot action method.
    }
  }

}

function normalizeScreenshotMode(v: TraceScreenshotMode | undefined): 'auto' | 'off' {
  if (v === undefined || v === 'auto' || v === true) return 'auto';
  return 'off';
}

function safeArg(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  if (t === 'function') return '[Function]';
  if (Array.isArray(v)) return v.slice(0, 8).map(safeArg);
  try {
    const s = JSON.stringify(v);
    if (s && s.length < 200) return JSON.parse(s);
    return '[Object]';
  } catch {
    return '[Object]';
  }
}
