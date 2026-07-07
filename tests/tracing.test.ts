import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('Tracing', () => {
  let browser: Browser;
  let tmpRoot: string;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: true });
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
