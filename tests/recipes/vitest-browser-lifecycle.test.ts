// Runnable proof for docs/recipes/vitest-browser-lifecycle.md
// The MD snippet is this file's core, minus the test-harness base URL.
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('login page', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({
      browserName: BROWSER_NAME,
    });
  });

  beforeEach(async () => {
    browser.logs.clearLogs();
    await browser.network.removeAllIntercepts();
    await browser.navigateTo(`${baseUrl}/login.html`);
  });

  afterEach(() => {
    browser.logs.assertNoErrors();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('signs the user in', async () => {
    await browser.getByLabel('Username').fill('alice');
    await browser.getByLabel('Password').fill('secret');
    await browser.getByRole('button', { name: 'Sign in' }).click();
    await browser.expect('#welcome').toContainText('Welcome back, alice!');
  });
});
