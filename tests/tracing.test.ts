import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Browser } from '../src';
import type { TraceEvent } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

function parseTraceLine(line: string): TraceEvent | null {
  try {
    return JSON.parse(line) as TraceEvent;
  } catch {
    return null;
  }
}

/** Parse an ndjson file, tolerating a missing trailing newline / partial last line. */
function readNdjson(path: string): TraceEvent[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map(parseTraceLine)
    .filter((e): e is TraceEvent => e !== null);
}

/** Minimal zip reader for assertions; supports the stored/deflated entries written by yazl. */
function readZipEntries(path: string): Map<string, Buffer> {
  const archive = readFileSync(path);
  const entries = new Map<string, Buffer>();
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = archive.indexOf(centralSignature);

  while (offset !== -1) {
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
    offset = archive.indexOf(
      centralSignature,
      offset + 46 + nameLength + extraLength + commentLength,
    );
  }
  return entries;
}

describe('Tracing', () => {
  let browser: Browser;
  let tmpRoot: string;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'craftdriver-trace-'));
  });

  afterEach(async () => {
    // Make sure no trace leaks across tests.
    await browser.stopTrace().catch(() => undefined);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('streams events to trace.ndjson and writes start+end meta lines', async () => {
    const dir = join(tmpRoot, 't1');
    await browser.startTrace({ outDir: dir, screenshots: 'off' });
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.fill('#username', 'alice');
    await browser.click('#submit');
    await browser.stopTrace();

    const events = readNdjson(join(dir, 'trace.ndjson'));
    const metas = events.filter((e) => e.type === 'meta');
    expect(metas.length).toBe(2);
    expect((metas[0] as { startedAt?: string }).startedAt).toBeDefined();
    expect((metas[1] as { endedAt?: string }).endedAt).toBeDefined();

    const actions = events.filter(
      (e): e is Extract<TraceEvent, { type: 'action' }> => e.type === 'action'
    );
    expect(actions.map((a) => a.name)).toEqual(['navigateTo', 'fill', 'click']);
    const fill = actions.find((a) => a.name === 'fill')!;
    expect(fill.args).toEqual(['alice']);
    expect(fill.selector).toBe('#username');
    const actionEnds = events.filter(
      (e): e is Extract<TraceEvent, { type: 'action-end' }> => e.type === 'action-end'
    );
    expect(actionEnds).toHaveLength(actions.length);
    for (const action of actions) {
      const end = actionEnds.find((event) => event.actionIndex === action.actionIndex)!;
      expect(end.t).toBeGreaterThanOrEqual(action.t);
    }

    // Response events should carry the document mimeType.
    const htmlResponse = events.find(
      (e): e is Extract<TraceEvent, { type: 'response' }> =>
        e.type === 'response' && typeof e.mimeType === 'string' && e.mimeType.includes('html')
    );
    expect(htmlResponse).toBeDefined();
  });

  it('trace is on disk even when stopTrace is never called (test-throws scenario)', async () => {
    const dir = join(tmpRoot, 'crash');
    await browser.startTrace({ outDir: dir, screenshots: 'off' });
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.fill('#username', 'bob');
    await browser.click('#submit');

    // Simulate a test throwing here — DON'T call stopTrace yet.
    // The file must already contain the events we recorded.
    const events = readNdjson(join(dir, 'trace.ndjson'));
    const actionNames = events
      .filter((e) => e.type === 'action')
      .map((e) => (e as Extract<TraceEvent, { type: 'action' }>).name);
    expect(actionNames).toEqual(['navigateTo', 'fill', 'click']);

    // No closing meta line because stop wasn't called.
    const metas = events.filter((e) => e.type === 'meta');
    expect(metas.length).toBe(1);
    expect((metas[0] as { endedAt?: string }).endedAt).toBeUndefined();

    // Cleanup for afterEach.
    await browser.stopTrace();
  });

  it('captures screenshots into <outDir>/screenshots/ as PNGs', async () => {
    const dir = join(tmpRoot, 'shots');
    await browser.startTrace({ outDir: dir }); // default: screenshots auto
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.click('#submit');
    await browser.stopTrace();

    const events = readNdjson(join(dir, 'trace.ndjson'));
    const shots = events.filter(
      (e): e is Extract<TraceEvent, { type: 'screenshot' }> => e.type === 'screenshot'
    );
    expect(shots.length).toBeGreaterThanOrEqual(2);

    const shotDir = join(dir, 'screenshots');
    expect(existsSync(shotDir)).toBe(true);
    const files = readdirSync(shotDir);
    expect(files.length).toBe(shots.length);
    for (const f of files) {
      expect(f).toMatch(/^\d{4}\.png$/);
    }
    // Referenced files exist.
    for (const s of shots) {
      expect(existsSync(join(dir, s.file))).toBe(true);
    }
  });

  it('exports a Vibium Player compatible trace zip', async () => {
    const dir = join(tmpRoot, 'vibium');
    const zipPath = join(tmpRoot, 'failure-trace.zip');
    await browser.startTrace({ outDir: dir, title: 'Craftdriver login flow' });
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.fill('#username', 'alice');
    await browser.click('#submit');
    await browser.stopTrace({ path: zipPath });

    const entries = readZipEntries(zipPath);
    expect(entries.has('trace.trace')).toBe(true);
    expect(entries.has('trace.network')).toBe(true);

    const timeline = entries.get('trace.trace')!.toString('utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(timeline[0]).toMatchObject({
      version: 8,
      type: 'context-options',
      libraryName: 'craftdriver',
      title: 'Craftdriver login flow',
    });
    const befores = timeline.filter((event) => event.type === 'before');
    const afters = timeline.filter((event) => event.type === 'after');
    expect(befores).toHaveLength(3);
    expect(afters).toHaveLength(3);
    for (const before of befores) {
      const after = afters.find((event) => event.callId === before.callId)!;
      expect(Number(after.endTime) - Number(before.startTime)).toBeGreaterThanOrEqual(1);
      expect(before.beforeSnapshot).toBe(`before@${String(before.callId)}`);
      expect(after.afterSnapshot).toBe(`after@${String(before.callId)}`);
    }
    const frames = timeline.filter((event) => event.type === 'screencast-frame');
    expect(frames.length).toBeGreaterThanOrEqual(4);
    for (const frame of frames) {
      expect(String(frame.sha1)).toMatch(/^page@[a-f0-9]+-\d+\.png$/);
      expect(entries.has(`resources/${String(frame.sha1)}`)).toBe(true);
    }
    const snapshots = timeline.filter((event) => event.type === 'frame-snapshot');
    expect(snapshots).toHaveLength(6);
    expect(JSON.stringify(snapshots[0])).toContain('data:image/png;base64,');
    const eventTime = (event: Record<string, unknown>): number => {
      if (event.type === 'context-options') return Number(event.monotonicTime);
      if (event.type === 'screencast-frame') return Number(event.timestamp);
      if (event.type === 'before') return Number(event.startTime);
      if (event.type === 'after') return Number(event.endTime);
      if (event.type === 'event') return Number(event.time);
      const snapshot = event.snapshot as Record<string, unknown> | undefined;
      return Number(snapshot?.timestamp ?? 0);
    };
    expect(timeline.map(eventTime)).toEqual([...timeline.map(eventTime)].sort((a, b) => a - b));

    const rawEvents = readNdjson(join(dir, 'trace.ndjson'));
    expect(rawEvents.some(
      (event) => event.type === 'screenshot' && event.reason === 'final'
    )).toBe(true);

    const network = entries.get('trace.network')!.toString('utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(network.some((event) => event.type === 'resource-snapshot')).toBe(true);
  });

  it('snaps a screenshot on page errors', async () => {
    const dir = join(tmpRoot, 'err');
    await browser.startTrace({ outDir: dir });
    await browser.navigateTo(`${baseUrl}/console-errors.html`);
    await browser.click('#btn-throw-error');
    await browser.pause(300); // let BiDi flush the error event
    await browser.stopTrace();

    const events = readNdjson(join(dir, 'trace.ndjson'));
    const errorShots = events.filter(
      (e): e is Extract<TraceEvent, { type: 'screenshot' }> =>
        e.type === 'screenshot' && e.reason === 'error'
    );
    expect(errorShots.length).toBeGreaterThanOrEqual(1);
  });

  it('opt-outs: actions:false and screenshots:off both work', async () => {
    const dir = join(tmpRoot, 'opt');
    await browser.startTrace({ outDir: dir, actions: false, screenshots: 'off' });
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.click('#submit');
    await browser.stopTrace();

    const events = readNdjson(join(dir, 'trace.ndjson'));
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).not.toContain('action');
    expect(eventTypes).not.toContain('screenshot');
    // Navigation pillar still on.
    expect(eventTypes).toContain('navigation');
    expect(existsSync(join(dir, 'screenshots'))).toBe(false);
  });

  it('throws when started without BiDi', async () => {
    const classic = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
    try {
      await expect(classic.startTrace({ outDir: join(tmpRoot, 'x') })).rejects.toThrow(/BiDi/);
    } finally {
      await classic.quit();
    }
  });

  it('throws when stopTrace called without an active trace', async () => {
    await expect(browser.stopTrace()).rejects.toThrow(/no trace is running/);
  });
});
