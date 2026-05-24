import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

const CLOCK_URL = `${EXAMPLES_BASE_URL}/clock.html`;

describe('browser.clock', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    // Restore the real clock so each test starts from a clean slate.
    await browser.clock.uninstall();
    await browser.navigateTo(CLOCK_URL);
  });

  // ── install ──────────────────────────────────────────────────────────────

  it('install() fakes Date.now(), new Date(), and performance.now()', async () => {
    await browser.clock.install({ time: 1_000_000 });

    expect(await browser.evaluate(() => Date.now())).toBe(1_000_000);
    expect(await browser.evaluate(() => new Date().getTime())).toBe(1_000_000);
    // performance.now() starts at 0 and advances with the virtual clock
    expect(await browser.evaluate(() => performance.now())).toBe(0);
    await browser.clock.tick(500);
    expect(await browser.evaluate(() => performance.now())).toBe(500);
  });

  // ── tick ─────────────────────────────────────────────────────────────────

  it('tick() fires setTimeout at the exact millisecond boundary, not before', async () => {
    await browser.clock.install({ time: 0 });
    await browser.evaluate(() => {
      (window as any).__fired = false;
      setTimeout(() => { (window as any).__fired = true; }, 500);
    });

    await browser.clock.tick(499);
    expect(await browser.evaluate(() => (window as any).__fired)).toBe(false);
    expect(await browser.evaluate(() => Date.now())).toBe(499);

    await browser.clock.tick(1); // total 500 ms
    expect(await browser.evaluate(() => (window as any).__fired)).toBe(true);
    expect(await browser.evaluate(() => Date.now())).toBe(500);
  });

  it('tick() fires setInterval on every period; clearInterval stops further firings', async () => {
    await browser.clock.install({ time: 0 });
    await browser.evaluate(() => {
      (window as any).__count = 0;
      (window as any).__id = setInterval(() => { (window as any).__count++; }, 100);
    });

    await browser.clock.tick(500);
    expect(await browser.evaluate(() => (window as any).__count)).toBe(5);

    await browser.evaluate(() => clearInterval((window as any).__id));
    await browser.clock.tick(500);
    // count must stay at 5 — clearInterval took effect
    expect(await browser.evaluate(() => (window as any).__count)).toBe(5);
  });

  it('tick(0) flushes zero-delay timers; clearTimeout prevents a timer from firing', async () => {
    await browser.clock.install({ time: 0 });
    await browser.evaluate(() => {
      (window as any).__zero = false;
      (window as any).__cancelled = false;
      setTimeout(() => { (window as any).__zero = true; }, 0);
      const id = setTimeout(() => { (window as any).__cancelled = true; }, 0);
      clearTimeout(id);
    });

    await browser.clock.tick(0);
    expect(await browser.evaluate(() => (window as any).__zero)).toBe(true);
    expect(await browser.evaluate(() => (window as any).__cancelled)).toBe(false);
  });

  // ── fastForward ──────────────────────────────────────────────────────────

  it('fastForward() parses MM:SS and HH:MM:SS duration strings', async () => {
    // MM:SS — fire the 15-minute idle-logout timer built into clock.html
    await browser.clock.install();
    await browser.navigateTo(CLOCK_URL); // preload applies on this nav
    await browser.clock.fastForward('15:01');
    expect(await browser.evaluate(() =>
      document.getElementById('login-modal')!.classList.contains('visible')
    )).toBe(true);

    // HH:MM:SS — re-install to reset, then verify the three-part parser
    await browser.clock.install({ time: 0 });
    await browser.clock.fastForward('01:00:00'); // 1 hour = 3 600 000 ms
    expect(await browser.evaluate(() => Date.now())).toBe(3_600_000);
  });

  // ── setFixedTime ─────────────────────────────────────────────────────────

  it('setFixedTime() freezes Date.now() and new Date() — accepts number, string, and Date', async () => {
    // number
    await browser.clock.setFixedTime(42_000);
    expect(await browser.evaluate(() => Date.now())).toBe(42_000);
    expect(await browser.evaluate(() => new Date().getTime())).toBe(42_000);

    // ISO string
    const fromString = new Date('2030-06-01T12:00:00Z').getTime();
    await browser.clock.setFixedTime('2030-06-01T12:00:00Z');
    expect(await browser.evaluate(() => Date.now())).toBe(fromString);

    // Date object
    const d = new Date('2028-01-01T00:00:00Z');
    await browser.clock.setFixedTime(d);
    expect(await browser.evaluate(() => Date.now())).toBe(d.getTime());
  });

  it('setFixedTime() — trial banner shows correct state before and after the deadline', async () => {
    // The fixture deadline is 2026-06-16T00:00:00Z (hardcoded in clock.html).
    // setFixedTime controls Date.now() in the page, so this test is date-independent.

    // One minute before — banner shows "expires today"
    await browser.clock.setFixedTime('2026-06-15T23:59:00Z');
    await browser.navigateTo(CLOCK_URL);
    expect(await browser.evaluate(() =>
      document.getElementById('trial-banner')!.textContent
    )).toContain('expires today');

    // One second after — banner shows "expired"
    await browser.clock.setFixedTime('2026-06-16T00:00:01Z');
    await browser.navigateTo(CLOCK_URL);
    expect(await browser.evaluate(() =>
      document.getElementById('trial-banner')!.textContent
    )).toContain('expired');
  });

  it('setFixedTime() preload survives navigations', async () => {
    const frozenMs = 12_345_678;
    await browser.clock.setFixedTime(frozenMs);

    await browser.navigateTo(CLOCK_URL);
    expect(await browser.evaluate(() => Date.now())).toBe(frozenMs);

    await browser.navigateTo(CLOCK_URL);
    expect(await browser.evaluate(() => Date.now())).toBe(frozenMs);
  });

  // ── setSystemTime ────────────────────────────────────────────────────────

  it('setSystemTime() moves the virtual clock without firing timers; tick() continues from the new base', async () => {
    await browser.clock.install({ time: 0 });
    await browser.evaluate(() => {
      (window as any).__count = 0;
      setInterval(() => { (window as any).__count++; }, 100);
    });

    // Jump ahead — no timers should fire during the jump
    await browser.clock.setSystemTime(500);
    expect(await browser.evaluate(() => (window as any).__count)).toBe(0);

    // Tick 500 ms from t=500 → t=1000 — intervals fire 5 times (at 600, 700, 800, 900, 1000)
    await browser.clock.tick(500);
    expect(await browser.evaluate(() => (window as any).__count)).toBe(5);
    expect(await browser.evaluate(() => Date.now())).toBe(1000);
  });

  // ── runFor ───────────────────────────────────────────────────────────────

  it('runFor() fires timers and lets async callbacks settle between frames', async () => {
    await browser.clock.install({ time: 0 });
    await browser.evaluate(() => {
      (window as any).__done = false;
      setTimeout(() => {
        Promise.resolve().then(() => { (window as any).__done = true; });
      }, 50);
    });

    await browser.clock.runFor(100);
    expect(await browser.evaluate(() => (window as any).__done)).toBe(true);
  });

  // ── real-world scenario ──────────────────────────────────────────────────

  it('tick() controls a 300 ms debounced input — fires exactly once after the threshold', async () => {
    await browser.clock.install();
    await browser.navigateTo(CLOCK_URL);

    await browser.fill('#search-input', 'lap');

    await browser.clock.tick(299); // just before the 300 ms debounce
    expect(await browser.evaluate(() =>
      parseInt(document.getElementById('search-count')!.textContent || '0', 10)
    )).toBe(0);

    await browser.clock.tick(2); // total 301 ms — debounce fires once
    expect(await browser.evaluate(() =>
      parseInt(document.getElementById('search-count')!.textContent || '0', 10)
    )).toBe(1);
  });

  // ── preload & idempotency ────────────────────────────────────────────────

  it('install() preload survives navigations; re-install resets the virtual time', async () => {
    await browser.clock.install({ time: 0 });

    await browser.navigateTo(CLOCK_URL);
    expect(await browser.evaluate(() => Date.now())).toBe(0);

    await browser.navigateTo(CLOCK_URL);
    expect(await browser.evaluate(() => Date.now())).toBe(0);

    // Advance the clock, then re-install to a new time — queue must reset
    await browser.clock.tick(5_000);
    await browser.clock.install({ time: 99 });
    expect(await browser.evaluate(() => Date.now())).toBe(99);
  });

  // ── uninstall ─────────────────────────────────────────────────────────────

  it('uninstall() restores real Date.now() after install() and after setFixedTime()', async () => {
    await browser.clock.install({ time: 0 });
    expect(await browser.evaluate(() => Date.now())).toBe(0);
    await browser.clock.uninstall();
    expect(await browser.evaluate(() => Date.now())).toBeGreaterThan(1_000_000_000_000);

    await browser.clock.setFixedTime(42);
    expect(await browser.evaluate(() => Date.now())).toBe(42);
    await browser.clock.uninstall();
    expect(await browser.evaluate(() => Date.now())).toBeGreaterThan(1_000_000_000_000);
  });
});

