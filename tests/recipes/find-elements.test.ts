// Runnable proof for docs/recipes/find-elements.md
// Two MD snippets are mirrored here: the stable-anchor flow and the
// user-facing (getBy*) flow. Each test re-navigates so the core of each block
// stays line-for-line identical to its snippet.
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { Browser, By } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('find elements (login page)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  beforeEach(async () => {
    // The login example persists a session cookie; clear it so each test
    // starts from the signed-out form rather than a prior test's session.
    await browser.defaultContext.clearCookies();
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('locates elements by stable, language-neutral anchors', async () => {
    // Fields by their `name` — a form contract, not UI text
    await browser.find(By.name('username')).fill('alice');
    await browser.find(By.name('password')).fill('secret');

    // The submit button by its semantic type
    await browser.find('button[type="submit"]').click();

    // The result by its stable id
    await browser.locator('#welcome').expect().toBeVisible();
  });

  it('locates the same elements the way a user sees the page', async () => {
    // "the Login heading"
    await browser.getByRole('heading', { name: 'Login' }).expect().toBeVisible();

    // "the Username / Password fields", found through their <label>
    await browser.getByLabel('Username').fill('alice');
    await browser.getByLabel('Password').fill('secret');

    // "the Sign in button", by role + accessible name
    await browser.getByRole('button', { name: 'Sign in' }).click();

    // "the welcome message", by its visible text
    await browser.getByText('Welcome back, alice!').expect().toBeVisible();
  });
});
