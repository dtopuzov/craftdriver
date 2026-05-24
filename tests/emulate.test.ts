import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME, IS_CHROMIUM } from './utils';

describe('browser.emulate()', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    // Reset all overrides before each test so they don't leak.
    await browser.emulate({
      colorScheme: null,
      reducedMotion: null,
      forcedColors: null,
      locale: null,
      timezoneId: null,
      offline: false,
    }).catch(() => { /* Firefox may reject media/offline; ignore in reset */ });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/emulate.html`);
  });

  it('locale changes navigator.language and Intl formatting', async () => {
    await browser.emulate({ locale: 'de-DE' });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/emulate.html`);
    await browser.expect('#lang-readout').toHaveText('de-DE');
    // 1234.5 in de-DE uses comma decimal separator
    await browser.expect('#number-readout').toHaveText('1.234,5');
  });

  it('timezoneId changes the resolved IANA zone', async () => {
    await browser.emulate({ timezoneId: 'Europe/Berlin' });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/emulate.html`);
    await browser.expect('#tz-readout').toHaveText('Europe/Berlin');
  });

  it('passing null clears a previously set override', async () => {
    await browser.emulate({ timezoneId: 'Asia/Tokyo' });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/emulate.html`);
    await browser.expect('#tz-readout').toHaveText('Asia/Tokyo');

    await browser.emulate({ timezoneId: null });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/emulate.html`);
    const tz = await browser.find('#tz-readout').text();
    expect(tz).not.toBe('Asia/Tokyo');
  });

  it.skipIf(!IS_CHROMIUM)('colorScheme: dark flips prefers-color-scheme', async () => {
    await browser.emulate({ colorScheme: 'dark' });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/emulate.html`);
    await browser.expect('#scheme-readout').toHaveText('dark');
  });

  it.skipIf(!IS_CHROMIUM)('offline: true makes fetch reject and navigator.onLine false', async () => {
    await browser.emulate({ offline: true });
    await browser.expect('#online-readout').toHaveText('offline');

    await browser.click('#fetch-btn');
    await browser.expect('#fetch-readout').toContainText('error');

    // Restore so the next test's reset doesn't run while offline.
    await browser.emulate({ offline: false });
  });

  it.skipIf(IS_CHROMIUM)('throws a clear error for Chromium-only fields on Firefox', async () => {
    await expect(browser.emulate({ colorScheme: 'dark' })).rejects.toThrow(/not supported on Firefox/);
  });

  it('throws a clear error when BiDi is disabled', async () => {
    const noBidi = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
    try {
      await expect(noBidi.emulate({ locale: 'de-DE' })).rejects.toThrow(/emulate\(\) requires BiDi/);
    } finally {
      await noBidi.quit();
    }
  });
});
