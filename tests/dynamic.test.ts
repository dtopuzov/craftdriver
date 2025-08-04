import { describe, it, beforeAll, afterAll } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL } from './utils';

describe('Dynamic elements (local app)', () => {
  let browser!: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: 'chrome' });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('element not in DOM appears after ~2s', async () => {
    await browser.navigateTo(`${baseUrl}/dynamic.html`);
    await browser.click('#btn-appear');
    await browser.expect('#delayed-greeting').toHaveText('Hello after 2s');
  });

  it('element hidden becomes visible after 2s', async () => {
    await browser.navigateTo(`${baseUrl}/dynamic.html`);
    await browser.click('#btn-unhide');
    await browser.expect('#hidden-el').toBeVisible({ timeout: 5000 });
  });

  it('visible element is removed immediately', async () => {
    await browser.navigateTo(`${baseUrl}/dynamic.html`);
    await browser.click('#btn-remove');
    await browser.expect('#to-remove').not.toBeVisible({ timeout: 2000 });
  });

  it('visible element becomes hidden immediately', async () => {
    await browser.navigateTo(`${baseUrl}/dynamic.html`);
    await browser.click('#btn-hide');
    await browser.expect('#to-hide').not.toBeVisible({ timeout: 2000 });
  });
});
