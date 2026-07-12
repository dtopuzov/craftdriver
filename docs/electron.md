# Testing Electron Apps

CraftDriver can launch a packaged Electron app and test its **renderer** with
the same `Browser` API used for web pages: locators, clicks, form fills,
assertions, viewport screenshots, element screenshots, `evaluate()`, and
page/window helpers.

For apps you control, CraftDriver can also access the main process and replace
native open, save, and message dialogs with deterministic test results.

## Quick Start

Launch the packaged executable and pass the Electron version used by the app:

```ts
import { Browser, By } from 'craftdriver';

const browser = await Browser.launch({
  electron: {
    appBinaryPath: '/path/to/YourApp',
    version: '43.1.0',
  },
});

try {
  await browser.find(By.testId('app-title')).expect().toHaveText('Your App');
  await browser.click(By.testId('nav-settings'));
  await browser.fill(By.testId('name'), 'Ada');
  await browser.click(By.testId('save'));
  await browser.find(By.testId('status')).expect().toHaveText('Saved');
} finally {
  await browser.quit();
}
```

Electron launches default to Classic WebDriver. The app loads its own UI, so you
usually do **not** call `navigateTo()`.

For a fuller project layout, see
[Test An Electron App From Another Repo](./recipes/electron-app-from-another-repo.md).

## Mock Native Dialogs

Native operating-system dialogs are outside the DOM, so WebDriver cannot click
their buttons or select their files. Mock the Electron main-process method before
the renderer action that opens it:

```ts
const browser = await Browser.launch({
  electron: {
    appBinaryPath: '/path/to/YourApp',
    version: '43.1.0',
    mainProcess: true,
  },
});

const openDialog = await browser.electron.mockDialog('showOpenDialog', {
  canceled: false,
  filePaths: ['/fixtures/invoice.pdf'],
});

await browser.click(By.testId('choose-file'));
await browser.find(By.testId('selected-file')).expect().toHaveText('/fixtures/invoice.pdf');

expect(await openDialog.getCallCount()).toBe(1);
expect(await openDialog.getCalls()).toEqual([
  {
    options: {
      title: 'Choose an invoice',
      properties: ['openFile'],
    },
  },
]);

await openDialog.restore();
```

`mockDialog()` supports Electron's asynchronous `showOpenDialog`,
`showSaveDialog`, and `showMessageBox` methods. The supplied result has the same
shape as the real Electron result:

```ts
await browser.electron.mockDialog('showSaveDialog', {
  canceled: false,
  filePath: '/fixtures/export.csv',
});

await browser.electron.mockDialog('showMessageBox', {
  response: 1,
  checkboxChecked: false,
});
```

The returned mock provides `getCalls()`, `getCallCount()`, `clearCalls()`, and
`restore()`. CraftDriver also restores active dialog mocks during
`browser.quit()`. Call records contain the dialog options; Electron's optional
parent `BrowserWindow` is intentionally excluded because it cannot cross the
test-process boundary.

See [Mock A Native Electron File Dialog](./recipes/electron-native-dialog.md)
for the complete renderer, preload, main-process, and test flow.

## Mock Any Electron API

`mockDialog()` is a typed convenience over a general primitive: `mock()` replaces
**any** `electron.<api>.<fn>` main-process method with a scripted return value and
a call recorder. Reach for it when your app calls into Electron beyond dialogs —
`shell.openExternal`, `app.getPath`, `safeStorage.encryptString`, `clipboard.*`,
and so on.

```ts
// Stop a "Open in browser" button from actually launching a browser, and assert
// the app asked to open the right URL — without leaving the test machine.
const openExternal = await browser.electron.mock('shell', 'openExternal', true);

await browser.click(By.testId('open-docs'));

expect(await openExternal.getCalls()).toEqual([{ args: ['https://example.com/docs'] }]);
await openExternal.restore();
```

The returned mock mirrors the dialog mock: `getCalls()` (each call is
`{ args: [...] }`), `getCallCount()`, `clearCalls()`, `mockReturnValue(value)` to
re-script the return, and `restore()`. Active mocks are also restored on
`browser.quit()`.

Notes:

- The scripted value is returned **as-is**, not wrapped in a Promise, so it works
  for both synchronous methods (`app.getName()`) and `await`ed asynchronous ones
  (`safeStorage`-style APIs). For an async method, pass the already-resolved value.
- Recorded call arguments and the return value must be JSON-serializable; complex
  values (a `BrowserWindow`, a `Buffer`) are recorded as a descriptive placeholder
  rather than crossing the process boundary.
- Mocking the same `api.fn` twice throws until you `restore()` the first mock.

See [Mock Electron APIs](./recipes/electron-mock-apis.md) for `shell.openExternal`
and `clipboard.writeText` flows end to end.

## Test Deep Links (Custom Protocols)

If your app registers a custom URL scheme (`myapp://…`), `triggerDeeplink()` opens
one against the **running** app exactly as the OS would when a browser, email, or
another app hands off the link — so your real `open-url` / `second-instance`
handler runs. It is fire-and-forget: it resolves once the OS launcher is spawned,
so assert the effect through your app afterwards.

