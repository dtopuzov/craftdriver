import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

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
