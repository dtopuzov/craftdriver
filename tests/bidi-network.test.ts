import { describe, it, beforeAll, afterAll, afterEach } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Network Mocking and Interception', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;
  // Use ?bidi=true to disable client-side fetch mocking in network.html
  const networkPageUrl = `${baseUrl}/network.html?bidi=true`;

  beforeAll(async () => {
    browser = await Browser.launch({
      browserName: BROWSER_NAME,
      enableBiDi: true
    });
  });

  afterEach(async () => {
    // Clear all intercepts between tests to avoid leaking mocks
    await browser.network?.removeAllIntercepts();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('mocks GET and POST endpoints', async () => {
    await browser.navigateTo(`${networkPageUrl}`);

    // Mock GET endpoint
    await browser.network?.mock('**/api/users', {
      status: 200,
      body: { users: [{ id: 999, name: 'Mocked User', email: 'mocked@test.com' }] }
    });

    // Mock POST endpoint
    await browser.network?.mock('**/api/login', {
      status: 200,
      body: { success: true, token: 'intercepted-token-xyz' }
    });

    await browser.click('#fetch-users-btn');
    await browser.expect('#users-result').toContainText('Mocked User');

    await browser.click('#post-login-btn');
    await browser.expect('#login-result').toContainText('intercepted-token-xyz');
  });

  it('mocks external API call with CORS headers', async () => {
    await browser.navigateTo(`${networkPageUrl}`);

    await browser.network?.mock({
      type: 'pattern',
      protocol: 'https',
      hostname: 'jsonplaceholder.typicode.com',
      pathname: '/posts/1'
    }, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: {
        userId: 99,
        id: 99,
        title: 'Mocked External Post',
        body: 'Crafdriver is awesome!'
      }
    });

    await browser.click('#fetch-external-btn');
    await browser.expect('#external-result').toContainText('Mocked External Post');
  });

  it('mocks parallel requests with different responses', async () => {
    await browser.navigateTo(`${networkPageUrl}`);

    await browser.network?.mock('**/api/items/1', {
      status: 200,
      body: { id: 1, name: 'Mocked Item 1', price: 99.99 }
    });
    await browser.network?.mock('**/api/items/2', {
      status: 200,
      body: { id: 2, name: 'Mocked Item 2', price: 199.99 }
    });
    await browser.network?.mock('**/api/items/3', {
      status: 200,
      body: { id: 3, name: 'Mocked Item 3', price: 299.99 }
    });

    await browser.click('#fetch-parallel-btn');
    await browser.expect('#parallel-result').toContainText('Mocked Item 1');
    await browser.expect('#parallel-result').toContainText('Mocked Item 2');
    await browser.expect('#parallel-result').toContainText('Mocked Item 3');
  });

  it('mocks slow endpoint with instant response', async () => {
    await browser.navigateTo(`${networkPageUrl}`);

    await browser.network?.mock('**/api/slow', {
      status: 200,
      body: { message: 'Instantly mocked (no delay!)' }
    });

    const startTime = Date.now();
    await browser.click('#fetch-slow-btn');
    await browser.expect('#slow-result').toContainText('Instantly mocked');
    const elapsed = Date.now() - startTime;

    if (elapsed > 1000) {
      throw new Error(`Expected fast response but took ${elapsed}ms`);
    }
  });

  it('mocks error responses (404 and 500)', async () => {
    await browser.navigateTo(`${networkPageUrl}`);

    // Test 404
    await browser.network?.mock('**/api/users', { status: 404, body: { error: 'Not found' } });
    await browser.click('#fetch-users-btn');
    await browser.expect('#users-result').toContainText('error');

    await browser.network?.removeAllIntercepts();

    // Test 500
    await browser.network?.mock('**/api/login', { status: 500, body: { error: 'Server error' } });
    await browser.click('#post-login-btn');
    await browser.expect('#login-result').toContainText('error');
  });

  it('intercepts requests, captures details, and modifies response', async () => {
    await browser.navigateTo(`${networkPageUrl}`);

    let interceptedUrl = '';
    let interceptedMethod = '';

    await browser.network?.intercept('**/api/users', async (request) => {
      interceptedUrl = request.url;
      interceptedMethod = request.method;
      return {
        status: 200,
        body: { users: [{ id: 888, name: 'Intercepted User', email: 'intercepted@test.com' }] }
      };
    });

    await browser.click('#fetch-users-btn');
    await browser.expect('#users-result').toContainText('Intercepted User');

    if (!interceptedUrl.includes('/api/users')) {
      throw new Error(`Expected to intercept /api/users but got "${interceptedUrl}"`);
    }
    if (interceptedMethod !== 'GET') {
      throw new Error(`Expected GET method but got "${interceptedMethod}"`);
    }
  });
});