```ts
await browser.electron.triggerDeeplink('myapp://open?file=test.txt');

// Assert however your app surfaces the link — a renderer element, a main-process
// log, or state read back with executeMain.
await browser.find(By.testId('deeplink-result')).expect().toHaveText('myapp://open?file=test.txt');
```

Your **app** must:

- register the protocol — `app.setAsDefaultProtocolClient('myapp')` plus the
  packager's protocol declaration (electron-builder `protocols:` / Forge
  `protocols`), which writes the macOS `CFBundleURLTypes` and Windows registry
  entries; and
- hold the single-instance lock (`app.requestSingleInstanceLock()`) and read the
  URL from `open-url` (macOS) and `second-instance` argv (Windows, Linux).

Platform notes:

- **macOS** delivers the URL to the running instance via `open-url`; no extra
  routing is needed. The bundle must be known to LaunchServices (installed, or
  registered with `lsregister`).
- **Windows / Linux** would launch a *second* process; craftdriver appends the
  running app's user-data dir as a `userData` query parameter (auto-detected via
  the main process) so the single-instance lock routes the link to the test
  instance. Windows also needs `appBinaryPath` set on launch.
- Only custom protocols are accepted; `http`/`https`/`file` throw `INVALID_ARGUMENT`.

See [Test An Electron Deep Link](./recipes/electron-deep-link.md) for the complete
app + test flow.

### Can this test a production build?

Yes, when that packaged build accepts Electron's `--inspect` argument. Electron
controls this with the `EnableNodeCliInspectArguments` fuse, which is enabled by
default. CraftDriver launches the existing executable with a local,
session-scoped inspector and replaces the dialog function in memory. It does not
patch the executable or require a test hook in your application code. Code
signing by itself does not prevent this.

Security-hardened applications often disable this fuse. CraftDriver cannot turn
it back on after packaging or signing, and renderer-only automation will continue
to work but `mock()`, `mockDialog()`, and `executeMain()` will not. When that
happens CraftDriver reads the fuse straight from the packaged binary and the error
says so precisely — `ELECTRON_MAIN_UNAVAILABLE` with `detail.fuseStatus:
'disabled'` and the fix below — instead of a generic "inspector unreachable".
Build a separate test artifact with the fuse enabled **before code signing**:

```js
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  // ...your normal Forge configuration
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.EnableNodeCliInspectArguments]: true,
    }),
  ],
};
```

For another packager, use `@electron/fuses` in its pre-sign packaging hook and
set `FuseV1Options.EnableNodeCliInspectArguments` to `true`. Keep the production
artifact hardened if that is your security policy; the test artifact should be
stored and distributed like other internal test tooling.

This is build instrumentation, not application instrumentation. Your app should
continue to use Electron normally, for example `dialog.showOpenDialog(...)` in an
IPC handler. One limitation is that CraftDriver replaces the method on
`electron.dialog`; if your app copies that function into another variable before
the test installs the mock, the copied reference cannot be replaced. Prefer
calling `dialog.showOpenDialog(...)` at the point of use.

## Package The App First

`appBinaryPath` must point to the packaged app executable. Do not point it at an
Electron source directory, a `.app` bundle root, a `.dmg`, or an installer.

Typical executable paths:

| OS      | `appBinaryPath`                                 |
| ------- | ----------------------------------------------- |
| macOS   | `YourApp.app/Contents/MacOS/YourApp`            |
| Windows | `YourApp.exe`                                   |
| Linux   | the unpacked binary, e.g. `yourapp` (lowercase) |

If you point chromedriver at an unpackaged app directory, Electron can start as
a plain Chromium window and your app UI will not load. Package with your normal
Electron Forge, electron-builder, or release-build command first.

## Match The Driver To Electron

Electron bundles its own Chromium. The chromedriver used for the test must match
that bundled Chromium major, not the Chrome installed on the machine.

The recommended setup is:

```ts
await Browser.launch({
  electron: {
    appBinaryPath: '/path/to/YourApp',
    version: '43.1.0',
  },
});
```

With `version`, CraftDriver maps the Electron version to the bundled Chromium
major and downloads a matching Chrome-for-Testing chromedriver.

Other valid driver sources:

- `electron.chromedriverPath` when you already have a matching chromedriver.
- `CRAFTDRIVER_ELECTRON_CHROMEDRIVER_PATH` for a CI-wide override.
- `electron-chromedriver` installed in the test project.
- macOS packaged app detection. If you omit `version`, CraftDriver can read the
  Electron version from a packaged `.app` and resolve the driver from that.

For Linux and Windows packaged apps, pass `version` or an explicit driver path.
CraftDriver does not use a system Chrome driver for Electron, because it would
often be the wrong Chromium version.

Version-based driver resolution works for Electron majors known to CraftDriver
and Chromium majors published by Chrome for Testing. If your app uses an older,
newer, or custom Electron/Chromium build, use `chromedriverPath`.

## Windows And Splash Screens

Many desktop apps open a splash window first, then replace it with the main
window. Wait for the real window by title or URL:

