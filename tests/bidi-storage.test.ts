import { describe, it, beforeEach, afterEach } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';
import * as fs from 'fs';
import * as path from 'path';

describe('Session State Management APIs', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;
  const statePath = path.join(__dirname, '../.test-session-state.json');

  beforeEach(async () => {
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }

    browser = await Browser.launch({
      browserName: BROWSER_NAME,
      enableBiDi: true
    });
  });

  afterEach(async () => {
    await browser.quit();

    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  });

  describe('Cookies API', () => {
    it('addCookie and getCookies work correctly', async () => {
      await browser.navigateTo(`${baseUrl}/session.html`);

      await browser.storage.addCookie({
        name: 'test_cookie',
        value: 'test_value',
        domain: 'localhost',
        path: '/'
      });

      const cookies = await browser.storage.getCookies();
      const testCookie = cookies.find(c => c.name === 'test_cookie');

      // Cookie value is a BytesValue object: { type: 'string', value: 'actual_value' }
      if (!testCookie || testCookie.value.value !== 'test_value') {
        throw new Error(`Cookie not added correctly. Got: ${JSON.stringify(testCookie)}`);
      }
    });

    it('clearCookies removes all cookies', async () => {
      await browser.navigateTo(`${baseUrl}/session.html`);

      await browser.storage.addCookie({
        name: 'clear_test',
        value: 'clear_value',
        domain: 'localhost',
        path: '/'
      });

      await browser.storage.clearCookies();
      const cookies = await browser.storage.getCookies();

      if (cookies.length !== 0) {
        throw new Error(`Expected 0 cookies after clear, got ${cookies.length}`);
      }
    });
  });

  describe('saveState and loadState', () => {
    it('saves and loads cookies correctly', async () => {
      await browser.navigateTo(`${baseUrl}/session.html`);

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

      // Cookie value is a BytesValue object: { type: 'string', value: 'actual_value' }
      if (!loadedCookie || loadedCookie.value.value !== 'test_value') {
        throw new Error(`Cookie was not saved/loaded correctly. Got: ${JSON.stringify(loadedCookie)}`);
      }
    });

    it('respects includeLocalStorage option', async () => {
      await browser.navigateTo(`${baseUrl}/session.html`);

      await browser.storage.addCookie({
        name: 'test',
        value: 'val',
        domain: 'localhost',
        path: '/'
      });

      await browser.saveState(statePath, { includeLocalStorage: false });

      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

      if (state.localStorage && Object.keys(state.localStorage).length > 0) {
        throw new Error('localStorage should have been excluded');
      }
    });
  });

  describe('Launch with storageState', () => {
    it('launches browser with pre-saved cookies', async () => {
      await browser.navigateTo(`${baseUrl}/session.html`);

      await browser.storage.addCookie({
        name: 'launch_test',
        value: 'launch_value',
        domain: 'localhost',
        path: '/'
      });

      await browser.saveState(statePath);
      await browser.quit();

      browser = await Browser.launch({
        browserName: BROWSER_NAME,
        enableBiDi: true,
        storageState: statePath
      });

      await browser.navigateTo(`${baseUrl}/session.html`);

      const cookies = await browser.storage.getCookies();
      const launchCookie = cookies.find(c => c.name === 'launch_test');

      // Cookie value is a BytesValue object: { type: 'string', value: 'actual_value' }
      if (!launchCookie || launchCookie.value.value !== 'launch_value') {
        throw new Error(`State was not loaded on launch. Got: ${JSON.stringify(launchCookie)}`);
      }
    });
  });

  describe('E2E Login Persistence', () => {
    it('stays logged in after browser restart using saved session', async () => {
      // Step 1: Navigate to login page and log in
      await browser.navigateTo(`${baseUrl}/login.html`);

      await browser.fill('#username', 'testuser');
      await browser.fill('#password', 'secret123');
      await browser.click('#submit');

      // Wait for welcome message to appear
      await browser.expect('#welcome').toBeVisible();

      // Step 2: Save the session state (includes the session cookie)
      await browser.saveState(statePath);
      await browser.quit();

      // Step 3: Launch a NEW browser with the saved session
      browser = await Browser.launch({
        browserName: BROWSER_NAME,
        enableBiDi: true,
        storageState: statePath
      });

      // Step 4: Navigate to login page - should be already logged in!
      await browser.navigateTo(`${baseUrl}/login.html`);

      // Step 5: Verify we're logged in without entering credentials
      await browser.expect('#welcome').toBeVisible();
      await browser.expect('#welcome').toContainText('testuser');

      // The login form should be hidden
      const formVisible = await browser.find('#login-form').isVisible();
      if (formVisible) {
        throw new Error('Login form should be hidden when already logged in');
      }
    });
  });
});
