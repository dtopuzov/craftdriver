// Runnable proof for docs/recipes/mock-api-and-assert-network.md
// The MD snippet is this test's body (real deployed URL instead of the local one).
import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('mock an API and assert the traffic', () => {
  let browser: Browser;
  // `?bidi=true` tells this demo page to issue real network requests instead
  // of its built-in stub, so craftdriver's interception is what answers them.
  const usersPage = `${EXAMPLES_BASE_URL}/network.html?bidi=true`;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterEach(async () => {
    await browser.network.removeAllIntercepts();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('serves a mocked user list and observes the response', async () => {
    await browser.navigateTo(usersPage);

    await browser.network.mock('**/api/users', {
      status: 200,
      body: { users: [{ id: 1, name: 'Alice', plan: 'Pro' }] },
    });

    const [response] = await Promise.all([
      browser.waitForResponse('**/api/users'),
      browser.getByRole('button', { name: 'Fetch Users' }).click(),
    ]);

    expect(response.status).toBe(200);
    await browser.expect('#users-result').toContainText('Alice');
  });
});
