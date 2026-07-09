// Runnable proof for docs/recipes/console-error-gate.md
// The MD "gate" block is the first test's body; the "wait for a known log"
// block is the second test's body. The third test proves the gate actually
// fails on a real error.
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('fail on console and JavaScript errors', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({
      browserName: BROWSER_NAME,
    });
  });

  beforeEach(async () => {
    await browser.navigateTo(`${baseUrl}/console-errors.html`);
    browser.logs.clearLogs();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('passes when the flow logs no JavaScript errors', async () => {
    await browser.click('#btn-console-log'); // a benign, expected log
    browser.logs.assertNoErrors();
  });

  it('waits for a known log before asserting on it', async () => {
    const logged = browser.logs.waitForConsole((message) =>
      message.text.includes('Hello from console.log')
    );

    await browser.click('#btn-console-log');
    await logged;
  });

  it('the gate fails when the page throws', async () => {
    const thrown = browser.logs.waitForError((error) =>
      error.text.includes('This is a thrown Error')
    );

    await browser.click('#btn-throw-error');
    await thrown;

    expect(() => browser.logs.assertNoErrors()).toThrow(/JavaScript errors/);
  });
});
