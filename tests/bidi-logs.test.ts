import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME, IS_CHROMIUM } from './utils';

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
      const msgPromise = browser.logs.waitForConsole((m) => m.text.includes('Hello from console.log'), 5000);
      await browser.click('#btn-console-log');
      const logMessage = await msgPromise;

      expect(logMessage).toBeDefined();
      expect(logMessage?.type).toBe('console');
      expect(logMessage?.level).toBe('info');
      expect(logMessage?.method).toBe('log');
      expect(logMessage?.timestamp).instanceOf(Date);
      // Firefox only attaches stack traces to error-level entries.
      if (IS_CHROMIUM) expect(logMessage?.stackTrace?.length).toEqual(2);
    });

    it('captures console.warn() messages', async () => {
      const msgPromise = browser.logs.waitForConsole((m) => m.text.includes('This is a warning message'), 5000);
      await browser.click('#btn-console-warn');
      const logMessage = await msgPromise;

      expect(logMessage).toBeDefined();
      expect(logMessage?.type).toBe('console');
      expect(logMessage?.level).toBe('warn');
      expect(logMessage?.method).toBe('warn');
      expect(logMessage?.timestamp).instanceOf(Date);
      if (IS_CHROMIUM) expect(logMessage?.stackTrace?.length).toEqual(2);
    });

    it('captures console.error() messages', async () => {
      const msgPromise = browser.logs.waitForConsole((m) => m.text.includes('This is an error message'), 5000);
      await browser.click('#btn-console-error');
      const logMessage = await msgPromise;

      expect(logMessage).toBeDefined();
      expect(logMessage?.type).toBe('console');
      expect(logMessage?.level).toBe('error');
      expect(logMessage?.method).toBe('error');
      expect(logMessage?.timestamp).instanceOf(Date);
      expect(logMessage?.stackTrace?.length).toEqual(2);
    });

    it('captures console.info() messages', async () => {
      const msgPromise = browser.logs.waitForConsole((m) => m.text.includes('This is an info message'), 5000);
      await browser.click('#btn-console-info');
      const logMessage = await msgPromise;

      expect(logMessage).toBeDefined();
      expect(logMessage?.type).toBe('console');
      expect(logMessage?.level).toBe('info');
      expect(logMessage?.method).toBe('info');
      expect(logMessage?.timestamp).instanceOf(Date);
      if (IS_CHROMIUM) expect(logMessage?.stackTrace?.length).toEqual(2);
    });

    it('captures console.debug() messages', async () => {
      const msgPromise = browser.logs.waitForConsole((m) => m.text.includes('This is a debug message'), 5000);
      await browser.click('#btn-console-debug');
      const logMessage = await msgPromise;

      expect(logMessage).toBeDefined();
      expect(logMessage?.type).toBe('console');
      expect(logMessage?.level).toBe('debug');
      expect(logMessage?.method).toBe('debug');
      expect(logMessage?.timestamp).instanceOf(Date);
      if (IS_CHROMIUM) expect(logMessage?.stackTrace?.length).toEqual(2);
    });
  });

  describe('Complex Console Output', () => {
    it('captures console logs with objects', async () => {
      const msgPromise = browser.logs.waitForConsole(
        (m) => m.text.includes('User object') || m.text.includes('testuser'),
        5000
      );
      await browser.click('#btn-log-object');
      await msgPromise;
    });

    it('captures console logs with arrays', async () => {
      const msgPromise = browser.logs.waitForConsole((m) => m.text.includes('Array'), 5000);
      await browser.click('#btn-log-array');
      await msgPromise;
    });

    it('captures console logs with multiple arguments', async () => {
      const msgPromise = browser.logs.waitForConsole(
        (m) => m.text.includes('Multiple') && m.text.includes('arguments'),
        5000
      );
      await browser.click('#btn-log-multiple');
      await msgPromise;
    });
  });

  describe('JavaScript Error Capture', () => {
    it('captures thrown Error', async () => {
      const errorPromise = browser.logs.waitForError(
        (e) => e.text.includes('This is a thrown Error'),
        5000
      );
      await browser.click('#btn-throw-error');
      await errorPromise;
    });

    it('captures TypeError', async () => {
      const errorPromise = browser.logs.waitForError(
        (e) => e.text.includes('TypeError') || e.text.includes('Cannot read property'),
        5000
      );
      await browser.click('#btn-throw-type');
      await errorPromise;
    });

    it('captures ReferenceError', async () => {
      const errorPromise = browser.logs.waitForError(
        (e) => e.text.includes('ReferenceError') || e.text.includes('not defined'),
        5000
      );
      await browser.click('#btn-throw-reference');
      await errorPromise;
    });

    it('captures eval syntax error', async () => {
      const errorPromise = browser.logs.waitForError(
        (e) => e.text.includes('SyntaxError') || e.text.toLowerCase().includes('syntax'),
        5000
      );
      await browser.click('#btn-throw-syntax');
      await errorPromise;
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
      const errorPromise = browser.logs.waitForError(
        (e) => e.text.includes('null') || e.text.includes('Cannot') || e.text.includes('textContent'),
        5000
      );
      await browser.click('#btn-null-access');
      await errorPromise;
    });

    it('captures invalid selector error', async () => {
      const errorPromise = browser.logs.waitForError(
        (e) => e.text.toLowerCase().includes('selector') || e.text.toLowerCase().includes('valid'),
        5000
      );
      await browser.click('#btn-invalid-selector');
      await errorPromise;
    });
  });

  describe('Clear Logs', () => {
    it('can clear captured messages', async () => {
      const logPromise = browser.logs.waitForConsole((m) => m.method === 'log', 5000);
      await browser.click('#btn-console-log');
      await logPromise;
      const warnPromise = browser.logs.waitForConsole((m) => m.method === 'warn', 5000);
      await browser.click('#btn-console-warn');
      await warnPromise;
      expect(browser.logs.getMessages().length).toBeGreaterThan(0);

      browser.logs.clearLogs();
      await browser.pause(100);
      expect(browser.logs.getMessages().length).toEqual(0);
    });

    it('can clear captured errors', async () => {
      const errorPromise = browser.logs.waitForError(
        (e) => e.text.includes('This is a thrown Error'),
        5000
      );
      await browser.click('#btn-throw-error');
      await errorPromise;
      expect(browser.logs.getErrors().length).toBeGreaterThan(0);

      browser.logs.clearLogs();
      await browser.pause(100);
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
        screenshotTaken = true; // In real scenario: await browser.screenshot({ path: 'error.png' })
      });

      // 2. Register event-driven wait BEFORE triggering the error
      const errorPromise = browser.logs.waitForError(
        (e) => e.text.includes('This is a thrown Error'),
        5000
      );

      // 3. Trigger an error
      await browser.click('#btn-throw-error');

      // 4. Wait for the error event (instead of a fixed pause)
      await errorPromise;

      // 5. Verify subscription code got executed
      expect(capturedError).not.toBeNull();
      expect(capturedError.type).toBe('javascript');
      expect(capturedError.text).toContain('This is a thrown Error');
      expect(screenshotTaken).toBe(true);

      unsubscribe();
    });
  });
});
