import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, Page } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Pages (tabs / popups)', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${baseUrl}/popup.html`);
  });

  it('browser.pages() lists the current top-level page', async () => {
    const pages = await browser.pages();
    expect(pages.length).toBeGreaterThanOrEqual(1);
  });

  it('waitForPage() captures a popup opened by a button click', async () => {
    const popup = await browser.waitForPage(async () => {
      await browser.click('#open-popup');
    });

    await popup.waitForLoadState('load');
    // Firefox may report load before document.title is populated — poll until it is.
    await expect.poll(() => popup.title(), { timeout: 5000 }).toBe('Popup Target');
  });

  it('popup Page.url() returns the popup URL', async () => {
    const popup = await browser.waitForPage(async () => {
      await browser.click('#open-popup');
    });
    await popup.waitForLoadState('load');
    // Firefox may briefly report about:blank for a freshly opened popup — poll.
    await expect.poll(() => popup.url(), { timeout: 5000 }).toContain('popup-target.html');
  });

  it('popup Page can find elements', async () => {
    const popup = await browser.waitForPage(async () => {
      await browser.click('#open-popup');
    });
    await popup.waitForLoadState('load');
    const text = await popup.find('#popup-heading').text();
    expect(text).toBe('Popup Window');
  });

  it('popup Page.evaluate() runs script in the popup', async () => {
    const popup = await browser.waitForPage(async () => {
      await browser.click('#open-popup');
    });
    await popup.waitForLoadState('load');
    // Firefox may report load before document.title is populated — poll until it is.
    await expect
      .poll(() => popup.evaluate<string>(() => document.title), { timeout: 5000 })
      .toBe('Popup Target');
  });

  it('openPage({ type: "tab" }) opens and navigates a new tab', async () => {
    const page = await browser.openPage({
      url: `${baseUrl}/popup-target.html`,
      type: 'tab',
    });
    await page.waitForLoadState('load');
    expect(await page.title()).toBe('Popup Target');
    expect(await page.url()).toContain('popup-target.html');
  });

  it('openPage() without a url returns an empty new tab', async () => {
    const page = await browser.openPage();
    expect(page).toBeInstanceOf(Page);
    expect(typeof page.id()).toBe('string');
  });
});

describe('openPage() in Classic mode', () => {
  it('throws a clear error when BiDi is disabled', async () => {
    const browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
    try {
      await expect(browser.openPage({ url: 'about:blank' })).rejects.toThrow(
        /openPage\(\) requires BiDi/
      );
    } finally {
      await browser.quit();
    }
  });
});
