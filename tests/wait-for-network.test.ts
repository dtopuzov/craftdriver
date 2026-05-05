import { describe, it, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('waitForRequest and waitForResponse', () => {
  let browser: Browser;
  const networkPageUrl = `${EXAMPLES_BASE_URL}/network.html?bidi=true`;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: true });
    await browser.navigateTo(networkPageUrl);
  });

  afterEach(async () => {
    await browser.network?.removeAllIntercepts();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('waitForResponse resolves with the response after a button click', async () => {
    const [res] = await Promise.all([
      browser.waitForResponse('**/api/users'),
      browser.click('#fetch-users-btn'),
    ]);

    expect(res.url).toContain('/api/users');
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it('waitForRequest resolves with request info', async () => {
    const [req] = await Promise.all([
      browser.waitForRequest('**/api/login'),
      browser.click('#post-login-btn'),
    ]);

    expect(req.url).toContain('/api/login');
    expect(req.method).toBe('POST');
  });

  it('predicate form matches on response properties', async () => {
    const [res] = await Promise.all([
      browser.waitForResponse(r => r.url.includes('/api/users') && r.status >= 200),
      browser.click('#fetch-users-btn'),
    ]);

    expect(res.url).toContain('/api/users');
  });

  it('predicate form matches on request properties', async () => {
    const [req] = await Promise.all([
      browser.waitForRequest(r => r.url.includes('/api/login') && r.method === 'POST'),
      browser.click('#post-login-btn'),
    ]);

    expect(req.method).toBe('POST');
  });

  it('timeout rejects with a clear message including the pattern', async () => {
    await expect(
      browser.waitForResponse('**/api/nonexistent', { timeout: 1000 })
    ).rejects.toThrow('waitForResponse("**/api/nonexistent") timed out after 1000ms');
  });

  it('response includes headers object and numeric status', async () => {
    const [res] = await Promise.all([
      browser.waitForResponse('**/api/users'),
      browser.click('#fetch-users-btn'),
    ]);

    expect(typeof res.headers).toBe('object');
    expect(typeof res.status).toBe('number');
    expect(typeof res.fromCache).toBe('boolean');
  });
});
