// Runnable proof for docs/recipes/page-objects.md
// The MD snippet is the LoginPage class plus the test body below.
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

class LoginPage {
  constructor(
    private readonly browser: Browser,
    private readonly baseUrl: string
  ) {}

  async open() {
    await this.browser.navigateTo(`${this.baseUrl}/login.html`);
  }

  async loginAs(username: string, password: string) {
    await this.browser.getByLabel('Username').fill(username);
    await this.browser.getByLabel('Password').fill(password);
    await this.browser.getByRole('button', { name: 'Sign in' }).click();
  }

  async expectWelcome(username: string) {
    await this.browser.expect('#welcome').toContainText(`Welcome back, ${username}!`);
  }
}

describe('login (page object)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('signs in through the page object', async () => {
    const loginPage = new LoginPage(browser, EXAMPLES_BASE_URL);

    await loginPage.open();
    await loginPage.loginAs('alice', 'secret');
    await loginPage.expectWelcome('alice');
  });
});
