import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Console Logs and JavaScript Errors', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({
      browserName: BROWSER_NAME,
      enableBiDi: true,
    });
  });

  beforeEach(async () => {
    await browser.navigateTo(`${baseUrl}/console-errors.html`);
    browser.logs.clearLogs();
  });

  afterAll(async () => {
    await browser.quit();
  });

  describe('Console Log Capture', () => {
    it('captures console.log() messages', async () => {
      await browser.click('#btn-console-log');
      await browser.pause(50);

      const messages = browser.logs.getConsoleLogs();
      const logMessage = messages.find((m) => m.text.includes('Hello from console.log'));

      expect(logMessage).toBeDefined();
      expect(logMessage?.type).toBe('console');
      expect(logMessage?.level).toBe('info');
      expect(logMessage?.method).toBe('log');
      expect(logMessage?.timestamp).instanceOf(Date);
      expect(logMessage?.stackTrace?.length).toEqual(2);
    });

    it('captures console.warn() messages', async () => {
      await browser.click('#btn-console-warn');
      await browser.pause(50);

      const messages = browser.logs.getConsoleLogs();
      const logMessage = messages.find((m) => m.text.includes('This is a warning message'));

      expect(logMessage).toBeDefined();
      expect(logMessage?.type).toBe('console');
      expect(logMessage?.level).toBe('warn');
      expect(logMessage?.method).toBe('warn');
      expect(logMessage?.timestamp).instanceOf(Date);
      expect(logMessage?.stackTrace?.length).toEqual(2);
    });

    it('captures console.error() messages', async () => {
      await browser.click('#btn-console-error');
      await browser.pause(50);

      const messages = browser.logs.getConsoleLogs();
      const logMessage = messages.find((m) => m.text.includes('This is an error message'));

      expect(logMessage).toBeDefined();
      expect(logMessage?.type).toBe('console');
      expect(logMessage?.level).toBe('error');
      expect(logMessage?.method).toBe('error');
      expect(logMessage?.timestamp).instanceOf(Date);
      expect(logMessage?.stackTrace?.length).toEqual(2);
    });

    it('captures console.info() messages', async () => {
      await browser.click('#btn-console-info');
      await browser.pause(50);

      const messages = browser.logs.getConsoleLogs();
      const logMessage = messages.find((m) => m.text.includes('This is an info message'));

      expect(logMessage).toBeDefined();
      expect(logMessage?.type).toBe('console');
      expect(logMessage?.level).toBe('info');
      expect(logMessage?.method).toBe('info');
      expect(logMessage?.timestamp).instanceOf(Date);
      expect(logMessage?.stackTrace?.length).toEqual(2);
    });

    it('captures console.debug() messages', async () => {
      await browser.click('#btn-console-debug');
      await browser.pause(50);

      const messages = browser.logs.getConsoleLogs();
      const logMessage = messages.find((m) => m.text.includes('This is a debug message'));

      expect(logMessage).toBeDefined();
      expect(logMessage?.type).toBe('console');
      expect(logMessage?.level).toBe('debug');
      expect(logMessage?.method).toBe('debug');
      expect(logMessage?.timestamp).instanceOf(Date);
      expect(logMessage?.stackTrace?.length).toEqual(2);
    });
  });

  describe('Complex Console Output', () => {
    it('captures console logs with objects', async () => {
      await browser.click('#btn-log-object');
      await browser.pause(50);

      const messages = browser.logs.getConsoleLogs();
      const objectLogs = messages.filter(
        (m) => m.text.includes('User object') || m.text.includes('testuser')
      );

      if (objectLogs.length === 0) {
        throw new Error('Expected to capture object log message');
      }
    });

    it('captures console logs with arrays', async () => {
      await browser.click('#btn-log-array');
      await browser.pause(50);

      const messages = browser.logs.getConsoleLogs();
      const arrayLogs = messages.filter((m) => m.text.includes('Array'));

      if (arrayLogs.length === 0) {
        throw new Error('Expected to capture array log message');
      }
    });

    it('captures console logs with multiple arguments', async () => {
      await browser.click('#btn-log-multiple');
      await browser.pause(50);

      const messages = browser.logs.getConsoleLogs();
      const multiLogs = messages.filter(
        (m) => m.text.includes('Multiple') && m.text.includes('arguments')
      );

      if (multiLogs.length === 0) {
        throw new Error('Expected to capture multiple argument log');
      }
    });
  });

  describe('JavaScript Error Capture', () => {
    it('captures thrown Error', async () => {
      await browser.click('#btn-throw-error');
      await browser.pause(50);

      const errors = browser.logs.getErrors();
      const thrownError = errors.find((e) => e.text.includes('This is a thrown Error'));

      if (!thrownError) {
        throw new Error('Expected to capture thrown Error');
      }
    });

    it('captures TypeError', async () => {
      await browser.click('#btn-throw-type');
      await browser.pause(50);

      const errors = browser.logs.getErrors();
      const typeError = errors.find(
        (e) => e.text.includes('TypeError') || e.text.includes('Cannot read property')
      );

      if (!typeError) {
        throw new Error('Expected to capture TypeError');
      }
    });

    it('captures ReferenceError', async () => {
      await browser.click('#btn-throw-reference');
      await browser.pause(50);

      const errors = browser.logs.getErrors();
      const refError = errors.find(
        (e) => e.text.includes('ReferenceError') || e.text.includes('not defined')
      );

      if (!refError) {
        throw new Error('Expected to capture ReferenceError');
      }
    });

    it('captures eval syntax error', async () => {
      await browser.click('#btn-throw-syntax');
      await browser.pause(50);

      const errors = browser.logs.getErrors();
      const syntaxError = errors.find(
        (e) => e.text.includes('SyntaxError') || e.text.toLowerCase().includes('syntax')
      );

      if (!syntaxError) {
        throw new Error('Expected to capture SyntaxError from eval');
      }
    });
  });

  describe('Async Errors', () => {
    it('captures unhandled promise rejection', async () => {
      await browser.click('#btn-promise-reject');

      // Wait a bit for promise rejection to be logged
      await browser.pause(500);

      const errors = browser.logs.getErrors();
      const promiseError = errors.find((e) => e.text.includes('Unhandled promise rejection'));

      if (!promiseError) {
        throw new Error('Expected to capture unhandled promise rejection');
      }
    });

    it('captures async function error', async () => {
      await browser.click('#btn-async-error');

      await browser.pause(500);

      const errors = browser.logs.getErrors();
      const asyncError = errors.find((e) => e.text.includes('Error inside async function'));

      if (!asyncError) {
        throw new Error('Expected to capture async function error');
      }
    });

    it('captures error in setTimeout', async () => {
      await browser.click('#btn-timeout-error');

      // Wait for setTimeout to fire
      await browser.pause(500);

      const errors = browser.logs.getErrors();
      const timeoutError = errors.find((e) => e.text.includes('Error inside setTimeout'));

      if (!timeoutError) {
        throw new Error('Expected to capture setTimeout error');
      }
    });
  });

  describe('DOM Errors', () => {
    it('captures null element access error', async () => {
      await browser.click('#btn-null-access');
      await browser.pause(50);

      const errors = browser.logs.getErrors();
      const nullError = errors.find(
        (e) =>
          e.text.includes('null') || e.text.includes('Cannot') || e.text.includes('textContent')
      );

      if (!nullError) {
        throw new Error('Expected to capture null access error');
      }
    });

    it('captures invalid selector error', async () => {
      await browser.click('#btn-invalid-selector');
      await browser.pause(50);

      const errors = browser.logs.getErrors();
      const selectorError = errors.find(
        (e) => e.text.toLowerCase().includes('selector') || e.text.toLowerCase().includes('valid')
      );

      if (!selectorError) {
        throw new Error('Expected to capture invalid selector error');
      }
    });
  });

  describe('Clear Logs', () => {
    it('can clear captured messages', async () => {
      await browser.click('#btn-console-log');
      await browser.pause(50);
      await browser.click('#btn-console-warn');
      await browser.pause(50);
      expect(browser.logs.getConsoleLogs().length).toBeGreaterThan(0);

      browser.logs.clearLogs();
      await browser.pause(50);
      expect(browser.logs.getConsoleLogs().length).toEqual(0);
    });

    it('can clear captured errors', async () => {
      await browser.click('#btn-throw-error');
      await browser.pause(50);
      expect(browser.logs.getErrors().length).toBeGreaterThan(0);

      browser.logs.clearLogs();
      await browser.pause(50);
      expect(browser.logs.getErrors().length).toEqual(0);
    });
  });

  describe('Event Subscription', () => {
    it('subscribes to JavaScript errors and takes screenshot on error', async () => {
      let capturedError: any = null;
      let screenshotTaken = false;

      // 1. Subscribe to JavaScript errors - code runs when error happens
      const unsubscribe = browser.logs.onError((error) => {
        capturedError = error;
        screenshotTaken = true; // In real scenario: await browser.saveScreenshot('error.png')
      });

      // 2. Trigger an error
      await browser.click('#btn-throw-error');
      await browser.pause(50); // Allow event to propagate

      // 3. Verify subscription code got executed
      expect(capturedError).not.toBeNull();
      expect(capturedError.type).toBe('javascript');
      expect(capturedError.text).toContain('This is a thrown Error');
      expect(screenshotTaken).toBe(true);

      unsubscribe();
    });
  });
});
