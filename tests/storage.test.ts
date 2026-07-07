import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser } from '../src';
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
