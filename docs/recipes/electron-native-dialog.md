# Mock A Native Electron File Dialog

Use this pattern when a renderer action opens Electron's operating-system file
picker. The real app remains structured normally: a sandboxed renderer calls a
narrow preload API, the preload sends IPC, and the main process opens the native
dialog. The test replaces only the final `dialog.showOpenDialog()` call.

## Application code

Register the dialog in the main process:

```js
const { BrowserWindow, dialog, ipcMain } = require('electron');

ipcMain.handle('native-dialog:open-file', (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: 'Choose a text file',
    properties: ['openFile'],
    filters: [{ name: 'Text files', extensions: ['txt', 'md'] }],
  };

  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
});
```

Expose only the operation the renderer needs:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('craftdriverExample', {
  openFile: () => ipcRenderer.invoke('native-dialog:open-file'),
});
```

The renderer can use the returned value like the real Electron result:

```js
document.querySelector('[data-testid="open-native-file-btn"]').addEventListener('click', async () => {
  const result = await window.craftdriverExample.openFile();
  document.querySelector('[data-testid="native-dialog-result"]').textContent = result.canceled
    ? 'cancelled'
    : result.filePaths.join(', ');
});
```

## Test code

Opt in to main-process access and install the mock before clicking:

```ts
import { Browser, By } from 'craftdriver';
import { expect, test } from 'vitest';

test('selects an invoice without opening an OS dialog', async () => {
  const browser = await Browser.launch({
    electron: {
      appBinaryPath: process.env.APP_PATH!,
      version: process.env.ELECTRON_VERSION!,
      mainProcess: true,
    },
  });

  try {
    const dialog = await browser.electron.mockDialog('showOpenDialog', {
      canceled: false,
      filePaths: ['/fixtures/invoice.txt'],
    });

    await browser.click(By.testId('open-native-file-btn'));
    await browser
      .find(By.testId('native-dialog-result'))
      .expect()
      .toHaveText('/fixtures/invoice.txt');

    // The click reached the main process: the mock recorded the exact options the
    // ipcMain handler passed to dialog.showOpenDialog — no OS dialog ever opened.
    expect(await dialog.getCalls()).toEqual([
      {
        options: {
          title: 'Choose a text file',
          properties: ['openFile'],
          filters: [{ name: 'Text files', extensions: ['txt', 'md'] }],
        },
      },
    ]);
  } finally {
    await browser.quit();
  }
});
```

The reference example implements this exact flow in
[`craftdriver-examples`](https://github.com/dtopuzov/craftdriver-examples/tree/main/electron).

## Production and hardened builds

No application test hook is required. This works against an unchanged packaged
production artifact when its `EnableNodeCliInspectArguments` Electron fuse is
enabled. The fuse is enabled by default, but security-hardened builds may disable
it. A disabled fuse cannot be changed after the app is signed; package a separate
test artifact with that fuse enabled. See
[Testing Electron Apps](../electron.md#can-this-test-a-production-build) for the
Forge configuration and security boundary.
