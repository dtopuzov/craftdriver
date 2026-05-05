import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Tracing', () => {
  let browser: Browser;
  let workDir: string;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
    if (workDir && existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'craftdriver-trace-'));
    // Defensive: ensure no trace is running from a previous failed test.
    try { await browser.stopTrace(join(workDir, '_cleanup.json')); } catch { /* none */ }
  });

  it('captures navigation, request, response and console events', async () => {
    const tracePath = join(workDir, 'trace.json');

    await browser.startTrace();
    await browser.navigateTo(`${baseUrl}/network.html`);
    await browser.click('#fetch-users-btn');
    await browser.network.waitForNetworkIdle({ idleDuration: 300 });
    await browser.evaluate(() => console.log('hello from trace'));

    const bundle = await browser.stopTrace(tracePath);

    expect(existsSync(tracePath)).toBe(true);
    expect(bundle.startedAt).toBeTruthy();
    expect(bundle.endedAt).toBeTruthy();
    expect(bundle.events.length).toBeGreaterThan(0);

    const types = new Set(bundle.events.map((e) => e.type));
    expect(types.has('request')).toBe(true);
    expect(types.has('response')).toBe(true);
    expect(types.has('navigation')).toBe(true);
    expect(types.has('console')).toBe(true);

    // The on-disk bundle round-trips.
    const parsed = JSON.parse(readFileSync(tracePath, 'utf8'));
    expect(parsed.events.length).toBe(bundle.events.length);
  });

  it('writes screenshots when enabled', async () => {
    const tracePath = join(workDir, 'with-shots.json');

    await browser.startTrace({ screenshots: true, screenshotInterval: 250 });
    await browser.navigateTo(`${baseUrl}/network.html`);
    await browser.pause(700);
    const bundle = await browser.stopTrace(tracePath);

    const shotsDir = join(workDir, 'screenshots');
    expect(existsSync(shotsDir)).toBe(true);
    const shots = readdirSync(shotsDir).filter((f) => f.endsWith('.png'));
    expect(shots.length).toBeGreaterThan(0);

    const screenshotEvents = bundle.events.filter((e) => e.type === 'screenshot');
    expect(screenshotEvents.length).toBe(shots.length);
  });

  it('stopTrace without a running trace throws', async () => {
    await expect(browser.stopTrace(join(workDir, 'nope.json')))
      .rejects.toThrow(/no trace is running/);
  });

  it('startTrace twice without stop throws', async () => {
    await browser.startTrace();
    try {
      await expect(browser.startTrace()).rejects.toThrow(/already running/);
    } finally {
      await browser.stopTrace(join(workDir, 'cleanup.json'));
    }
  });
});

describe('Tracing in Classic mode', () => {
  it('startTrace throws a clear error when BiDi is disabled', async () => {
    const browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
    try {
      await expect(browser.startTrace()).rejects.toThrow(/startTrace\(\) requires BiDi/);
    } finally {
      await browser.quit();
    }
  });
});
