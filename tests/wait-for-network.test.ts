import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('waitForRequest and waitForResponse', () => {
  let browser: Browser;
  const networkPageUrl = `${EXAMPLES_BASE_URL}/network.html?bidi=true`;

  async function clickAndWaitForResponse(
    matcher: Parameters<Browser['waitForResponse']>[0],
    selector: string
  ) {
    const [response] = await Promise.all([
      browser.waitForResponse(matcher),
      browser.click(selector),
    ]);
    return response;
  }

  async function clickAndWaitForRequest(
    matcher: Parameters<Browser['waitForRequest']>[0],
    selector: string
  ) {
    const [request] = await Promise.all([browser.waitForRequest(matcher), browser.click(selector)]);
    return request;
  }

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    await browser.navigateTo(networkPageUrl);
  });

  afterEach(async () => {
    await browser.network?.removeAllIntercepts();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('waitForResponse resolves with the response after a button click', async () => {
    const res = await clickAndWaitForResponse('**/api/users', '#fetch-users-btn');

    expect(res.url).toContain('/api/users');
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it('waitForRequest resolves with request info', async () => {
    const req = await clickAndWaitForRequest('**/api/login', '#post-login-btn');

    expect(req.url).toContain('/api/login');
    expect(req.method).toBe('POST');
  });

  it('predicate form matches on response properties', async () => {
    const res = await clickAndWaitForResponse(
      (r) => r.url.includes('/api/users') && r.status >= 200,
      '#fetch-users-btn'
    );

    expect(res.url).toContain('/api/users');
  });

  it('predicate form matches on request properties', async () => {
    const req = await clickAndWaitForRequest(
      (r) => r.url.includes('/api/login') && r.method === 'POST',
      '#post-login-btn'
    );

    expect(req.method).toBe('POST');
  });

  it('timeout rejects with a clear message including the pattern', async () => {
    await expect(browser.waitForResponse('**/api/nonexistent', { timeout: 1000 })).rejects.toThrow(
      'waitForResponse("**/api/nonexistent") timed out after 1000ms'
    );
  });

  it('response includes headers object and numeric status', async () => {
    const res = await clickAndWaitForResponse('**/api/users', '#fetch-users-btn');

    expect(typeof res.headers).toBe('object');
    expect(typeof res.status).toBe('number');
    expect(typeof res.fromCache).toBe('boolean');
  });
});
