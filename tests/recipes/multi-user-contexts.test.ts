// Runnable proof for docs/recipes/multi-user-contexts.md
// The MD snippet is this test's body (minus the base URL constant).
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('two users at once', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('keeps each signed-in user isolated', async () => {
    const alice = await browser.newContext();
    const bob = await browser.newContext();

    const alicePage = await alice.newPage({ url: `${baseUrl}/login.html` });
    await alicePage.find('#username').fill('alice');
    await alicePage.find('#password').fill('secret');
    await alicePage.find('#submit').click();
    await alicePage.expect('#welcome').toContainText('Welcome back, alice!');

    const bobPage = await bob.newPage({ url: `${baseUrl}/login.html` });
    await bobPage.find('#username').fill('bob');
    await bobPage.find('#password').fill('secret');
    await bobPage.find('#submit').click();
    await bobPage.expect('#welcome').toContainText('Welcome back, bob!');

    // Alice's page is unaffected by Bob signing in — cookies are per-context.
    await alicePage.expect('#welcome').toContainText('Welcome back, alice!');

    await alice.close();
    await bob.close();
  });
});
