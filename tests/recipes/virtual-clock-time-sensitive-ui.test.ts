// Runnable proof for docs/recipes/virtual-clock-time-sensitive-ui.md
// The MD "debounce" block is the first test's body; the "fixed date" block is
// the second test's body (real deployed URL instead of the local one).
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('drive time-sensitive UI with the virtual clock', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterEach(async () => {
    await browser.clock.uninstall();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('fires the debounced search only after the 300ms window', async () => {
    await browser.clock.install();
    await browser.navigateTo(`${baseUrl}/clock.html`);

    await browser.fill('#search-input', 'lap');

    await browser.clock.tick(299); // just before the debounce threshold
    await browser.expect('#search-count').toHaveText('0');

    await browser.clock.tick(2); // crosses 300ms — the search fires once
    await browser.expect('#search-count').toHaveText('1');
  });

  it('freezes the wall clock for a date-dependent banner', async () => {
    await browser.clock.setFixedTime('2026-06-15T23:59:00Z');
    await browser.navigateTo(`${baseUrl}/clock.html`);

    await browser.expect('#trial-banner').toContainText('Trial expires today');
  });
});
