/**
 * Electron deep-link e2e — product truth for `browser.electron.triggerDeeplink()`.
 * Opens a real custom-protocol URL through the OS launcher and asserts the running
 * example app's protocol handler received it (renderer + main process).
 *
 * Runs automatically on **macOS**, where a packaged bundle can be registered with
 * LaunchServices at runtime (`lsregister`) so `open <scheme>://` routes to the running
 * instance. On **Linux and Windows** the CI fixtures are *zip* extracts, not installed
 * apps, so the OS has no registered handler for the scheme and routing can't work — the
 * suite skips there. Force it anyway (e.g. against an installed app) with
 * `CRAFTDRIVER_ELECTRON_DEEPLINK=1`.
 *
 * Needs a fixture built with the `craftdriver-example://` protocol handler
 * (craftdriver-examples >= v0.1.5).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Browser, By } from '../../src';
import { resolveElectronAppPath, launchExampleApp } from './fixture';

const APP_PATH = resolveElectronAppPath();
const ENABLED =
  !!APP_PATH &&
  (process.platform === 'darwin' || process.env.CRAFTDRIVER_ELECTRON_DEEPLINK === '1');
const SCHEME = 'craftdriver-example';

describe.runIf(ENABLED)('Electron deep links (browser.electron.triggerDeeplink)', () => {
  let browser: Browser;

  beforeAll(async () => {
    // macOS only routes `open <scheme>://` to a bundle LaunchServices knows about.
    // The .app is two levels up from .../Contents/MacOS/<exe>.
    if (process.platform === 'darwin') {
      const appBundle = path.resolve(APP_PATH!, '..', '..', '..');
      try {
        execFileSync(
          '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
          ['-f', appBundle]
        );
      } catch {
        /* best-effort: if this fails the assertions below will show the miss */
      }
    }
    browser = await launchExampleApp(APP_PATH!, { mainProcess: true });
  });

  afterAll(async () => {
    await browser?.quit();
  });

  it('routes a custom-protocol URL to the app open-url / second-instance handler', async () => {
    await browser.click(By.testId('nav-dialog'));

    const url = `${SCHEME}://open?file=invoice.txt`;
    await browser.electron.triggerDeeplink(url);

    // The OS launcher is fire-and-forget; assert the effect through the app.
    await browser.find(By.testId('deeplink-result')).expect().toHaveText(url, { timeout: 10_000 });

    // The main process saw it too (independent of the renderer wiring).
    const mainSeen = await browser.electron.executeMain(
      () => (globalThis as { __craftdriverLastDeeplink?: string }).__craftdriverLastDeeplink ?? null
    );
    expect(mainSeen).toBe(url);
  });

  it('rejects non-custom protocols before doing anything', async () => {
    await expect(browser.electron.triggerDeeplink('https://example.com')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
