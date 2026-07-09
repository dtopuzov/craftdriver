/**
 * Chrome smoke test — twin of tests/firefox-smoke.test.ts.
 *
 * Run with: npm test -- tests/chrome-smoke.test.ts
 *
 * Validates that the ChromeService + Builder branch can launch chromedriver,
 * negotiate a BiDi WebSocket, navigate, find/click/fill elements, and
 * evaluate JS. Kept as a single small file so it can run in isolation as a
 * fast cross-platform confidence check (see the `cross-platform-smoke` CI
 * job in .github/workflows/ci.yml) without running the full suite.
 */
import { describe, it, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe.runIf(BROWSER_NAME === 'chrome')('Chrome smoke', () => {
  it('launches Chrome, enables BiDi, and runs the basics', async () => {
    const browser = await Browser.launch({ browserName: 'chrome' });
    try {
      expect(browser.isBiDiEnabled()).toBe(true);

      await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);

      await browser.fill('#username', 'testuser');
      await browser.fill('#password', 'secret');
      await browser.click('#submit');

      await browser.find('#result').expect().toContainText('Welcome back');

      const title: string = await browser.evaluate(() => document.title);
      expect(typeof title).toBe('string');
      expect(title.length).toBeGreaterThan(0);
    } finally {
      await browser.quit();
    }
  });
});
