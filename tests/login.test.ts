import { describe, it, beforeAll, afterAll } from 'vitest';
import { Browser, By } from '../src';
import { EXAMPLES_BASE_URL } from './utils';

describe('Login Form', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: process.env.BROWSER_NAME || 'chrome' });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('logs in and shows welcome message', async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.type('#username', 'testuser');
    await browser.type('#password', 'secret');
    await browser.click('#submit');
    await browser.expect('#result').toHaveText('Welcome testuser');
  });

  it('logs in and shows welcome message (with element handles)', async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.find('#username').type('handleuser');
    await browser.find('#password').type('secret');
    await browser.find('#submit').click();
    await browser.find('#result').expect().toHaveText('Welcome handleuser');
  });

  it('supports locating with By locators', async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.type(By.id('username'), 'byuser');
    await browser.type(By.nameAttr('password'), 'secret');
    await browser.click(By.css('#submit'));
    await browser.expect(By.css('#result')).toHaveText('Welcome byuser');
  });
});
