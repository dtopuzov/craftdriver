import { describe, it, afterEach, expect } from 'vitest';
import { Browser } from '../src';
import { BROWSER_NAME, IS_CHROMIUM } from './utils';

describe('Browser.launch() options', () => {
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.quit();
    browser = undefined;
  });

  // `args` is a Chromium-flag passthrough here (`--user-agent`); Firefox sets
  // its UA via a pref, not a CLI flag, so this assertion is Chromium-only.
  it.runIf(IS_CHROMIUM)('args: forwards browser flags to goog:chromeOptions.args', async () => {
    const ua = 'CraftdriverArgsTest/1.0';
    browser = await Browser.launch({ browserName: BROWSER_NAME, args: [`--user-agent=${ua}`] });
    const actual = await browser.evaluate<string>('return navigator.userAgent');
    expect(actual).toBe(ua);
  });

  it('args: omitting the option leaves launch unaffected', async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    expect(browser.isBiDiEnabled()).toBe(true);
  });
});
