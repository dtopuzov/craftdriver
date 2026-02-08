import { describe, it, afterEach } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL } from './utils';

describe('Mobile Emulation', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  afterEach(async () => {
    await browser.quit();
  });

  it('emulates iPhone 14 using device preset', async () => {
    browser = await Browser.launch({
      browserName: 'chrome',
      mobileEmulation: 'iPhone 14',
    });

    await browser.navigateTo(`${baseUrl}/mobile.html`);

    // Verify viewport width matches iPhone 14 (390px)
    await browser.expect('#viewport-width').toHaveText('390px');

    // Verify device pixel ratio
    await browser.expect('#pixel-ratio').toHaveText('3');

    // Verify touch support is enabled
    await browser.expect('#touch-support').toContainText('Yes');

    // Verify mobile user agent
    await browser.expect('#user-agent').toContainText('iPhone');
  });

  it('emulates Pixel 7 using device preset', async () => {
    browser = await Browser.launch({
      browserName: 'chrome',
      mobileEmulation: 'Pixel 7',
    });

    await browser.navigateTo(`${baseUrl}/mobile.html`);

    // Verify viewport width matches Pixel 7 (412px)
    await browser.expect('#viewport-width').toHaveText('412px');

    // Verify Android user agent
    await browser.expect('#user-agent').toContainText('Android');
    await browser.expect('#user-agent').toContainText('Pixel 7');
  });

  it('uses custom device metrics', async () => {
    browser = await Browser.launch({
      browserName: 'chrome',
      mobileEmulation: {
        deviceMetrics: {
          width: 320,
          height: 568,
          pixelRatio: 2,
          mobile: true,
          touch: true,
        },
        userAgent: 'CustomMobileAgent/1.0',
      },
    });

    await browser.navigateTo(`${baseUrl}/mobile.html`);

    // Verify custom viewport
    await browser.expect('#viewport-width').toHaveText('320px');
    await browser.expect('#pixel-ratio').toHaveText('2');

    // Verify custom user agent
    await browser.expect('#user-agent').toContainText('CustomMobileAgent');

    // Verify touch support
    await browser.expect('#touch-support').toContainText('Yes');
  });

  it('shows mobile view indicator for narrow viewport', async () => {
    browser = await Browser.launch({
      browserName: 'chrome',
      mobileEmulation: 'iPhone SE',
    });

    await browser.navigateTo(`${baseUrl}/mobile.html`);

    // iPhone SE width is 375px - should show mobile view
    await browser.expect('#responsive-indicator').toContainText('Mobile View');
  });

  it('shows portrait orientation for tall viewport', async () => {
    browser = await Browser.launch({
      browserName: 'chrome',
      mobileEmulation: {
        deviceMetrics: { width: 390, height: 844, pixelRatio: 3 },
      },
    });

    await browser.navigateTo(`${baseUrl}/mobile.html`);

    // Tall viewport = portrait
    await browser.expect('#orientation-box').toContainText('Portrait');
  });
});
