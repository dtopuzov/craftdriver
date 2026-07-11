/**
 * Export Craftdriver's crash-resilient trace directory as the
 * Playwright-compatible recording layout consumed by Vibium Player.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import yazl from 'yazl';
import type { TraceEvent } from './tracing.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

interface VibiumExportOptions {
  sourceDir: string;
  path: string;
  browserName: 'chrome' | 'chromium' | 'firefox';
  title?: string;
}

interface OrderedEvent {
  time: number;
  order: number;
  sequence: number;
  value: Record<string, unknown>;
}

interface TraceResource {
  sourcePath: string;
  name: string;
}

interface SnapshotFrame {
  time: number;
  name: string;
  width: number;
  height: number;
  dataUri: string;
  url: string;
}

interface ExportedAction {
  callId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

interface ActionMapping {
  class: string;
  method: string;
}

const ACTIONS: Record<string, ActionMapping> = {
  navigateTo: { class: 'Page', method: 'navigate' },
  goBack: { class: 'Page', method: 'goBack' },
  goForward: { class: 'Page', method: 'goForward' },
  reload: { class: 'Page', method: 'reload' },
  setContent: { class: 'Page', method: 'setContent' },
  click: { class: 'Element', method: 'click' },
  fill: { class: 'Element', method: 'fill' },
  clear: { class: 'Element', method: 'clear' },
  acceptDialog: { class: 'Dialog', method: 'accept' },
  dismissDialog: { class: 'Dialog', method: 'dismiss' },
};

/** Write a Vibium/Playwright-compatible trace zip from a stopped raw trace. */
export async function writeVibiumTraceZip(opts: VibiumExportOptions): Promise<void> {
  if (!opts.path) throw new Error('stopTrace({ path }) requires a non-empty zip path.');

  const raw = readRawTrace(join(opts.sourceDir, 'trace.ndjson'));
  const started = raw.find(
    (event): event is Extract<TraceEvent, { type: 'meta' }> =>
      event.type === 'meta' && typeof event.startedAt === 'string',
  );
  const startWallTime = started?.startedAt ? Date.parse(started.startedAt) : Date.now();
  const id = randomBytes(6).toString('hex');
  const contextId = `context@${id}`;
  const pageId = `page@${id}`;
  const resources: TraceResource[] = [];
  const ordered: OrderedEvent[] = [];
  const exportedActions: ExportedAction[] = [];
  let sequence = 0;
  let callCounter = 0;

  const screenshots = raw.filter(
    (event): event is Extract<TraceEvent, { type: 'screenshot' }> => event.type === 'screenshot',
  );
  const firstScreenshot = screenshots.find((event) => existsSync(join(opts.sourceDir, event.file)));
  const viewport = firstScreenshot
    ? readPngSize(readFileSync(join(opts.sourceDir, firstScreenshot.file)))
    : { width: 1280, height: 720 };

  const actionTimes: number[] = [];
  const actionEnds = new Map(
    raw.filter(
      (event): event is Extract<TraceEvent, { type: 'action-end' }> => event.type === 'action-end',
    ).map((event) => [event.actionIndex, event]),
  );
  for (const event of raw) {
    if (event.type !== 'action') continue;
    const callId = `call@${++callCounter}`;
    const actionIndex = event.actionIndex ?? callCounter;
    const completed = actionEnds.get(actionIndex);
    const endTime = Math.max(event.t + 1, completed?.t ?? event.t + 1);
    const mapping = ACTIONS[event.name] ?? { class: 'Browser', method: event.name };
    const params = actionParams(event);
    actionTimes.push(event.t);
    const before = {
      type: 'before',
      callId,
      startTime: event.t,
      class: mapping.class,
      method: mapping.method,
      pageId,
      params,
      title: actionTitle(mapping, params),
    };
    const after: Record<string, unknown> = { type: 'after', callId, endTime };
    if (completed?.error) {
      after.error = { name: 'Error', message: completed.error };
    }
    exportedActions.push({ callId, before, after });
    ordered.push({
      time: event.t,
      order: 3,
      sequence: sequence++,
      value: before,
    });
    // Older raw traces have no completion marker. Use WDIO's conservative
    // 1 ms minimum for those; current traces carry the real end timestamp.
    ordered.push({
      time: endTime,
      order: 1,
      sequence: sequence++,
      value: after,
    });
  }

  const usedResourceNames = new Set<string>();
  const addFrame = (sourcePath: string, frameTime: number): SnapshotFrame | undefined => {
    if (!existsSync(sourcePath)) return undefined;
    const data = readFileSync(sourcePath);
    const size = readPngSize(data);
    let wallTime = startWallTime + Math.max(0, Math.floor(frameTime));
    let resourceName = `${pageId}-${wallTime}.png`;
    while (usedResourceNames.has(resourceName)) {
      resourceName = `${pageId}-${++wallTime}.png`;
    }
    usedResourceNames.add(resourceName);
    resources.push({ sourcePath, name: resourceName });
    ordered.push({
      time: frameTime,
      order: 2,
      sequence: sequence++,
      value: {
        type: 'screencast-frame',
        pageId,
        sha1: resourceName,
        width: size.width,
        height: size.height,
        timestamp: frameTime,
      },
    });
    return {
      time: frameTime,
      name: resourceName,
      width: size.width,
      height: size.height,
      dataUri: `data:image/png;base64,${data.toString('base64')}`,
      url: pageUrlAt(raw, frameTime),
    };
  };
  const actionFrames = new Map<number, SnapshotFrame>();
  let finalFrame: SnapshotFrame | undefined;
  for (const event of screenshots) {
    const frameTime = event.actionIndex
      ? (actionTimes[event.actionIndex - 1] ?? event.t)
      : event.t;
    const frame = addFrame(join(opts.sourceDir, event.file), frameTime);
    if (!frame) continue;
    if (event.actionIndex !== undefined) actionFrames.set(event.actionIndex, frame);
    if (event.reason === 'final') finalFrame = frame;
  }
  // Backwards compatibility for traces produced by the first recipe draft.
  const finalScreenshot = join(opts.sourceDir, 'final.png');
  if (!finalFrame && existsSync(finalScreenshot)) {
    const finalTime = Math.max(0, ...raw.map((event) => event.t)) + 1;
    finalFrame = addFrame(finalScreenshot, finalTime);
  }

  // Vibium uses a minimal HTML document containing the screenshot as its
  // Playwright-compatible frame snapshot. This makes the main viewer panel
  // useful without pretending Craftdriver captured a restorable page DOM.
  for (let index = 0; index < exportedActions.length; index++) {
    const action = exportedActions[index];
    const beforeFrame = actionFrames.get(index + 1);
    const afterFrame = actionFrames.get(index + 2) ?? finalFrame;
    if (beforeFrame) {
      const name = `before@${action.callId}`;
      action.before.beforeSnapshot = name;
      addFrameSnapshot(ordered, action.callId, name, pageId, beforeFrame, sequence++);
    }
    if (afterFrame) {
      const name = `after@${action.callId}`;
      action.after.afterSnapshot = name;
      addFrameSnapshot(ordered, action.callId, name, pageId, afterFrame, sequence++);
    }
  }

  for (const event of raw) {
    const value = bidiEvent(event);
    if (!value) continue;
    ordered.push({ time: event.t, order: 2, sequence: sequence++, value });
  }

  ordered.sort((a, b) => a.time - b.time || a.order - b.order || a.sequence - b.sequence);
  const contextOptions = {
    version: 8,
    type: 'context-options',
    origin: 'library',
    libraryName: 'craftdriver',
    libraryVersion: pkg.version,
    browserName: opts.browserName === 'chrome' ? 'chromium' : opts.browserName,
    platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux',
    wallTime: startWallTime,
    monotonicTime: 0,
    sdkLanguage: 'javascript',
    title: opts.title ?? 'Craftdriver trace',
    contextId,
    options: { viewport },
  };
  const traceText = [contextOptions, ...ordered.map((event) => event.value)]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const networkText = buildNetworkTrace(raw, startWallTime, pageId);

  mkdirSync(dirname(opts.path), { recursive: true });
  await writeZip(opts.path, traceText, networkText, resources);
}

