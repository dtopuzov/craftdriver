import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, By } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('By locator strategies (selectors.html)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });
  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/selectors.html`);
  });

  it('By.id', async () => {
    await browser.click(By.id('by-id'));
    await browser.expect('#status').toHaveText('by-id');
  });

  it('By.name', async () => {
    await browser.click(By.name('by-name'));
    await browser.expect('#status').toHaveText('by-name');
  });

  it('By.className', async () => {
    await browser.click(By.className('foo'));
    await browser.expect('#status').toHaveText('by-class');
  });

  it('By.tagName', async () => {
    await browser.click(By.tagName('img'));
    await browser.expect('#status').toHaveText('by-alt');
  });

  it('By.attr', async () => {
    await browser.click(By.attr('data-custom', 'cval'));
    await browser.expect('#status').toHaveText('by-data-attr');
  });

  it('By.dataAttr & By.testId', async () => {
    await browser.click(By.testId('by-testid'));
    await browser.expect('#status').toHaveText('by-testid');
  });

  it('By.aria', async () => {
    await browser.click(By.aria('label', 'Aria Name'));
    await browser.expect('#status').toHaveText('by-role');
  });

  it('By.title', async () => {
    await browser.click(By.title('Hint title'));
    await browser.expect('#status').toHaveText('by-title');
  });

  it('By.altText', async () => {
    await browser.click(By.altText('Logo ALT'));
    await browser.expect('#status').toHaveText('by-alt');
  });

  it('By.linkText matches an <a> by exact rendered text', async () => {
    expect(await browser.find(By.linkText('Documentation')).getAttribute('id')).toBe('link-exact');
  });

  it('By.partialLinkText matches an <a> by substring', async () => {
    expect(await browser.find(By.partialLinkText('Read the Guide')).getAttribute('id')).toBe(
      'link-partial'
    );
  });

  it('By.placeholder', async () => {
    await browser.click(By.placeholder('Enter email'));
    await browser.expect('#status').toHaveText('email');
  });

  it('By.labelText (for attribute)', async () => {
    await browser.click(By.labelText('Email Address'));
    await browser.expect('#status').toHaveText('email');
  });

  it('By.labelText (wrapped input)', async () => {
    await browser.click(By.labelText('Wrapped Label'));
    await browser.expect('#status').toHaveText('wrapped');
  });

  it('By.text exact (trim + case-sensitive)', async () => {
    await browser.click(By.text('Exact Match'));
    await browser.expect('#status').toHaveText('text-exact');
  });

  it('By.partialText contains', async () => {
    await browser.click(By.partialText('Substring'));
    await browser.expect('#status').toHaveText('text-partial');
  });

  it('By.text with extra spaces (trimmed)', async () => {
    await browser.click(By.text('Spaced Text'));
    await browser.expect('#status').toHaveText('text-mixed');
  });

  describe('getBy* helpers', () => {
    it('getByLabel() finds input by label text', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
      await browser.getByLabel('Username').fill('labeluser');
      await browser.getByLabel('Password').fill('secret');
      await browser.click('#submit');
      await browser.expect('#result').toContainText('Welcome back, labeluser!');
    });

    it('getByText() finds element by text content', async () => {
      await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
      const tagName = await browser.getByText('Login').tagName();
      expect(tagName).toBe('h1');
    });

    it('getByAltText() finds an <img> by its alt attribute', async () => {
      await browser.getByAltText('Logo ALT').click();
      await browser.expect('#status').toHaveText('by-alt');
    });

    it('getByTitle() finds an element by its title attribute', async () => {
      await browser.getByTitle('Hint title').click();
      await browser.expect('#status').toHaveText('by-title');
    });
  });
});
