import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { Browser, By } from '../src';
import { EXAMPLES_BASE_URL } from './utils';

describe('By locator strategies (selectors.html)', () => {
  let browser: Browser;
  const base = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: 'chrome' });
  });
  afterAll(async () => {
    await browser.quit();
  });
  beforeEach(async () => {
    await browser.navigateTo(`${base}/selectors.html`);
  });

  it('By.id', async () => {
    await browser.click(By.id('by-id'));
    await browser.expect('#status').toHaveText('by-id');
  });

  it('By.nameAttr', async () => {
    await browser.click(By.nameAttr('by-name'));
    await browser.expect('#status').toHaveText('by-name');
  });

  it('By.className', async () => {
    await browser.click(By.className('foo'));
    await browser.expect('#status').toHaveText('by-class');
  });

  it('By.tag', async () => {
    await browser.click(By.tag('img'));
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
});