function addFrameSnapshot(
  ordered: OrderedEvent[],
  callId: string,
  snapshotName: string,
  pageId: string,
  frame: SnapshotFrame,
  sequence: number,
): void {
  ordered.push({
    time: frame.time,
    order: 2.5,
    sequence,
    value: {
      type: 'frame-snapshot',
      snapshot: {
        callId,
        snapshotName,
        pageId,
        frameId: pageId,
        frameUrl: frame.url,
        doctype: 'html',
        html: [
          'HTML', {},
          ['HEAD', {}],
          ['BODY', { style: 'margin:0;overflow:hidden' }, [
            'IMG', { src: frame.dataUri, style: 'width:100%' },
          ]],
        ],
        viewport: { width: frame.width, height: frame.height },
        timestamp: frame.time,
        wallTime: frame.time,
        resourceOverrides: [{ url: frame.dataUri, sha1: frame.name }],
        isMainFrame: true,
      },
    },
  });
}

function pageUrlAt(events: TraceEvent[], time: number): string {
  let url = 'about:blank';
  for (const event of events) {
    if (event.t > time) continue;
    if (event.type === 'navigation' && event.url) url = event.url;
  }
  return url;
}

function readRawTrace(path: string): TraceEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TraceEvent];
      } catch {
        return [];
      }
    });
}

