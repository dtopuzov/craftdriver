/**
 * Files moving between the page and the local disk: uploads via
 * setInputFiles() and downloads via waitForDownload()/Download.saveAs().
 * Each direction keeps its own browser because the download side needs a
 * `downloadsDir` configured at launch that the upload side does not.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
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
    await expect(browser.find('#text-input').setInputFiles(FIXTURE)).rejects.toThrow(
      'setInputFiles() requires an <input type="file"> element'
    );
  });
});

describe('File download — waitForDownload()', () => {
  let browser: Browser;
  let downloadsDir: string;

  beforeAll(async () => {
    downloadsDir = path.join(os.tmpdir(), `craftdriver-dl-test-${Date.now()}`);
    browser = await Browser.launch({
      browserName: BROWSER_NAME,
      downloadsDir,
    });
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/download.html`);
  });

  afterAll(async () => {
    await browser.quit();
    fs.rmSync(downloadsDir, { recursive: true, force: true });
  });

  it('resolves with a Download whose path exists on disk', async () => {
    const dl = await browser.waitForDownload(() => browser.click('#download-btn'));

    expect(dl.suggestedFilename).toBe('report.txt');
    expect(fs.existsSync(dl.path)).toBe(true);
  });

  it('saveAs() copies the file to the given target', async () => {
    const target = path.join(os.tmpdir(), `craftdriver-copy-${Date.now()}.txt`);

    const dl = await browser.waitForDownload(() => browser.click('#download-btn'), {
      timeout: 15000,
    });

    try {
      await dl.saveAs(target);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toContain('craftdriver download test');
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it('timeout rejects with a clear message', async () => {
    // Navigate to a page with no download button so nothing fires
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/upload.html`);
    await expect(
      browser.waitForDownload(() => Promise.resolve(), { timeout: 500 })
    ).rejects.toThrow('waitForDownload() timed out after 500ms');
  });
});
