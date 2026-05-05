/**
 * Firefox smoke test.
 *
 * Run with: BROWSER_NAME=firefox npm test -- tests/firefox-smoke.test.ts
 *
 * Validates that the FirefoxService + Builder branch can launch
 * geckodriver, negotiate a BiDi WebSocket, navigate, find/click/fill
 * elements, and evaluate JS. If this passes, the full suite is the
 * next gate.
 */
import { describe, it, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe.runIf(BROWSER_NAME === 'firefox')('Firefox smoke', () => {
  it('launches Firefox, enables BiDi, and runs the basics', async () => {
    const browser = await Browser.launch({ browserName: 'firefox' });
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
