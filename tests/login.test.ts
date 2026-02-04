import { describe, it, afterEach, beforeAll, afterAll } from 'vitest';
import { Browser, By } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

let browser: Browser;
const baseUrl = EXAMPLES_BASE_URL;

beforeAll(async () => {
  browser = await Browser.launch({ browserName: BROWSER_NAME });
});

afterAll(async () => {
  await browser.quit();
});

describe('Login Form', () => {
  afterEach(async () => {
    await browser.click(By.css('#logout'));
    await browser.pause(100);
  });

  it('logs in and shows welcome message', async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.fill('#username', 'testuser');
    await browser.fill('#password', 'secret');
    await browser.click('#submit');
    await browser.find('#result').expect().toContainText('Welcome back, testuser!');
  });

  it('logs in and shows welcome message (with element handles)', async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.find('#username').fill('handleuser');
    await browser.find('#password').fill('secret');
    await browser.find('#submit').click();
    await browser.find('#result').expect().toContainText('Welcome back, handleuser!');
  });

  it('supports locating with By locators', async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.fill(By.id('username'), 'byuser');
    await browser.fill(By.nameAttr('password'), 'secret');
    await browser.click(By.css('#submit'));
    await browser.expect(By.css('#result')).toContainText('Welcome back, byuser!');
  });
});
