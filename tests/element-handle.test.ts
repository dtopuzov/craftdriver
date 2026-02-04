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

  describe('fill() and clear()', () => {
    beforeEach(async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
    });

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

  describe('text(), value(), tag(), getAttribute()', () => {
    beforeEach(async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
    });

    it('text() returns element text content', async () => {
      const heading = await browser.find('h1').text();
      if (!heading.includes('Login')) throw new Error(`Expected heading to contain "Login"`);
    });

    it('value() returns input value', async () => {
      await browser.find('#username').fill('test123');
      const val = await browser.find('#username').value();
      if (val !== 'test123') throw new Error(`Expected "test123" but got "${val}"`);
    });

    it('tag() returns element tag name', async () => {
      const tag = await browser.find('h1').tag();
      if (tag !== 'h1') throw new Error(`Expected "h1" but got "${tag}"`);
    });

    it('getAttribute() returns attribute value', async () => {
      const attr = await browser.find('#password').getAttribute('type');
      if (attr !== 'password') throw new Error(`Expected "password" but got "${attr}"`);
    });
  });

  describe('isVisible(), isEnabled(), isChecked()', () => {
    beforeEach(async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
    });

    it('isVisible() returns true for visible elements', async () => {
      const visible = await browser.find('#username').isVisible();
      if (!visible) throw new Error('Expected element to be visible');
    });

    it('isEnabled() returns true for enabled inputs', async () => {
      const enabled = await browser.find('#username').isEnabled();
      if (!enabled) throw new Error('Expected element to be enabled');
    });
  });

  describe('boundingBox()', () => {
    it('returns element dimensions', async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
      const box = await browser.find('#username').boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) {
        throw new Error('Expected bounding box with positive dimensions');
      }
    });
  });

  describe('hover()', () => {
    beforeEach(async () => {
      await browser.navigateTo(`${baseUrl}/hover-select.html`);
    });

    it('shows tooltip on hover', async () => {
      await browser.find('#tooltip-trigger').hover();
      await browser.expect('#tooltip-status').toContainText('Tooltip is visible');
    });
  });

  describe('select()', () => {
    beforeEach(async () => {
      await browser.navigateTo(`${baseUrl}/hover-select.html`);
    });

    it('selects option from dropdown', async () => {
      await browser.find('#language-select').select('es');

      const value = await browser.getValue('#language-select');
      if (value !== 'es') {
        throw new Error(`Expected language to be "es" but got "${value}"`);
      }

      await browser.expect('#select-result').toContainText('Language: es');
    });

    it('throws error when using select on non-select element', async () => {
      let errorThrown = false;
      try {
        await browser.find('#tooltip-trigger').select('invalid');
      } catch (error: any) {
        errorThrown = true;
        if (!error.message.includes('can only be used on <select> elements')) {
          throw new Error(`Expected specific error message but got: ${error.message}`);
        }
        if (!error.message.includes('Found <div>')) {
          throw new Error(`Expected error to mention element type but got: ${error.message}`);
        }
      }

      if (!errorThrown) {
        throw new Error('Expected select() to throw error on non-select element');
      }
    });
  });

  describe('expect()', () => {
    it('returns assertion API for element', async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
      await browser.find('#username').fill('chained');
      await browser.find('#username').expect().toHaveValue('chained');
    });
  });
});

describe('Browser-level element methods', () => {
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

  it('fill() clears existing text before typing', async () => {
    await browser.fill('#username', 'initial');
    await browser.fill('#username', 'replaced');
    await browser.expect('#username').toHaveValue('replaced');
  });

  it('clear() removes text from input', async () => {
    await browser.fill('#username', 'some text');
    await browser.clear('#username');
    await browser.expect('#username').toHaveValue('');
  });

  it('getValue() returns input value', async () => {
    await browser.fill('#username', 'myvalue');
    const val = await browser.getValue('#username');
    if (val !== 'myvalue') throw new Error(`Expected "myvalue" but got "${val}"`);
  });

  it('getAttribute() returns element attribute', async () => {
    const typeAttr = await browser.getAttribute('#username', 'type');
    if (typeAttr !== 'text') throw new Error(`Expected "text" but got "${typeAttr}"`);
  });
});
