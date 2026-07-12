# Mock Electron APIs (shell, clipboard, app…)

Native dialogs have a typed helper (`mockDialog()`), but plenty of Electron
behavior you want to keep out of a test run doesn't: opening the user's browser
(`shell.openExternal`), writing the system clipboard (`clipboard.writeText`),
resolving OS paths (`app.getPath`), and so on. `browser.electron.mock()` replaces
any `electron.<api>.<fn>` main-process method with a scripted return and a call
recorder, so you can drive the real UI and assert what it asked the OS to do —
without the OS actually doing it.

Needs main-process access (`electron: { mainProcess: true }`), like `executeMain`
and `mockDialog`.

## Stop a "share" button from launching a browser

Application code — a normal renderer → preload → IPC → `shell.openExternal` flow:

```js
// main.js
const { ipcMain, shell } = require('electron');
ipcMain.handle('share:open', (_event, url) => shell.openExternal(url));
```

```js
// preload.js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('share', { open: (url) => ipcRenderer.invoke('share:open', url) });
```

Test — mock the final `shell.openExternal`, click, and assert the URL it received:

```ts
import { Browser, By } from 'craftdriver';
import { expect, test } from 'vitest';

test('share button opens the right URL without launching a browser', async () => {
  const browser = await Browser.launch({
    electron: { appBinaryPath: process.env.APP_PATH!, mainProcess: true },
  });

  try {
    // shell.openExternal resolves to true on success — script that.
    const openExternal = await browser.electron.mock('shell', 'openExternal', true);

    await browser.click(By.testId('share-btn'));

    expect(await openExternal.getCalls()).toEqual([{ args: ['https://example.com/report/42'] }]);
    await openExternal.restore();
  } finally {
    await browser.quit();
  }
});
```

Each recorded call is `{ args: [...] }` with the (JSON-safe) arguments the app
passed. The rest of the handle mirrors `mockDialog`: `getCallCount()`,
`clearCalls()`, `mockReturnValue(value)` to re-script mid-test, and `restore()`
(also restored on `browser.quit()`).

## Assert what the app copied to the clipboard

```ts
const writeText = await browser.electron.mock('clipboard', 'writeText');

await browser.click(By.testId('copy-link-btn'));

expect(await writeText.getCalls()).toEqual([{ args: ['https://example.com/report/42'] }]);
await writeText.restore();
```

Here no return value is scripted — `clipboard.writeText` returns nothing, so the
mock returns `undefined` and you assert purely on the recorded arguments.

## Notes

- The scripted value is returned **as-is** (not wrapped in a Promise), so it works
  for synchronous methods (`app.getName()`, `app.getPath()`) and `await`ed
  asynchronous ones (`shell.openExternal`). Pass the already-resolved value for an
  async method.
- Arguments and the return value must be JSON-serializable; a non-serializable
  argument (a `BrowserWindow`, a `Buffer`) is recorded as a descriptive placeholder
  rather than crossing the process boundary.
- `mock()` targets **object-namespace** methods (`shell`, `clipboard`, `app`,
  `dialog`, …). Class-based APIs such as `Notification` or `Menu` are not covered by
  it today — mock the app code that *constructs* them instead, or drive them through
  your own IPC surface.
- Reach for the typed [`mockDialog()`](../electron.md#mock-native-dialogs) for file,
  save, and message dialogs; it validates the result shape for you.
