import { describe, it, beforeAll, afterAll } from 'vitest';
import { Browser, By } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Login Form', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('logs in and shows welcome message', async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.fill('#username', 'testuser');
    await browser.fill('#password', 'secret');
    await browser.click('#submit');
    await browser.expect('#result').toHaveText('Welcome testuser');
  });

  it('logs in and shows welcome message (with element handles)', async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.find('#username').fill('handleuser');
    await browser.find('#password').fill('secret');
    await browser.find('#submit').click();
    await browser.find('#result').expect().toHaveText('Welcome handleuser');
  });

  it('supports locating with By locators', async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.fill(By.id('username'), 'byuser');
    await browser.fill(By.nameAttr('password'), 'secret');
    await browser.click(By.css('#submit'));
    await browser.expect(By.css('#result')).toHaveText('Welcome byuser');
  });

  describe('fill(), clear(), getValue(), getAttribute()', () => {
    it('fill() clears existing text before typing', async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
      await browser.fill('#username', 'initial');
      await browser.fill('#username', 'replaced');
      await browser.expect('#username').toHaveValue('replaced');
    });

    it('clear() removes text from input', async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
      await browser.fill('#username', 'some text');
      await browser.clear('#username');
      await browser.expect('#username').toHaveValue('');
    });

    it('getValue() returns input value', async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
      await browser.fill('#username', 'myvalue');
      const val = await browser.getValue('#username');
      if (val !== 'myvalue') throw new Error(`Expected "myvalue" but got "${val}"`);
    });

    it('getAttribute() returns element attribute', async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
      const typeAttr = await browser.getAttribute('#username', 'type');
      if (typeAttr !== 'text') throw new Error(`Expected "text" but got "${typeAttr}"`);
    });
  });
});
