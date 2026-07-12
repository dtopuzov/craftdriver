/**
 * Electron e2e — the product truth for `Browser.launch({ electron })`: drive the
 * packaged **craftdriver-examples** app (https://github.com/dtopuzov/craftdriver-examples)
 * through its real UI, exactly as a user would. The app is downloaded once by the
 * global setup (see ./fixture); with no app available this file collects-and-skips.
 *
 * These are deliberately flow-shaped (several interactions per test) — appropriate
 * for slow, heavy GUI e2e — not one assertion per test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Browser, By } from '../../src';
import { resolveElectronAppPath, launchExampleApp } from './fixture';

const APP_PATH = resolveElectronAppPath();
const PNG_SIGNATURE = '89504e470d0a1a0a';

function expectPng(buffer: Buffer): void {
  expect(buffer.length).toBeGreaterThan(100);
  expect(buffer.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE);
}

describe.runIf(!!APP_PATH)('Electron example app', () => {
  let browser: Browser | undefined;

  afterEach(async (ctx) => {
    const current = browser;
    browser = undefined;
    // On failure, drop a screenshot into the CI artifacts dir (a red GUI run needs
    // something to look at). Never let capture failure mask the real test failure.
    const dir = process.env.CRAFTDRIVER_ARTIFACTS_DIR;
    if (dir && ctx.task.result?.state === 'fail' && current) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const name = ctx.task.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        await current.screenshot({ path: path.join(dir, `${name}.png`) });
      } catch {
        /* ignore */
      }
    }
    await current?.quit();
  });

  it('starts the packaged app and shows the Electron shell', async () => {
    browser = await launchExampleApp(APP_PATH!);

    // Electron defaults to Classic (browsers default to BiDi); the app keeps its own
    // UI and we find/click immediately — no navigate.
    expect(browser.isBiDiEnabled()).toBe(false);

    // The preload bridge reporting the real host proves this is Electron, not a
    // stray Chrome.
    await browser.find(By.testId('app-title')).expect().toHaveText('Craftdriver Example App');
    await browser.find(By.testId('env-shell')).expect().toHaveText('electron');
    await browser.find(By.testId('env-electron')).expect().toContainText('43');
    await browser.find(By.testId('active-view')).expect().toHaveText('home');
  });

  it('captures viewport and element screenshots in Classic mode', async () => {
    browser = await launchExampleApp(APP_PATH!);

    await browser.find(By.testId('app-title')).expect().toBeVisible();

    // Viewport screenshots use the standard WebDriver screenshot endpoint; element
    // screenshots use the WebDriver element screenshot endpoint. Both should work
    // for Electron's default Classic mode without opting into BiDi.
    expectPng(await browser.screenshot());
    expectPng(await browser.find(By.testId('app-title')).screenshot());
  });

  it('drives navigation, form validation, the list, and a dialog', async () => {
    browser = await launchExampleApp(APP_PATH!);

    // Navigate across the four views.
    await browser.click(By.testId('nav-form'));
    await browser.find(By.testId('view-form')).expect().toBeVisible();
    await browser.find(By.testId('view-home')).expect().not.toBeVisible();

    // Form validation: empty → name error; name only → email error; both → greeting.
    await browser.click(By.testId('submit-btn'));
    await browser.find(By.testId('form-error')).expect().toHaveText('Name is required.');
    await browser.fill(By.testId('name-input'), 'Ada Lovelace');
    await browser.click(By.testId('submit-btn'));
    await browser.find(By.testId('form-error')).expect().toHaveText('A valid email is required.');
    await browser.fill(By.testId('email-input'), 'ada@example.com');
    await browser.click(By.testId('submit-btn'));
    await browser
      .find(By.testId('form-result'))
      .expect()
      .toContainText('Hello, Ada Lovelace (ada@example.com)!');

    // List: add two, remove one, remove the last → empty state returns.
    await browser.click(By.testId('nav-list'));
    await browser.find(By.testId('list-empty')).expect().toBeVisible();
    await browser.fill(By.testId('item-input'), 'Buy milk');
    await browser.click(By.testId('add-item-btn'));
    await browser.fill(By.testId('item-input'), 'Write tests');
    await browser.click(By.testId('add-item-btn'));
    await browser.find(By.testId('list-count')).expect().toHaveText('2');
    await browser.locator(By.testId('item-remove-btn')).first().click();
    await browser.find(By.testId('item-text')).expect().toHaveText('Write tests');
    await browser.locator(By.testId('item-remove-btn')).first().click();
    await browser.find(By.testId('list-empty')).expect().toBeVisible();

    // In-page <dialog>: cancel then confirm.
    await browser.click(By.testId('nav-dialog'));
    await browser.click(By.testId('open-dialog-btn'));
    await browser.click(By.testId('dialog-cancel-btn'));
    await browser.find(By.testId('dialog-result')).expect().toHaveText('cancelled');
    await browser.click(By.testId('open-dialog-btn'));
    await browser.click(By.testId('dialog-confirm-btn'));
    await browser.find(By.testId('dialog-result')).expect().toHaveText('confirmed');
  });

  it('handles a splash screen: waits past it, then drives the main window', async () => {
    browser = await launchExampleApp(APP_PATH!, { splash: true });

    // The app opens a frameless splash first; wait for the real window by title
    // rather than guessing when the handoff happened.
    const main = await browser.waitForPage({ title: /Example App/ }, { timeout: 20_000 });
    await main.find(By.testId('app-title')).expect().toHaveText('Craftdriver Example App');

    // waitForPage made the main window current (Classic), so the top-level browser
    // API drives it too.
    await browser.click(By.testId('nav-form'));
    await browser.find(By.testId('active-view')).expect().toHaveText('form');

    // Once the splash closes, one window remains and activePage() resolves to it
    // instead of failing on the closed handle.
    const deadline = Date.now() + 15_000;
    while ((await browser.pages()).length > 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect((await browser.pages()).length).toBe(1);
    expect(await (await browser.activePage()).title()).toBe('Craftdriver Example App');
  });

  it('opts into BiDi and captures renderer console output', async () => {
    browser = await launchExampleApp(APP_PATH!, { bidi: true });
    expect(browser.isBiDiEnabled()).toBe(true);
    expect(await browser.url()).toBe('about:blank'); // BiDi resets the page at connect

    const message = browser.logs.waitForConsole(
      (entry) => entry.text.includes('craftdriver-electron-bidi-ready'),
      5_000
    );
    await browser.navigateTo(
      'data:text/html,<script>console.log("craftdriver-electron-bidi-ready")</script>'
    );
    await expect(message).resolves.toMatchObject({ type: 'console' });
  });
});
