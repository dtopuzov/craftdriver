# Test An Electron App From Another Repo

Use this when your Electron application is built in one repository, but your
CraftDriver tests live in another repository or package. The important part is
that the test launches the **packaged executable** produced by the app repo.

This recipe assumes a sibling checkout:

```text
~/git/
  my-electron-app/
  my-electron-tests/
```

## Build the app first

From the app repo, produce the packaged app the same way CI or release builds do:

```bash
cd ~/git/my-electron-app
npm ci
npm run build
npm run package
```

The exact command depends on your app. The output is usually under `dist/`,
`out/`, or `release/`. Point CraftDriver at the executable inside that output,
not at the source directory.

## Keep the app path in one helper

In the test repo, create a small fixture helper so every test uses the same
path and Electron version:

```ts
// tests/fixtures/electron-app.ts
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from 'craftdriver';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..', '..', '..');
const appRepo = path.join(workspace, 'my-electron-app');

export function appBinaryPath(): string {
  const override = process.env.MY_APP_BINARY;
  if (override) return override;

  switch (`${process.platform}-${process.arch}`) {
    case 'darwin-arm64':
    case 'darwin-x64':
      return path.join(appRepo, 'dist/mac/MyApp.app/Contents/MacOS/MyApp');
    case 'win32-x64':
      return path.join(appRepo, 'dist/win-unpacked/MyApp.exe');
    case 'linux-x64':
      return path.join(appRepo, 'dist/linux-unpacked/my-app');
    default:
      throw new Error(`Unsupported Electron test platform: ${os.platform()}-${os.arch()}`);
  }
}

export function launchApp(): Promise<Browser> {
  return Browser.launch({
    electron: {
      appBinaryPath: appBinaryPath(),
      version: process.env.MY_APP_ELECTRON_VERSION ?? '43.1.0',
      args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    },
  });
}
```

Use `MY_APP_BINARY` when CI downloads a prebuilt app artifact instead of building
from a sibling checkout.

## Write the test like a normal renderer test

Electron defaults to Classic WebDriver, so the app loads itself. Do not call
`navigateTo()` unless you explicitly opted into BiDi and know the renderer URL.

```ts
// tests/settings.test.ts
import { afterEach, describe, it } from 'vitest';
import { Browser, By } from 'craftdriver';
import { launchApp } from './fixtures/electron-app';

describe('settings window', () => {
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.quit();
  });

  it('saves the profile name', async () => {
    browser = await launchApp();

    const main = await browser.waitForPage({ title: /My App/ });
    await main.find(By.testId('app-title')).expect().toHaveText('My App');

    await main.click(By.testId('nav-settings'));
    await main.fill(By.testId('profile-name'), 'Ada Lovelace');
    await main.click(By.testId('save-settings'));

    await main.find(By.testId('settings-status')).expect().toHaveText('Saved');
  });
});
```

Prefer stable `data-testid` attributes in the Electron renderer. You can inspect
or debug the app with DevTools while designing selectors, but the test should
interact with the packaged UI the way a user would.

## CI shape

A common CI flow is:

1. Check out or download the Electron app.
2. Build/package the app, or download a packaged artifact.
3. Set `MY_APP_BINARY` and `MY_APP_ELECTRON_VERSION`.
4. Run the CraftDriver tests.

On Linux, run the tests under Xvfb:

```bash
xvfb-run -a npm test
```

On macOS and Windows hosted runners, a display is already available. Do not pass
headless flags to Electron; it is a desktop GUI app.

## Learn More

- [Testing Electron Apps](../electron.md)
- [Browser API](../browser-api.md)
- [Vitest Hooks](./vitest-browser-lifecycle.md)
