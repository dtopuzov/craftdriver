import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

const FIXTURE = path.resolve(fileURLToPath(import.meta.url), '../../tests/fixtures/sample.txt');

describe('File upload — setInputFiles()', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/upload.html`);
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('sets a single file and fires the change event', async () => {
    await browser.find('#file-input').setInputFiles(FIXTURE);
    const result = await browser.find('#result').text();
    expect(result).toBe('sample.txt');
  });

  it('throws a clear error on a non-file input', async () => {
    await expect(
      browser.find('#text-input').setInputFiles(FIXTURE)
    ).rejects.toThrow('setInputFiles() requires an <input type="file"> element');
  });
});
