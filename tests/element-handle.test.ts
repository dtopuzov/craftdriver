import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
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

  describe('click()', () => {
    beforeEach(async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
    });

    it('clicks an element scrolled below the fold', async () => {
      await browser.evaluate(() => {
        const spacer = document.createElement('div');
        const button = document.createElement('button');
        const status = document.createElement('div');
        spacer.style.height = '2500px';
        button.id = 'below-fold-click-target';
        button.textContent = 'Click below fold';
        status.id = 'below-fold-click-status';
        status.textContent = 'Not clicked';
        button.addEventListener('click', () => {
          status.textContent = 'Clicked below fold';
        });
        document.body.insertBefore(spacer, document.body.firstChild);
        spacer.after(button, status);
        window.scrollTo(0, 0);
      });

      await browser.find('#below-fold-click-target').click();
      await browser.expect('#below-fold-click-status').toContainText('Clicked below fold');
    });
  });

  describe('text(), value(), tagName(), getAttribute()', () => {
    beforeEach(async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
    });

    it('text() returns element text content', async () => {
      const heading = await browser.find('h1').text();
      expect(heading).toContain('Login');
    });

    it('value() returns input value', async () => {
      await browser.find('#username').fill('test123');
      const val = await browser.find('#username').value();
      expect(val).toBe('test123');
    });

    it('tagName() returns element tag name', async () => {
      const tag = await browser.find('h1').tagName();
      expect(tag).toBe('h1');
    });

    it('getAttribute() returns attribute value', async () => {
      const attr = await browser.find('#password').getAttribute('type');
      expect(attr).toBe('password');
    });
  });

  describe('isVisible(), isEnabled(), isChecked()', () => {
    beforeEach(async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
    });

    it('isVisible() returns true for visible elements', async () => {
      const visible = await browser.find('#username').isVisible();
      expect(visible).toBe(true);
    });

    it('isEnabled() returns true for enabled inputs', async () => {
      const enabled = await browser.find('#username').isEnabled();
      expect(enabled).toBe(true);
    });
  });

  // Displayedness (W3C-compatible atom replacing legacy /element/{id}/displayed).
  // Runs on every supported browser; results must be identical to what the
  // legacy endpoint produced on Chrome/Chromium/Firefox.
  describe('isVisible() displayedness', () => {
    beforeEach(async () => {
      await browser.navigateTo(`${baseUrl}/displayed.html`);
    });

    it('reports a plainly visible element as visible', async () => {
      expect(await browser.find('#visible-el').isVisible()).toBe(true);
    });

    it('reports an element with a display:none ancestor as not visible', async () => {
      expect(await browser.find('#hidden-by-ancestor').isVisible()).toBe(false);
    });

    it('reports an element with its own display:none as not visible', async () => {
      expect(await browser.find('#display-none-self').isVisible()).toBe(false);
    });

    it('reports an element with its own visibility:hidden as not visible', async () => {
      expect(await browser.find('#visibility-hidden').isVisible()).toBe(false);
    });

    it('respects a visibility:visible descendant override of a hidden ancestor', async () => {
      expect(await browser.find('#visibility-visible-override').isVisible()).toBe(true);
    });

    it('reports a zero-sized (0x0, overflow:hidden) element as not visible', async () => {
      expect(await browser.find('#zero-size').isVisible()).toBe(false);
    });

    it('reports a <br> (legitimately zero-width) as visible', async () => {
      expect(await browser.find('#line-break').isVisible()).toBe(true);
    });

    it('reports an element clipped out of an overflow:hidden container as not visible', async () => {
      expect(await browser.find('#scrolled-out-of-clip').isVisible()).toBe(false);
    });
  });

  describe('boundingBox()', () => {
    it('returns element dimensions', async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
      const box = await browser.find('#username').boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
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

    it('hovers an element scrolled below the fold', async () => {
      // Push the tooltip trigger far below the viewport, then hover it without
      // scrolling manually. Chrome scrolls element-origin Actions moves into
      // view, but geckodriver may reject them as out of bounds; pointerMoveTo()
      // should handle that by scrolling the element into view and retrying.
      await browser.evaluate(() => {
        const spacer = document.createElement('div');
        spacer.style.height = '2500px';
        document.body.insertBefore(spacer, document.body.firstChild);
        window.scrollTo(0, 0);
      });

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

      await browser.expect('#language-select').toHaveValue('es');
      await browser.expect('#select-result').toContainText('Language: es');
    });

    it('throws error when using select on non-select element', async () => {
      await expect(browser.find('#tooltip-trigger').select('invalid')).rejects.toThrow(
        /select\(\) can only be used on <select> elements\. Found <div> instead\./
      );
    });
  });

  describe('expect()', () => {
    it('returns assertion API for element', async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
      await browser.find('#username').fill('chained');
      await browser.find('#username').expect().toHaveValue('chained');
    });
  });

  describe('screenshot() error paths', () => {
    it('throws when capturing a detached element', async () => {
      await browser.navigateTo(`${baseUrl}/dynamic.html`);
      // Resolve once while attached, then remove the element from the DOM.
      const handle = browser.find('#to-remove');
      await handle.expect().toBeVisible();
      await browser.click('#btn-remove');
      // The element is now detached — screenshot should reject loudly,
      // not return an empty buffer.
      await expect(handle.screenshot({ timeout: 500 })).rejects.toThrow();
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

  it('fill() does not click the target before typing', async () => {
    await browser.evaluate(() => {
      (window as any).__fillClickCount = 0;
      document.getElementById('username')?.addEventListener('click', () => {
        (window as any).__fillClickCount += 1;
      });
    });

    await browser.fill('#username', 'typed');

    expect(await browser.evaluate(() => (window as any).__fillClickCount)).toBe(0);
  });

  it('fill() waits for an attached input to become visible', async () => {
    await browser.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'delayed-fill';
      input.style.display = 'none';
      document.body.appendChild(input);
      setTimeout(() => {
        input.style.display = 'block';
      }, 300);
    });

    await browser.fill('#delayed-fill', 'visible now', { timeout: 3000 });

    await browser.expect('#delayed-fill').toHaveValue('visible now');
  });

  it('clear() removes text from input', async () => {
    await browser.fill('#username', 'some text');
    await browser.clear('#username');
    await browser.expect('#username').toHaveValue('');
  });

  it('clear() skips the visibility wait when the input is already ready', async () => {
    await browser.fill('#username', 'some text');

    const driver = (browser as any).driver;
    const originalWait = driver.wait.bind(driver);
    let waitCalls = 0;
    driver.wait = (...args: any[]) => {
      waitCalls += 1;
      return originalWait(...args);
    };

    try {
      await browser.clear('#username');
    } finally {
      driver.wait = originalWait;
    }

    expect(waitCalls).toBe(0);
    await browser.expect('#username').toHaveValue('');
  });

  it('clear() waits for an attached input to become visible', async () => {
    await browser.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'delayed-clear';
      input.value = 'content';
      input.style.display = 'none';
      document.body.appendChild(input);
      setTimeout(() => {
        input.style.display = 'block';
      }, 300);
    });

    const driver = (browser as any).driver;
    const originalWait = driver.wait.bind(driver);
    let waitCalls = 0;
    driver.wait = (...args: any[]) => {
      waitCalls += 1;
      return originalWait(...args);
    };

    try {
      await browser.clear('#delayed-clear', { timeout: 3000 });
    } finally {
      driver.wait = originalWait;
    }

    expect(waitCalls).toBeGreaterThan(0);
    await browser.expect('#delayed-clear').toHaveValue('');
  });

  it('getValue() returns input value', async () => {
    await browser.fill('#username', 'myvalue');
    const val = await browser.getValue('#username');
    expect(val).toBe('myvalue');
  });

  it('getAttribute() returns element attribute', async () => {
    const typeAttr = await browser.getAttribute('#username', 'type');
    expect(typeAttr).toBe('text');
  });
});
