import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, ErrorCode } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';
import * as fs from 'fs';
import * as path from 'path';

describe('Session State Management APIs', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;
  const statePath = path.join(__dirname, '../.test-session-state.json');

  function deleteStateFile(): void {
    fs.rmSync(statePath, { force: true });
  }

  async function cookieValue(name: string, target: Browser = browser): Promise<string | undefined> {
    const cookies = await target.storage.getCookies();
    return cookies.find((cookie) => cookie.name === name)?.value;
  }

  async function withStoredBrowser<T>(run: (storedBrowser: Browser) => Promise<T>): Promise<T> {
    const storedBrowser = await Browser.launch({
      browserName: BROWSER_NAME,
      storageState: statePath,
    });
    try {
      return await run(storedBrowser);
    } finally {
      await storedBrowser.quit();
    }
  }

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
    deleteStateFile();
  });

  beforeEach(async () => {
    deleteStateFile();
    await browser.navigateTo(`${baseUrl}/session.html`);
    await browser.storage.clearCookies();
  });

  describe('Cookies API', () => {
    it('addCookie and getCookies work correctly', async () => {
      await browser.storage.addCookie({
        name: 'test_cookie',
        value: 'test_value',
      domain: 'localhost',
        path: '/',
      });

      expect(await cookieValue('test_cookie')).toBe('test_value');
    });

    it('clearCookies removes all cookies', async () => {
      await browser.storage.addCookie({
        name: 'clear_test',
        value: 'clear_value',
      domain: 'localhost',
        path: '/',
      });

      await browser.storage.clearCookies();
      expect(await browser.storage.getCookies()).toHaveLength(0);
    });
  });

  describe('saveState and loadState', () => {
    it('saves and loads cookies correctly', async () => {
      await browser.storage.addCookie({
        name: 'save_load_test',
        value: 'test_value',
      domain: 'localhost',
        path: '/',
      });

      await browser.saveState(statePath);
      await browser.storage.clearCookies();
      await browser.loadState(statePath);

      expect(await cookieValue('save_load_test')).toBe('test_value');
    });

    it('respects includeLocalStorage option', async () => {
      await browser.storage.addCookie({
        name: 'test',
        value: 'val',
      domain: 'localhost',
        path: '/',
      });

      await browser.saveState(statePath, { includeLocalStorage: false });

      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const localStorageKeys = state.localStorage ? Object.keys(state.localStorage) : [];

      expect(localStorageKeys).toEqual([]);
    });
  });

  describe('Launch with storageState', () => {
    it('launches browser with pre-saved cookies', async () => {
      await browser.storage.addCookie({
        name: 'launch_test',
        value: 'launch_value',
      domain: 'localhost',
        path: '/',
      });

      await browser.saveState(statePath);

      await withStoredBrowser(async (browser2) => {
        await browser2.navigateTo(`${baseUrl}/session.html`);
        expect(await cookieValue('launch_test', browser2)).toBe('launch_value');
      });
    });
  });

  describe('E2E Login Persistence', () => {
    it('stays logged in after browser restart using saved session', async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
      await browser.fill('#username', 'testuser');
      await browser.fill('#password', 'secret123');
      await browser.click('#submit');
      await browser.expect('#welcome').toBeVisible();

      await browser.saveState(statePath);

      await withStoredBrowser(async (browser2) => {
        await browser2.navigateTo(`${baseUrl}/login.html`);
        await browser2.expect('#welcome').toBeVisible();
        await browser2.expect('#welcome').toContainText('testuser');
        await browser2.expect('#login-form').not.toBeVisible();
      });
    });
  });
});

/**
 * Classic-mode cookie regression suite.
 *
 * These launch with `enableBiDi: false`, forcing `SessionStateManager`'s
 * Classic branch. That branch used to manipulate `document.cookie` via script
 * injection, which categorically cannot see HttpOnly cookies and cannot read
 * real secure/sameSite/expiry values. The branch is now backed by the native
 * W3C Classic cookie endpoints (`Driver.getCookies`/`addCookie`/`deleteCookie`/
 * `deleteAllCookies`), so these properties must now round-trip. The
 * `document.cookie` cross-check on the HttpOnly test is the proof the old
 * approach could not have passed.
 */
