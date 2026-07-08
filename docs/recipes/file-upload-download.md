# Test File Uploads And Downloads

Use this pattern when a workflow imports data, uploads an attachment, exports a
report, or verifies a generated file.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Browser } from 'craftdriver';

describe('reports', () => {
  let browser: Browser;
  const downloadsDir = resolve('.tmp/downloads');
  const fixture = resolve('tests/fixtures/sample.txt');

  beforeAll(async () => {
    mkdirSync(downloadsDir, { recursive: true });
    browser = await Browser.launch({
      browserName: 'chrome',
      downloadsDir,
    });
  });

  afterAll(async () => {
    await browser.quit();
    rmSync(downloadsDir, { recursive: true, force: true });
  });

  it('uploads a source file and downloads a report', async () => {
    await browser.navigateTo('http://localhost:3000/reports');

    await browser.find('#source-file').setInputFiles(fixture);
    await browser.expect('#upload-status').toContainText('sample.txt');

    const download = await browser.waitForDownload(() => {
      return browser.getByRole('button', { name: 'Export report' }).click();
    });

    const target = join(downloadsDir, download.suggestedFilename);
    await download.saveAs(target);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('Report');
  });
});
```

## Notes

- Configure `downloadsDir` at launch so files land somewhere predictable.
- Wrap the click that triggers the download in `waitForDownload()`.
- Use `setInputFiles()` on the actual `<input type="file">` element.

## Learn More

- [Element API](../element-api.md)
- [Browser API](../browser-api.md)
