import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';
import * as fs from 'fs';
import * as path from 'path';

describe('Session State Management APIs', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;
  const statePath = path.join(__dirname, '../.test-session-state.json');

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
  });

  beforeEach(async () => {
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    await browser.navigateTo(`${baseUrl}/session.html`);
    await browser.storage.clearCookies();
  });

  describe('Cookies API', () => {
    it('addCookie and getCookies work correctly', async () => {
      await browser.storage.addCookie({
        name: 'test_cookie',
        value: 'test_value',
        domain: 'localhost',
        path: '/'
      });

      const cookies = await browser.storage.getCookies();
      const testCookie = cookies.find(c => c.name === 'test_cookie');

      expect(testCookie?.value).toBe('test_value');
    });

    it('clearCookies removes all cookies', async () => {
      await browser.storage.addCookie({
        name: 'clear_test',
        value: 'clear_value',
        domain: 'localhost',
        path: '/'
      });

      await browser.storage.clearCookies();
      const cookies = await browser.storage.getCookies();

      expect(cookies.length).toBe(0);
    });
  });

  describe('saveState and loadState', () => {
    it('saves and loads cookies correctly', async () => {
      await browser.storage.addCookie({
        name: 'save_load_test',
        value: 'test_value',
        domain: 'localhost',
        path: '/'
      });

      await browser.saveState(statePath);
      await browser.storage.clearCookies();
      await browser.loadState(statePath);

      const cookies = await browser.storage.getCookies();
      const loadedCookie = cookies.find(c => c.name === 'save_load_test');

      expect(loadedCookie?.value).toBe('test_value');
    });

    it('respects includeLocalStorage option', async () => {
      await browser.storage.addCookie({ name: 'test', value: 'val', domain: 'localhost', path: '/' });

      await browser.saveState(statePath, { includeLocalStorage: false });

      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const localStorageKeys = state.localStorage ? Object.keys(state.localStorage) : [];

      expect(localStorageKeys.length).toBe(0);
    });
  });

  describe('Launch with storageState', () => {
    it('launches browser with pre-saved cookies', async () => {
      await browser.storage.addCookie({
        name: 'launch_test',
        value: 'launch_value',
        domain: 'localhost',
        path: '/'
      });

      await browser.saveState(statePath);

      const browser2 = await Browser.launch({ browserName: BROWSER_NAME, storageState: statePath });
      try {
        await browser2.navigateTo(`${baseUrl}/session.html`);
        const cookies = await browser2.storage.getCookies();
        const launchCookie = cookies.find(c => c.name === 'launch_test');
        expect(launchCookie?.value).toBe('launch_value');
      } finally {
        await browser2.quit();
      }
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

      const browser2 = await Browser.launch({ browserName: BROWSER_NAME, storageState: statePath });
      try {
        await browser2.navigateTo(`${baseUrl}/login.html`);
        await browser2.expect('#welcome').toBeVisible();
        await browser2.expect('#welcome').toContainText('testuser');
        expect(await browser2.find('#login-form').isVisible()).toBe(false);
      } finally {
        await browser2.quit();
      }
    });
  });
});

