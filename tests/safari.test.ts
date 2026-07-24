/**
 * A single, focused Safari regression lane.
 *
 * Rather than gate the *entire* existing test suite against
 * `BROWSER_NAME === 'safari'` (the way `test:firefox` runs nearly everything
 * against Firefox), Safari gets this one focused lane. Safari support in this
 * repo is intentionally limited to the Classic-WebDriver allowlist (no network
 * interception, no BiDi contexts/tracing/emulation, no full-page screenshots,
 * no event-driven dialogs, etc.), so running the rest of the suite against
 * Safari would either fail loudly on structurally-unsupported features or
 * require sprinkling `skipIf` gates across dozens of unrelated files for no
 * signal.
 *
 * Instead, this one file proves Safari's Classic-only surface actually works
 * end to end on a real browser: one test per feature, not exhaustive
 * edge-case coverage (the Chrome/Firefox suites already own that). It is a
 * no-op everywhere except `test:safari` (`BROWSER_NAME=safari`).
 *
 * Per this repo's flake policy: zero automatic retries. If a step here is
 * unreliable on real Safari, that's a signal for a human to look at, not
 * something to paper over with a retry.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser, ErrorCode } from '../src';
import { BROWSER_NAME, EXAMPLES_BASE_URL } from './utils';

describe.skipIf(BROWSER_NAME !== 'safari')('Safari Classic-only regression suite', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('launches, navigates, and reports the resulting url/title', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    expect(await browser.url()).toBe(`${EXAMPLES_BASE_URL}/login.html`);
    expect(await browser.title()).toBe('Craftdriver Login Example');
  });

  it('mouse interaction: clicking #submit logs the user in', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    await browser.fill('#username', 'safariuser');
    await browser.fill('#password', 'secret');
    await browser.click('#submit');
    await browser.expect('#welcome').toContainText('Welcome back, safariuser!');
  });

  it('keyboard interaction: typing into #username lands the exact value', async () => {
    // The previous test's login left a `session` cookie behind; login.html's
    // own checkSession() would otherwise auto-log-in on load and hide the
    // form this test needs.
    await browser.storage.clearCookies();
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    await browser.fill('#username', 'keyboard-check');
    expect(await browser.getValue('#username')).toBe('keyboard-check');
  });

  it('evaluate() runs a script in the page and returns its value', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    const result = await browser.evaluate(() => 1 + 2);
    expect(result).toBe(3);
  });

  it('runs page, collection, focus, CSS, and viewport assertions', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);

    await browser.expect().toHaveURL(`${EXAMPLES_BASE_URL}/login.html`);
    await browser.expect().toHaveTitle('Craftdriver Login Example');
    await browser.locator('input').expect().toHaveCount(2);
    await browser.locator('.card').expect().toHaveCSS('display', 'block');

    await browser.click('#username');
    await browser.locator('#username').expect().toBeFocused();
    await browser.locator('#password').expect().not.toBeFocused();

    await browser.evaluate(`
      var button = document.createElement('button');
      button.id = 'safari-offscreen-button';
      button.textContent = 'Continue';
      button.style.marginTop = '200vh';
      document.body.appendChild(button);
    `);
    const button = browser.locator('#safari-offscreen-button');
    await button.expect().not.toBeInViewport();
    await browser.evaluate(`document.querySelector('#safari-offscreen-button').scrollIntoView()`);
    await button.expect().toBeInViewport();
  });

  it('screenshot() (viewport only, no fullPage) returns non-empty image data', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    const buf = await browser.screenshot();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('imperative dialog handling: acceptDialog() reads and dismisses a real alert', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/dialogs.html`);
    await browser.click('#show-alert');
    const message = await browser.getDialogMessage();
    expect(message).toBe('Hello from alert');
    await browser.acceptDialog();
    await browser.expect('h1').toHaveText('Dialogs');
  });

  it('cookies round-trip through the Classic cookie endpoints', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    await browser.storage.addCookie({ name: 'safari-e2e', value: 'roundtrip' });
    const cookies = await browser.storage.getCookies({ name: 'safari-e2e' });
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: 'safari-e2e', value: 'roundtrip' });
  });

  it('open Shadow DOM: nested semantic lookup, action, assertion, and closed-root error', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/shadow-dom.html`);
    const address = browser
      .locator('#card')
      .shadowRoot()
      .locator('address-form')
      .shadowRoot();

    await address.getByLabel('City').fill('Safari');
    await address.getByRole('button', { name: 'Save address' }).click();
    await browser.expect('#status').toHaveText('saved:Safari');

    await expect(
      browser.locator('#closed-card').shadowRoot().locator('button').count()
    ).rejects.toMatchObject({ code: ErrorCode.NO_OPEN_SHADOW_ROOT });
  });
});
