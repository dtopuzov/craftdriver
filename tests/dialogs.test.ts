import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, type Dialog } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Dialog handling (alert / confirm / prompt)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/dialogs.html`);
  });

  async function clickAndWaitForDialog(selector: string): Promise<Dialog> {
    const [, dialog] = await Promise.all([browser.click(selector), browser.waitForDialog()]);
    return dialog;
  }

  // ── alert ──────────────────────────────────────────────────────────────────

  it('accepts an alert', async () => {
    const dialog = await clickAndWaitForDialog('#show-alert');
    expect(dialog.type()).toBe('alert');
    expect(dialog.message()).toBe('Hello from alert');
    await dialog.accept();
    // Page should be responsive again
    await browser.expect('h1').toHaveText('Dialogs');
  });

  it('dismisses an alert', async () => {
    const dialog = await clickAndWaitForDialog('#show-alert');
    await dialog.dismiss();
    await browser.expect('h1').toHaveText('Dialogs');
  });

  // ── confirm ────────────────────────────────────────────────────────────────

  it('accepting a confirm records "confirmed" on the page', async () => {
    const dialog = await clickAndWaitForDialog('#show-confirm');
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toBe('Are you sure?');
    await dialog.accept();
    await browser.expect('#confirm-result').toHaveText('confirmed');
  });

  it('dismissing a confirm records "dismissed" on the page', async () => {
    const dialog = await clickAndWaitForDialog('#show-confirm');
    await dialog.dismiss();
    await browser.expect('#confirm-result').toHaveText('dismissed');
  });

  // ── prompt ─────────────────────────────────────────────────────────────────

  it('accepting a prompt with text echoes the value on the page', async () => {
    const dialog = await clickAndWaitForDialog('#show-prompt');
    expect(dialog.type()).toBe('prompt');
    expect(dialog.defaultValue()).toBe('default');
    await dialog.accept('craftdriver');
    await browser.expect('#prompt-result').toHaveText('craftdriver');
  });

  it('dismissing a prompt echoes "dismissed" on the page', async () => {
    const dialog = await clickAndWaitForDialog('#show-prompt');
    await dialog.dismiss();
    await browser.expect('#prompt-result').toHaveText('dismissed');
  });

  // ── onDialog persistent handler ────────────────────────────────────────────

  it('onDialog registers a persistent handler', async () => {
    let capturedMessage = '';
    let resolveHandled!: () => void;
    const handled = new Promise<void>((resolve) => {
      resolveHandled = resolve;
    });

    const off = browser.onDialog(async (dialog) => {
      capturedMessage = dialog.message();
      await dialog.accept();
      resolveHandled();
    });

    try {
      await browser.click('#show-alert');
      await handled;
    } finally {
      off();
    }

    expect(capturedMessage).toBe('Hello from alert');
  });

  // ── imperative API ─────────────────────────────────────────────────────────

  it('acceptDialog() imperative form works without onDialog', async () => {
    await clickAndWaitForDialog('#show-alert');
    // Use imperative API directly
    await browser.acceptDialog();
    await browser.expect('h1').toHaveText('Dialogs');
  });
});
