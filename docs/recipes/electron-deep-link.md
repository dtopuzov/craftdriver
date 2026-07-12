# Test An Electron Deep Link

Use this pattern when your app registers a custom URL scheme (`myapp://…`) and you
want to verify it handles a link the OS delivers from outside the app. CraftDriver
opens the link through the real OS launcher, so your production `open-url` /
`second-instance` handler runs unchanged.

## Application code

Register the protocol and route incoming links to the window. This is normal
production code, not test instrumentation:

```js
const { app, BrowserWindow } = require('electron');

const SCHEME = 'myapp';
let mainWindow = null;
let lastDeeplink = null;

app.setAsDefaultProtocolClient(SCHEME);

function handleDeeplink(url) {
  if (!url) return;
  lastDeeplink = url;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('deeplink', url);
}

// macOS: the running instance receives the URL here.
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeeplink(url);
});

// Windows/Linux: a deep link launches a second process. Hold the single-instance
// lock so its argv is routed back into the running instance instead of opening a
// duplicate window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    handleDeeplink(argv.find((a) => a.startsWith(`${SCHEME}://`)));
  });
}
```

Declare the scheme so the packaged app is registered with the OS. With
electron-builder:

```yaml
# electron-builder.yml
protocols:
  - name: My App Protocol
    schemes:
      - myapp
```

Forward the link to the renderer through a narrow preload API:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myapp', {
  onDeeplink: (cb) => ipcRenderer.on('deeplink', (_event, url) => cb(url)),
});
```

```js
// renderer
window.myapp?.onDeeplink((url) => {
  document.querySelector('[data-testid="deeplink-result"]').textContent = url;
});
```

## Test code

```ts
import { Browser, By } from 'craftdriver';
import { expect, test } from 'vitest';

test('handles an incoming deep link', async () => {
  const browser = await Browser.launch({
    electron: {
      appBinaryPath: process.env.APP_PATH!, // required on Windows to route the link
      version: process.env.ELECTRON_VERSION!,
      mainProcess: true, // lets craftdriver auto-detect the user-data dir (Windows/Linux)
    },
  });

  try {
    const url = 'myapp://open?file=test.txt';
    await browser.electron.triggerDeeplink(url);

    // triggerDeeplink is fire-and-forget: assert the effect through the app.
    await browser.find(By.testId('deeplink-result')).expect().toHaveText(url);

    // Only custom protocols are valid targets.
    await expect(browser.electron.triggerDeeplink('https://example.com')).rejects.toThrow();
  } finally {
    await browser.quit();
  }
});
```

The reference example implements this exact flow (scheme `craftdriver-example://`)
in [`craftdriver-examples`](https://github.com/dtopuzov/craftdriver-examples/tree/main/electron).

## Notes

- **macOS** needs the app bundle known to LaunchServices — installed in
  `/Applications`, or registered once with `lsregister -f MyApp.app`.
- **Windows / Linux** launch a second process for the link; craftdriver appends the
  running app's user-data dir as a `userData` query parameter so the single-instance
  lock hands the link to the test instance. Your app should honor that parameter
  when it sets its user-data path if you run isolated instances.
- Like `mockDialog()` and `executeMain()`, deep-link routing that inspects the app
  via the main process needs the `EnableNodeCliInspectArguments` fuse enabled; the
  OS launch itself does not.
