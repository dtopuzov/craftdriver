import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, type ConsoleMessage, type JavaScriptError } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME, IS_CHROMIUM } from './utils';

describe('Console Logs and JavaScript Errors', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  beforeEach(async () => {
    await browser.navigateTo(`${baseUrl}/console-errors.html`);
    browser.logs.clearLogs();
  });

  afterAll(async () => {
    await browser.quit();
  });

  async function clickAndWaitForConsole(
    selector: string,
    predicate: (message: ConsoleMessage) => boolean
  ): Promise<ConsoleMessage> {
    const message = browser.logs.waitForConsole(predicate, 5000);
    await browser.click(selector);
    return message;
  }

  async function clickAndWaitForError(
    selector: string,
    predicate: (error: JavaScriptError) => boolean
  ): Promise<JavaScriptError> {
    const error = browser.logs.waitForError(predicate, 5000);
    await browser.click(selector);
    return error;
  }

  function expectConsoleMessage(
    message: ConsoleMessage,
    expected: {
      level: ConsoleMessage['level'];
      method: string;
      stackTrace?: 'always' | 'chromium';
    }
  ): void {
    expect(message).toMatchObject({
      type: 'console',
      level: expected.level,
      method: expected.method,
      timestamp: expect.any(Date),
    });
    const shouldHaveStack =
      expected.stackTrace === 'always' || (expected.stackTrace === 'chromium' && IS_CHROMIUM);
    if (shouldHaveStack) expect(message.stackTrace?.length).toBe(2);
  }

  function capturedErrorText(): string {
    return browser.logs
      .getErrors()
      .map((error) => error.text)
      .join('\n');
  }

  describe('Console Log Capture', () => {
    it('captures console.log() messages', async () => {
      const logMessage = await clickAndWaitForConsole('#btn-console-log', (m) =>
        m.text.includes('Hello from console.log')
      );

      // Firefox only attaches stack traces to error-level entries.
      expectConsoleMessage(logMessage, { level: 'info', method: 'log', stackTrace: 'chromium' });
    });

    it('captures console.warn() messages', async () => {
      const logMessage = await clickAndWaitForConsole('#btn-console-warn', (m) =>
        m.text.includes('This is a warning message')
      );

      expectConsoleMessage(logMessage, { level: 'warn', method: 'warn', stackTrace: 'chromium' });
    });

    it('captures console.error() messages', async () => {
      const logMessage = await clickAndWaitForConsole('#btn-console-error', (m) =>
        m.text.includes('This is an error message')
      );

      expectConsoleMessage(logMessage, { level: 'error', method: 'error', stackTrace: 'always' });
    });

    it('captures console.info() messages', async () => {
      const logMessage = await clickAndWaitForConsole('#btn-console-info', (m) =>
        m.text.includes('This is an info message')
      );

      expectConsoleMessage(logMessage, { level: 'info', method: 'info', stackTrace: 'chromium' });
    });

    it('captures console.debug() messages', async () => {
      const logMessage = await clickAndWaitForConsole('#btn-console-debug', (m) =>
        m.text.includes('This is a debug message')
      );

      expectConsoleMessage(logMessage, { level: 'debug', method: 'debug', stackTrace: 'chromium' });
    });
  });

  describe('Complex Console Output', () => {
    it('captures console logs with objects', async () => {
      await clickAndWaitForConsole(
        '#btn-log-object',
        (m) => m.text.includes('User object') || m.text.includes('testuser')
      );
    });

    it('captures console logs with arrays', async () => {
      await clickAndWaitForConsole('#btn-log-array', (m) => m.text.includes('Array'));
    });

    it('captures console logs with multiple arguments', async () => {
      await clickAndWaitForConsole(
        '#btn-log-multiple',
        (m) => m.text.includes('Multiple') && m.text.includes('arguments')
      );
    });
  });

  describe('JavaScript Error Capture', () => {
    it('captures thrown Error', async () => {
      await clickAndWaitForError('#btn-throw-error', (e) =>
        e.text.includes('This is a thrown Error')
      );
    });

    it('captures TypeError', async () => {
      await clickAndWaitForError(
        '#btn-throw-type',
        (e) => e.text.includes('TypeError') || e.text.includes('Cannot read property')
      );
    });

    it('captures ReferenceError', async () => {
      await clickAndWaitForError(
        '#btn-throw-reference',
        (e) => e.text.includes('ReferenceError') || e.text.includes('not defined')
      );
    });

    it('captures eval syntax error', async () => {
      await clickAndWaitForError(
        '#btn-throw-syntax',
        (e) => e.text.includes('SyntaxError') || e.text.toLowerCase().includes('syntax')
      );
    });
  });

  describe('Async Errors', () => {
    it('captures unhandled promise rejection', async () => {
      await clickAndWaitForError(
        '#btn-promise-reject',
        (e) => e.text.includes('Unhandled promise rejection')
      );
    });

    it('captures async function error', async () => {
      await clickAndWaitForError(
        '#btn-async-error',
        (e) => e.text.includes('Error inside async function')
      );
    });

    it('captures error in setTimeout', async () => {
      await clickAndWaitForError(
        '#btn-timeout-error',
        (e) => e.text.includes('Error inside setTimeout')
      );
    });
  });

  describe('DOM Errors', () => {
    it('captures null element access error', async () => {
      await clickAndWaitForError(
        '#btn-null-access',
        (e) =>
          e.text.includes('null') || e.text.includes('Cannot') || e.text.includes('textContent')
      );
    });

    it('captures invalid selector error', async () => {
      await clickAndWaitForError(
        '#btn-invalid-selector',
        (e) => e.text.toLowerCase().includes('selector') || e.text.toLowerCase().includes('valid')
      );
    });
  });

  describe('Clear Logs', () => {
    it('can clear captured messages', async () => {
      await clickAndWaitForConsole('#btn-console-log', (m) => m.method === 'log');
      await clickAndWaitForConsole('#btn-console-warn', (m) => m.method === 'warn');
      expect(browser.logs.getMessages().length).toBeGreaterThan(0);

      browser.logs.clearLogs();
      await browser.pause(100);
      expect(browser.logs.getMessages().length).toEqual(0);
    });

    it('can clear captured errors', async () => {
      await clickAndWaitForError('#btn-throw-error', (e) =>
        e.text.includes('This is a thrown Error')
      );
      expect(browser.logs.getErrors().length).toBeGreaterThan(0);

      browser.logs.clearLogs();
      await browser.pause(100);
      expect(browser.logs.getErrors().length).toEqual(0);
    });
  });

  describe('Event Subscription', () => {
    it('subscribes to JavaScript errors and takes screenshot on error', async () => {
      let capturedError: JavaScriptError | undefined;
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

      try {
        // 3. Trigger an error
        await browser.click('#btn-throw-error');

        // 4. Wait for the error event (instead of a fixed pause)
        await errorPromise;

        // 5. Verify subscription code got executed
        expect(capturedError).toMatchObject({
          type: 'javascript',
          text: expect.stringContaining('This is a thrown Error'),
        });
        expect(screenshotTaken).toBe(true);
      } finally {
        unsubscribe();
      }
    });
  });
});