describe('Classic-mode cookie endpoints (regression)', () => {
  let classic: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    classic = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: false });
  });

  afterAll(async () => {
    await classic.quit();
  });

  beforeEach(async () => {
    await classic.navigateTo(`${baseUrl}/session.html`);
    await classic.storage.clearCookies();
  });

  it('runs against the Classic (non-BiDi) storage branch', () => {
    // Guards the whole suite: if BiDi ever connected here we'd be testing the
    // wrong code path and the regression proof would be meaningless.
    expect(classic.isBiDiEnabled()).toBe(false);
  });

  it('basic get/set/clear still work with no behavior change', async () => {
    await classic.storage.addCookie({
      name: 'basic',
      value: 'basic_value',
      path: '/',
    });

    const cookies = await classic.storage.getCookies();
    const found = cookies.find((c) => c.name === 'basic');
    expect(found?.value).toBe('basic_value');
    expect(found?.path).toBe('/');
    // size stays backward compatible: (name + value).length
    expect(found?.size).toBe(('basic' + 'basic_value').length);

    await classic.storage.clearCookies();
    expect(await classic.storage.getCookies()).toHaveLength(0);
  });

  it('setCookies() best-effort skips a domain-mismatched cookie instead of throwing', async () => {
    // The W3C cookie endpoint rejects a cookie whose domain doesn't match the
    // current document with `invalid cookie domain`. The old document.cookie
    // path silently ignored such cookies; the fix preserves that best-effort
    // behavior so a single unsettable cookie doesn't abort the whole batch.
    // The foreign cookie is listed FIRST to prove the skip continues to the
    // next cookie rather than aborting the restore.
    const host = new URL(baseUrl).hostname;
    await expect(
      classic.storage.setCookies([
        { name: 'classic_foreign', value: 'no', domain: 'cookie-fix.example.com' },
        { name: 'classic_ok', value: 'yes', domain: host },
      ]),
    ).resolves.toBeUndefined();

    const cookies = await classic.storage.getCookies();
    expect(cookies.some((c) => c.name === 'classic_foreign')).toBe(false);
    expect(cookies.some((c) => c.name === 'classic_ok')).toBe(true);
  });

  it('reports HttpOnly cookies that document.cookie cannot see', async () => {
    await classic.storage.addCookie({
      name: 'session_id',
      value: 'secret-httponly',
      path: '/',
      httpOnly: true,
    });

    const cookies = await classic.storage.getCookies();
    const found = cookies.find((c) => c.name === 'session_id');

    // The native cookie store reports it, with httpOnly === true. The old
    // document.cookie path both missed the cookie entirely and hardcoded
    // httpOnly: false.
    expect(found).toBeDefined();
    expect(found?.value).toBe('secret-httponly');
    expect(found?.httpOnly).toBe(true);

    // Dual proof: the page's own document.cookie must NOT see an HttpOnly
    // cookie — this is exactly what the old getCookiesClassic relied on.
    const documentCookie = await classic.evaluate<string>(() => document.cookie);
    expect(documentCookie).not.toContain('session_id');
  });

  it('round-trips real sameSite values instead of hardcoding lax', async () => {
    await classic.storage.addCookie({
      name: 'strict_cookie',
      value: 'v1',
      path: '/',
      sameSite: 'Strict',
    });
    await classic.storage.addCookie({
      name: 'lax_cookie',
      value: 'v2',
      path: '/',
      sameSite: 'Lax',
    });

    const cookies = await classic.storage.getCookies();
    const strict = cookies.find((c) => c.name === 'strict_cookie');
    const lax = cookies.find((c) => c.name === 'lax_cookie');

    // Old path reported 'lax' for every cookie; the strict one is the proof.
    expect(strict?.sameSite).toBe('strict');
    expect(lax?.sameSite).toBe('lax');
  });

  it('round-trips a real expiry (previously always undefined)', async () => {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    await classic.storage.addCookie({
      name: 'persistent',
      value: 'stays',
      path: '/',
      expiry,
    });

    const cookies = await classic.storage.getCookies();
    const found = cookies.find((c) => c.name === 'persistent');

    // document.cookie exposes no expiry at all, so the old path always left it
    // undefined. It should now be a number close to what we set.
    expect(typeof found?.expiry).toBe('number');
    expect(Math.abs((found?.expiry ?? 0) - expiry)).toBeLessThanOrEqual(5);
  });

  it('round-trips a secure cookie (127.0.0.1 is a trustworthy origin)', async () => {
    await classic.storage.addCookie({
      name: 'secure_cookie',
      value: 'v',
      path: '/',
      secure: true,
    });

    const cookies = await classic.storage.getCookies();
    const found = cookies.find((c) => c.name === 'secure_cookie');

    // Old path derived secure from location.protocol (false over http); the
    // native store reports the flag we actually set.
    expect(found?.secure).toBe(true);
  });

  it('clearCookies removes HttpOnly cookies too (native delete, not expiry hack)', async () => {
    await classic.storage.addCookie({
      name: 'httponly_to_clear',
      value: 'v',
      path: '/',
      httpOnly: true,
    });
    expect((await classic.storage.getCookies()).some((c) => c.name === 'httponly_to_clear')).toBe(
      true
    );

    await classic.storage.clearCookies();
    // The old document.cookie expires-in-the-past trick cannot delete an
    // HttpOnly cookie; the native DELETE endpoint can.
    expect(await classic.storage.getCookies()).toHaveLength(0);
  });

  it('restores a single active origin strictly after navigation', async () => {
    const origin = new URL(baseUrl).origin;
    const host = new URL(baseUrl).hostname;
    await classic.loadState({
      cookies: [{ name: 'restored', value: 'yes', domain: host, path: '/' } as any],
      localStorage: { [origin]: { auth: 'ready' } },
    });
    expect(await classic.evaluate(() => localStorage.getItem('auth'))).toBe('ready');
    expect((await classic.storage.getCookies()).find((c) => c.name === 'restored')?.value).toBe('yes');
  });

  it('rejects Classic restore on about:blank before mutation', async () => {
    await classic.navigateTo('about:blank');
    await expect(classic.loadState({
      localStorage: { [new URL(baseUrl).origin]: { auth: 'no' } },
    })).rejects.toMatchObject({ code: ErrorCode.STATE_INVALID });
  });

  it('rejects mismatched Classic origins and cookies before any mutation', async () => {
    const origin = new URL(baseUrl).origin;
    const host = new URL(baseUrl).hostname;
    await classic.evaluate(() => localStorage.removeItem('should_not_apply'));
    await expect(classic.loadState({
      localStorage: { [origin]: { should_not_apply: 'x' } },
      cookies: [
        { name: 'valid_but_must_not_apply', value: 'x', domain: host, path: '/' } as any,
        { name: 'foreign', value: 'x', domain: 'foreign.example.test', path: '/' } as any,
      ],
    })).rejects.toMatchObject({ code: ErrorCode.STATE_INVALID });
    const unapplied = await classic.evaluate<unknown>('return localStorage.getItem("should_not_apply")');
    // Classic's null deserializer is driver-dependent (`null` vs `{value:null}`).
    expect(unapplied === null || (unapplied as { value?: unknown })?.value === null).toBe(true);
    expect((await classic.storage.getCookies()).some((c) => c.name === 'valid_but_must_not_apply')).toBe(false);
  });

  it('rejects non-empty storageState at Classic launch but accepts empty state', async () => {
    await expect(Browser.launch({
      browserName: BROWSER_NAME,
      enableBiDi: false,
      storageState: { localStorage: { [new URL(baseUrl).origin]: { auth: 'x' } } },
    })).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED,
      detail: {
        feature: 'storageState',
        operation: 'Browser.launch',
        protocol: 'classic',
        phase: 'capability',
        partialApplied: false,
      },
    });

    const empty = await Browser.launch({
      browserName: BROWSER_NAME,
      enableBiDi: false,
      storageState: { cookies: [], localStorage: {}, sessionStorage: {} },
    });
    await empty.quit();
  });
});
