import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('ElementHandle API', () => {
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

  describe('fill() and clear()', () => {
    it('fill() clears and types new text', async () => {
      await browser.find('#username').fill('old');
      await browser.find('#username').fill('new');
      await browser.find('#username').expect().toHaveValue('new');
    });

    it('clear() empties the field', async () => {
      await browser.find('#username').fill('content');
      await browser.find('#username').clear();
      await browser.find('#username').expect().toHaveValue('');
    });
  });

  describe('getters', () => {
    it('text() returns element text content', async () => {
      const heading = await browser.find('h1').text();
      if (!heading.includes('Login')) throw new Error(`Expected heading to contain "Login"`);
    });

    it('value() returns input value', async () => {
      await browser.find('#username').fill('test123');
      const val = await browser.find('#username').value();
      if (val !== 'test123') throw new Error(`Expected "test123" but got "${val}"`);
    });

    it('getAttribute() returns attribute value', async () => {
      const attr = await browser.find('#password').getAttribute('type');
      if (attr !== 'password') throw new Error(`Expected "password" but got "${attr}"`);
    });
  });

  describe('state checks', () => {
    it('isVisible() returns true for visible elements', async () => {
      const visible = await browser.find('#username').isVisible();
      if (!visible) throw new Error('Expected element to be visible');
    });

    it('isEnabled() returns true for enabled inputs', async () => {
      const enabled = await browser.find('#username').isEnabled();
      if (!enabled) throw new Error('Expected element to be enabled');
    });
  });

  describe('geometry', () => {
    it('boundingBox() returns element dimensions', async () => {
      const box = await browser.find('#username').boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) {
        throw new Error('Expected bounding box with positive dimensions');
      }
    });
  });

  describe('chained expect()', () => {
    it('expect() returns assertion API for element', async () => {
      await browser.find('#username').fill('chained');
      await browser.find('#username').expect().toHaveValue('chained');
    });
  });
});
