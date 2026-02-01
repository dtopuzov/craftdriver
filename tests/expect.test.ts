import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
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
