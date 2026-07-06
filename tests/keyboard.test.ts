import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { Browser, Key } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Keyboard interactions on keyboard.html', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/keyboard.html`);
  });

  it('types into editor and mirrors content with line count', async () => {
    await browser.click('#editor');
    await browser.keyboard.type('hello');
    await browser.keyboard.press(Key.Enter);
    await browser.keyboard.type('world');
    await browser.expect('#mirror').toHaveText('hello\nworld');
    await browser.expect('#lineCount').toHaveText('2');
  });

  it('backspace deletes last character', async () => {
    await browser.click('#editor');
    await browser.keyboard.type('abc');
    await browser.keyboard.press(Key.Backspace);
    await browser.expect('#mirror').toHaveText('ab');
  });

  it('chord selects all then backspace clears', async () => {
    await browser.click('#editor');
    await browser.keyboard.type('keep me');
    // Use Command+A on macOS, Ctrl+A on Windows/Linux
    const selectAllModifier = process.platform === 'darwin' ? Key.Meta : Key.Control;
    await browser.keyboard.chord(selectAllModifier, 'a');
    await browser.keyboard.press(Key.Backspace);
    await browser.expect('#mirror').toHaveText('');
    await browser.expect('#lineCount').toHaveText('0');
  });

  it('enter key in input sets submitted result', async () => {
    await browser.click('#enterTarget');
    await browser.keyboard.type('value');
    await browser.keyboard.press(Key.Enter);
    await browser.expect('#enterResult').toHaveText('submitted');
  });

  it('ElementHandle.press() uses the click fast path before pressing the key', async () => {
    const driver = (browser as any).driver;
    const originalWait = driver.wait.bind(driver);
    let waitCalls = 0;
    driver.wait = (...args: any[]) => {
      waitCalls += 1;
      return originalWait(...args);
    };

    try {
      await browser.find('#enterTarget').press(Key.Enter);
    } finally {
      driver.wait = originalWait;
    }

    expect(waitCalls).toBe(0);
    await browser.expect('#enterResult').toHaveText('submitted');
  });

  it('modifier keys update status (Shift/Ctrl/Alt)', async () => {
    await browser.click('#editor');
    await browser.keyboard.down(Key.Shift);
    await browser.expect('#modifiers').toHaveText('Shift');
    await browser.keyboard.up(Key.Shift);
    await browser.keyboard.down(Key.Control);
    await browser.expect('#modifiers').toHaveText('Control');
    await browser.keyboard.up(Key.Control);
  });
});
