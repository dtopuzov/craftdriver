import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Expect assertions', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${baseUrl}/login.html`);
  });

  describe('toHaveText()', () => {
    it('asserts exact text match', async () => {
      await browser.expect('h1').toHaveText('Login');
    });

    it('supports regex matching', async () => {
      await browser.expect('h1').toHaveText(/Log.*/);
    });
  });

  describe('toContainText()', () => {
    it('asserts partial text match', async () => {
      await browser.expect('h1').toContainText('Log');
    });

    it('supports regex matching', async () => {
      await browser.expect('h1').toContainText(/og/);
    });
  });

  describe('toHaveValue()', () => {
    it('asserts input value', async () => {
      await browser.fill('#username', 'testvalue');
      await browser.expect('#username').toHaveValue('testvalue');
    });

    it('supports regex matching', async () => {
      await browser.fill('#username', 'prefix_12345');
      await browser.expect('#username').toHaveValue(/prefix_\d+/);
    });
  });

  describe('toHaveAttribute()', () => {
    it('asserts attribute value', async () => {
      await browser.expect('#password').toHaveAttribute('type', 'password');
    });

    it('checks attribute existence without value', async () => {
      await browser.expect('#username').toHaveAttribute('id');
    });
  });

  describe('toHaveClass()', () => {
    it('checks for class name', async () => {
      await browser.expect('.card').toHaveClass('card');
    });
  });

  describe('toBeVisible()', () => {
    it('passes for visible elements', async () => {
      await browser.expect('#username').toBeVisible();
    });
  });

  describe('toBeEnabled()', () => {
    it('passes for enabled input', async () => {
      await browser.expect('#username').toBeEnabled();
    });
  });

  describe('page assertions', () => {
    it('asserts the active page URL and title', async () => {
      await browser.expect().toHaveURL(`${baseUrl}/login.html`);
      await browser.expect().toHaveURL(/\/login\.html$/);
      await browser.expect().toHaveTitle('Craftdriver Login Example');
      await browser.expect().not.toHaveTitle('Dashboard');

      await browser.evaluate(`
        setTimeout(function() { document.title = 'Delayed dashboard'; }, 100);
      `);
      await browser.expect().toHaveTitle('Delayed dashboard');
    });

    it('works on an explicit Page', async () => {
      const page = await browser.activePage();
      await page.expect().toHaveURL(`${baseUrl}/login.html`);
      await page.expect().toHaveTitle(/Login Example$/);
      await page.expect().not.toHaveURL(/\/dashboard/);
    });
  });

  describe('toHaveCount()', () => {
    it('asserts a locator collection and auto-waits for changes', async () => {
      await browser.locator('input').expect().toHaveCount(2);
      await browser.locator('input').expect().not.toHaveCount(1);
      await browser.locator('.does-not-exist').expect().toHaveCount(0);

      await browser.evaluate(`
        setTimeout(function() {
          var input = document.createElement('input');
          input.id = 'delayed-input';
          document.body.appendChild(input);
        }, 100);
      `);
      await browser.expect('input').toHaveCount(3);
    });

    it('rejects invalid counts', async () => {
      await expect(browser.expect('input').toHaveCount(-1)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    });
  });

  describe('toBeFocused()', () => {
    it('supports positive and negated focus assertions', async () => {
      await browser.click('#username');
      await browser.locator('#username').expect().toBeFocused();
      await browser.locator('#password').expect().not.toBeFocused();
    });
  });

  describe('toHaveCSS()', () => {
    it('asserts computed CSS and auto-waits for style changes', async () => {
      await browser.locator('.card').expect().toHaveCSS('display', 'block');
      await browser.locator('.card').expect().not.toHaveCSS('display', 'flex');

      await browser.evaluate(`
        setTimeout(function() {
          document.querySelector('.card').style.display = 'flex';
        }, 100);
      `);
      await browser.expect('.card').toHaveCSS('display', 'flex');
    });
  });

  describe('toBeInViewport()', () => {
    it('distinguishes an attached offscreen element from one in the viewport', async () => {
      await browser.evaluate(`
        var button = document.createElement('button');
        button.id = 'offscreen-button';
        button.textContent = 'Continue';
        button.style.marginTop = '200vh';
        document.body.appendChild(button);
      `);

      const button = browser.locator('#offscreen-button');
      await button.expect().not.toBeInViewport();
      await browser.evaluate(`document.querySelector('#offscreen-button').scrollIntoView()`);
      await button.expect().toBeInViewport();
    });

    it('does not let a missing locator satisfy the negated assertion', async () => {
      await expect(
        browser.locator('#does-not-exist').expect().not.toBeInViewport({ timeout: 10 })
      ).rejects.toMatchObject({ code: 'EXPECT_MISMATCH' });
    });
  });

  describe('not.* negations', () => {
    it('not.toHaveText() asserts text does not match', async () => {
      await browser.expect('h1').not.toHaveText('Dashboard');
    });

    it('not.toHaveValue() asserts value does not match', async () => {
      await browser.fill('#username', 'abc');
      await browser.expect('#username').not.toHaveValue('xyz');
    });

    it('not.toContainText() asserts partial text does not match', async () => {
      await browser.expect('h1').not.toContainText('Dashboard');
    });

    it('not.toHaveAttribute() asserts attribute does not match', async () => {
      await browser.expect('#username').not.toHaveAttribute('type', 'password');
    });

    it('not.toBeVisible() asserts element is not visible', async () => {
      // Result is hidden initially
      await browser.expect('#result').not.toBeVisible();
    });
  });
});
