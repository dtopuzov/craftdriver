// Runnable proof for docs/recipes/mobile-flow-with-network-and-logs.md
// The MD snippet is the launch options plus this test's body.
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL } from '../utils';

describe('mobile flow with a mocked backend and log gate', () => {
  let browser: Browser;
  // `?bidi=true` makes the demo page issue real requests for interception.
  const usersPage = `${EXAMPLES_BASE_URL}/network.html?bidi=true`;

  beforeAll(async () => {
    browser = await Browser.launch({
      browserName: 'chrome', // mobile emulation is Chrome/Chromium only
      mobileEmulation: 'Pixel 7',
      captureLogs: true,
    });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('loads mocked data on a mobile viewport without browser errors', async () => {
    await browser.navigateTo(usersPage);

    await browser.network.mock('**/api/users', {
      status: 200,
      body: { users: [{ id: 1, name: 'Alice', plan: 'Pro' }] },
    });

    await browser.getByRole('button', { name: 'Fetch Users' }).click();
    await browser.expect('#users-result').toContainText('Alice');

    browser.logs.assertNoErrors();
  });
});
