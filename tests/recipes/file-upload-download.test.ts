// Runnable proof for docs/recipes/file-upload-download.md
// The MD snippet is this test's body (real deployed URLs instead of local ones).
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

const fixture = path.resolve(fileURLToPath(import.meta.url), '../../fixtures/sample.txt');

describe('upload a file and download a generated one', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;
  const downloadsDir = path.join(os.tmpdir(), `craftdriver-dl-${Date.now()}`);

  beforeAll(async () => {
    mkdirSync(downloadsDir, { recursive: true });
    browser = await Browser.launch({ browserName: BROWSER_NAME, downloadsDir });
  });

  afterAll(async () => {
    await browser.quit();
    rmSync(downloadsDir, { recursive: true, force: true });
  });

  it('uploads an attachment and saves a downloaded report', async () => {
    await browser.navigateTo(`${baseUrl}/upload.html`);
    await browser.find('#file-input').setInputFiles(fixture);
    await browser.expect('#result').toHaveText('sample.txt');

    await browser.navigateTo(`${baseUrl}/download.html`);
    const download = await browser.waitForDownload(() => browser.click('#download-btn'));

    const target = path.join(downloadsDir, download.suggestedFilename);
    await download.saveAs(target);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('craftdriver download test');
  });
});
