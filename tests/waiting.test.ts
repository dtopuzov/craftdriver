import { describe, it, beforeAll, afterAll } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Waiting and Dynamic Elements', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('element not in DOM appears after ~1s', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/dynamic.html`);
    await browser.click('#btn-appear');
    await browser.expect('#delayed-greeting').toHaveText('Hello after 1s');
  });

  it('element hidden becomes visible after 1s', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/dynamic.html`);
    await browser.click('#btn-unhide');
    await browser.expect('#hidden-el').toBeVisible({ timeout: 5000 });
  });

  it('visible element is removed immediately', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/dynamic.html`);
    await browser.click('#btn-remove');
    await browser.expect('#to-remove').not.toBeVisible({ timeout: 2000 });
  });

  it('visible element becomes hidden immediately', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/dynamic.html`);
    await browser.click('#btn-hide');
    await browser.expect('#to-hide').not.toBeVisible({ timeout: 2000 });
  });

  describe('waitFor* convenience methods', () => {
    it('waitForVisible() waits for element to be visible', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
      await browser.waitForVisible('#username');
    });

    it('waitForAttached() waits for element to exist in DOM', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
      await browser.waitForAttached('#submit');
    });
  });
});