function actionParams(event: Extract<TraceEvent, { type: 'action' }>): Record<string, unknown> {
  if (event.name === 'navigateTo') return { url: event.selector ?? event.args?.[0] };
  if (event.name === 'fill') return { selector: event.selector, value: event.args?.[0] };
  if (event.selector) return { selector: event.selector };
  if (event.name === 'acceptDialog' && event.args?.length) return { text: event.args[0] };
  if (event.args?.length) return { args: event.args };
  return {};
}

function actionTitle(mapping: ActionMapping, params: Record<string, unknown>): string {
  const label = params.selector ?? params.url ?? params.text;
  if (label === undefined) return `${mapping.class}.${mapping.method}()`;
  return `${mapping.class}.${mapping.method}("${String(label).slice(0, 80)}")`;
}

function bidiEvent(event: TraceEvent): Record<string, unknown> | null {
  if (event.type === 'console') {
    return {
      type: 'event',
      method: 'log.entryAdded',
      params: { type: 'console', level: event.level, text: event.text },
      time: event.t,
      class: 'BrowserContext',
    };
  }
  if (event.type === 'error') {
    return {
      type: 'event',
      method: 'log.entryAdded',
      params: { type: 'javascript', level: 'error', text: event.text },
      time: event.t,
      class: 'BrowserContext',
    };
  }
  if (event.type === 'navigation') {
    return {
      type: 'event',
      method: 'browsingContext.navigationStarted',
      params: { url: event.url, context: event.context },
      time: event.t,
      class: 'BrowserContext',
    };
  }
  return null;
}

function buildNetworkTrace(events: TraceEvent[], startWallTime: number, pageId: string): string {
  const requests: Array<Extract<TraceEvent, { type: 'request' }> & { used?: boolean }> = events
    .filter((event): event is Extract<TraceEvent, { type: 'request' }> => event.type === 'request')
    .map((event) => ({ ...event }));
  const snapshots: Record<string, unknown>[] = [];

  for (const response of events) {
    if (response.type !== 'response') continue;
    const request = requests.find((candidate) =>
      !candidate.used && (
        (response.requestId !== undefined && candidate.requestId === response.requestId) ||
        (response.requestId === undefined && candidate.url === response.url)
      ),
    );
    if (!request) continue;
    request.used = true;
    const duration = Math.max(0, response.t - request.t);
    const contentTypeHeaders = response.mimeType
      ? [{ name: 'Content-Type', value: response.mimeType }]
      : [];
    snapshots.push({
      type: 'resource-snapshot',
      snapshot: {
        startedDateTime: new Date(startWallTime + request.t).toISOString(),
        time: duration,
        request: {
          method: request.method,
          url: request.url,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          queryString: queryString(request.url),
          headersSize: -1,
          bodySize: -1,
        },
        response: {
          status: response.status,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: contentTypeHeaders,
          content: { size: 0, mimeType: response.mimeType ?? '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: -1,
        },
        cache: response.fromCache ? { _fromCache: true } : {},
        timings: { send: -1, wait: duration, receive: -1 },
        _monotonicTime: request.t,
        _frameref: pageId,
      },
    });
  }
  return snapshots.map((snapshot) => JSON.stringify(snapshot)).join('\n');
}

function queryString(url: string): Array<{ name: string; value: string }> {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function readPngSize(data: Buffer): { width: number; height: number } {
  const isPng = data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPng) return { width: 1280, height: 720 };
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function writeZip(
  path: string,
  traceText: string,
  networkText: string,
  resources: TraceResource[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(traceText, 'utf8'), 'trace.trace');
    zip.addBuffer(Buffer.from(networkText, 'utf8'), 'trace.network');
    for (const resource of resources) {
      zip.addFile(resource.sourcePath, `resources/${resource.name}`);
    }
    const output = createWriteStream(path);
    zip.outputStream.on('error', reject);
    output.on('error', reject);
    output.on('close', resolve);
    zip.outputStream.pipe(output);
    zip.end();
  });
}
