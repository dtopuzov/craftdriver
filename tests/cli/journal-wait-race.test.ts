/**
 * Retained reproduction: a wait that only subscribes misses what already
 * arrived.
 *
 * An agent's loop is act → then ask. By the time it asks, the console message
 * or network response it cares about is usually already in the buffer, so a
 * wait implemented purely as "subscribe and hope it happens again" times out
 * on the common case rather than the rare one.
 *
 * This pins the current library behavior so the CLI journal's own wait can be
 * shown to differ. It is a characterization of `LogMonitor`, not a demand that
 * `LogMonitor` change — the public wait keeps its subscribe-only semantics.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

const FIXTURE = `${EXAMPLES_BASE_URL}/console-errors.html`;

describe('console wait and already-buffered entries', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    await browser.navigateTo(FIXTURE);
  });

  afterAll(async () => {
    await browser.quit();
  });

  // A marker nothing else can emit. The fixture also logs on load, so
  // matching on a level or method would let an unrelated message satisfy the
  // wait and hide the behavior under test.
  const MARKER = `journal-marker-${Date.now()}`;

  it('buffers the message, so it is observable after the fact', async () => {
    await browser.evaluate(`console.log(${JSON.stringify(MARKER)}); return 1`);
    // Poll: evaluate returns when the driver says so, not when the BiDi log
    // event has been delivered. This settles the timing the next test needs.
    let seen = false;
    for (let i = 0; i < 50 && !seen; i++) {
      seen = browser.logs.getMessages().some((m) => m.text.includes(MARKER));
      if (!seen) await new Promise((r) => setTimeout(r, 100));
    }
    expect(seen).toBe(true);
  }, 60_000);

  it('but waitForConsole cannot see it, because it only subscribes', async () => {
    // The marker is provably in the buffer, and nothing will emit it again. A
    // wait that checked existing entries first would resolve immediately;
    // this one waits for a second occurrence that cannot come.
    await expect(
      browser.logs.waitForConsole((m) => m.text.includes(MARKER), 3_000),
    ).rejects.toThrow(/Timeout waiting for console message/);
  }, 60_000);
});