```ts
const browser = await Browser.launch({
  electron: { appBinaryPath: '/path/to/YourApp', version: '43.1.0' },
});

const main = await browser.waitForPage({ title: /Your App/ });
await main.find(By.testId('app-root')).expect().toBeVisible();
```

The returned `Page` is bound to that window. In Electron's default Classic mode,
`waitForPage({ title | url })` also makes the matched window current, so
top-level calls such as `browser.find(...)` and `browser.click(...)` target it.

Use `browser.pages()` to list open top-level windows. If the current splash
window closes and exactly one window remains, `browser.activePage()` recovers to
that remaining window. If several windows remain, select one explicitly with
`waitForPage()` or `pages()`.

## Electron API Differences

Most renderer-facing APIs work the same way they do for browser tests. The main
differences are launch shape and protocol defaults.

Use these Electron-specific launch options:

```ts
await Browser.launch({
  electron: {
    appBinaryPath: '/path/to/YourApp',
    version: '43.1.0',
    args: ['--lang=de-DE'],
  },
});
```

Do not combine `electron` with browser-only launch options:

| Browser option                     | Electron alternative                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `browserName`                      | Omit it; Electron uses its bundled Chromium.                                                       |
| `browserPath`                      | Use `electron.appBinaryPath`.                                                                      |
| top-level `args`                   | Use `electron.args`.                                                                               |
| `chromeService` / `firefoxService` | Use `electronService` only when custom driver service settings are needed.                         |
| `mobileEmulation`                  | Not applicable to desktop Electron apps; use `setViewportSize()` for responsive renderer coverage. |

Electron is also always a GUI app in this V1 flow. CraftDriver does not add
headless flags for Electron, even if `HEADLESS=true`.

## BiDi-Only Features

Electron defaults to Classic WebDriver because that keeps the packaged app's
initial UI loaded and ready to test.

Some CraftDriver APIs require BiDi. For Electron, you must launch with
`enableBiDi: true` before using them:

- `browser.logs`
- `browser.network`, `waitForRequest()`, and `waitForResponse()`
- `browser.startTrace()`
- `browser.openPage()`
- `browser.newContext()`, `browser.contexts()`, and `browser.defaultContext`
- `browser.addInitScript()`
- `browser.grantPermissions()`, `setGeolocation()`, and `emulate()`
- `browser.screenshot({ fullPage: true })`

BiDi has an Electron-specific caveat: chromedriver resets the initial renderer
to `about:blank` during BiDi negotiation. Only opt in when you need one of the
features above and can navigate to a known renderer URL:

```ts
const browser = await Browser.launch({
  electron: { appBinaryPath: '/path/to/YourApp', version: '43.1.0' },
  enableBiDi: true,
});

await browser.navigateTo('file:///path/inside/app/index.html');
```

Viewport and element screenshots do not require BiDi.

## CI Notes

Electron needs a display:

- On Linux CI, run under a virtual display such as `xvfb-run`.
- On macOS and Windows hosted runners, a display is usually already available.
- Do not pass headless flags to Electron.
- For disposable Linux CI fixtures, use `electron.args: ['--no-sandbox']` if the
  unpacked app cannot start its sandbox.

```ts
await Browser.launch({
  electron: {
    appBinaryPath,
    version: '43.1.0',
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  },
});
```

Prefer an exact Electron version in CI so driver resolution is repeatable.

## Compatibility

The automated Electron suite currently covers Electron **43.1.0** (Chromium 150) on Linux x64 and Windows x64. A real macOS production app, Fiddler
Everywhere 7.8.0 (Electron 39.8.6 / Chromium 142), has also been driven
manually.

Other Electron versions are best-effort until they are added to the tested
matrix.

## Troubleshooting

Set `CRAFTDRIVER_DEBUG=1` to print the selected app path, protocol, platform,
Electron version when known, chromedriver path, driver source, and detected
driver version. Arguments and environment values are not printed.

Common failures:

- **The app opens as a blank/plain Chromium window** — package the app and point
  `appBinaryPath` at the packaged executable, not the source directory.
- **Session creation fails with a driver mismatch** — pass the app's Electron
  version or an explicit matching chromedriver.
- **The driver is for the wrong CPU architecture** — use a chromedriver for the
  host architecture.
- **Linux CI exits during launch** — run under `xvfb-run`; for disposable
  unpacked fixtures, try `electron.args: ['--no-sandbox']`.
- **macOS blocks launch** — confirm the app executable can run on that machine.
  If you provide a custom `chromedriverPath`, confirm that binary can run too.
  Using `electron.version` lets CraftDriver resolve the Chrome-for-Testing driver
  instead of relying on a local driver file.
- **Manual launch opens Node.js instead of your app** — if
  `ELECTRON_RUN_AS_NODE=1` is set in your shell, an Electron executable runs like
  Node.js and does not open the desktop app window. CraftDriver removes that
  variable when it launches your app. If you run the app yourself from a
  terminal, unset it first:

  ```bash
  env -u ELECTRON_RUN_AS_NODE /path/to/YourApp
  ```
