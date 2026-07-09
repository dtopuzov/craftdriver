# Test File Uploads And Downloads

Import, attachment, and export flows are easy to break and awkward to test by
hand. CraftDriver sets files on a real `<input type="file">` and captures
downloads to a directory you choose, so you can assert on the bytes that land on
disk. This recipe uploads a fixture to the live
[upload example](https://dtopuzov.github.io/craftdriver/examples/upload.html),
then downloads a report from the
[download example](https://dtopuzov.github.io/craftdriver/examples/download.html).
It sets `downloadsDir` at launch, so it shows the `launch` call.

```ts
const browser = await Browser.launch({
  browserName: 'chrome',
  downloadsDir: '.tmp/downloads',
});

await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/upload.html');
await browser.find('#file-input').setInputFiles('tests/fixtures/sample.txt');
await browser.expect('#result').toHaveText('sample.txt');

await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/download.html');
const download = await browser.waitForDownload(() => browser.click('#download-btn'));

const target = `.tmp/downloads/${download.suggestedFilename}`;
await download.saveAs(target);

expect(existsSync(target)).toBe(true);
expect(readFileSync(target, 'utf8')).toContain('craftdriver download test');
```

## Notes

- Configure `downloadsDir` at launch so files land somewhere predictable.
- Wrap the click that triggers the download in `waitForDownload()` so the wait is armed first.
- Call `setInputFiles()` on the actual `<input type="file">` element, not a styled wrapper.

## Learn More

- [Element API](../element-api.md)
- [Browser API](../browser-api.md)
