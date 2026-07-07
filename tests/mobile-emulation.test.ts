import { describe, it, afterEach } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL } from './utils';

describe('Mobile Emulation', () => {
  let browser: Browser | undefined;
  const baseUrl = EXAMPLES_BASE_URL;

  async function launchMobile(options: Parameters<typeof Browser.launch>[0]): Promise<Browser> {
    browser = await Browser.launch(options);
    return browser;
  }

  afterEach(async () => {
    await browser?.quit();
    browser = undefined;
  });

  it('emulates iPhone 14 using device preset', async () => {
    const mobileBrowser = await launchMobile({
      browserName: 'chrome',
      mobileEmulation: 'iPhone 14',
    });

    await mobileBrowser.navigateTo(`${baseUrl}/mobile.html`);

    // Verify viewport width matches iPhone 14 (390px)
    await mobileBrowser.expect('#viewport-width').toHaveText('390px');

    // Verify device pixel ratio
    await mobileBrowser.expect('#pixel-ratio').toHaveText('3');

    // Verify touch support is enabled
    await mobileBrowser.expect('#touch-support').toContainText('Yes');

    // Verify mobile user agent
    await mobileBrowser.expect('#user-agent').toContainText('iPhone');
  });

  it('emulates Pixel 7 using device preset', async () => {
    const mobileBrowser = await launchMobile({
      browserName: 'chrome',
      mobileEmulation: 'Pixel 7',
    });

    await mobileBrowser.navigateTo(`${baseUrl}/mobile.html`);

    // Verify viewport width matches Pixel 7 (412px)
    await mobileBrowser.expect('#viewport-width').toHaveText('412px');

    // Verify Android user agent
    await mobileBrowser.expect('#user-agent').toContainText('Android');
    await mobileBrowser.expect('#user-agent').toContainText('Pixel 7');
  });

  it('uses custom device metrics', async () => {
    const mobileBrowser = await launchMobile({
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

    await mobileBrowser.navigateTo(`${baseUrl}/mobile.html`);

    // Verify custom viewport
    await mobileBrowser.expect('#viewport-width').toHaveText('320px');
    await mobileBrowser.expect('#pixel-ratio').toHaveText('2');

    // Verify custom user agent
    await mobileBrowser.expect('#user-agent').toContainText('CustomMobileAgent');

    // Verify touch support
    await mobileBrowser.expect('#touch-support').toContainText('Yes');
  });

  it('shows mobile view indicator for narrow viewport', async () => {
    const mobileBrowser = await launchMobile({
      browserName: 'chrome',
      mobileEmulation: 'iPhone SE',
    });

    await mobileBrowser.navigateTo(`${baseUrl}/mobile.html`);

    // iPhone SE width is 375px - should show mobile view
    await mobileBrowser.expect('#responsive-indicator').toContainText('Mobile View');
  });

  it('shows portrait orientation for tall viewport', async () => {
    const mobileBrowser = await launchMobile({
      browserName: 'chrome',
      mobileEmulation: {
        deviceMetrics: { width: 390, height: 844, pixelRatio: 3 },
      },
    });

    await mobileBrowser.navigateTo(`${baseUrl}/mobile.html`);

    // Tall viewport = portrait
    await mobileBrowser.expect('#orientation-box').toContainText('Portrait');
  });
});
