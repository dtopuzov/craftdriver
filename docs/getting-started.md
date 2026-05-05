# Getting Started

## Prerequisites

You need the appropriate WebDriver binary for your target browser.

**Chrome / Chromium:**
```bash
npm install --save-dev chromedriver
# or: brew install chromedriver / download from chromedriver.chromium.org
```

**Firefox (via geckodriver):**
```bash
npm install --save-dev geckodriver
# or: brew install geckodriver
# or: download from https://github.com/mozilla/geckodriver/releases
```

When installed as a dev-dependency craftdriver locates the binary automatically — no PATH setup needed.

## Installation

```bash
npm install craftdriver
```

## Your First Test

```typescript
import { Browser } from 'craftdriver';

async function main() {
  // Launch browser
  const browser = await Browser.launch({ browserName: 'chrome' });

  try {
    // Navigate to a page
    await browser.navigateTo('https://example.com');

    // Get page title
    const title = await browser.title();
    console.log('Page title:', title);

    // Click a link
    await browser.click('a');

    // Fill a form
    await browser.fill('#email', 'test@example.com');
    await browser.click('#submit');

    // Assert result
    await browser.expect('#message').toHaveText('Success!');
  } finally {
    await browser.quit();
  }
}

main();
```

## `browser.X()` vs `page.X()` — when to use which

`browser.click()`, `browser.find()`, `browser.fill()`, `browser.evaluate()`
and the other DOM-touching shortcuts on `Browser` are sugar for
`(await browser.activePage()).X(...)`. They always target the focused
page in `browser.defaultContext`. They never cross into a `Page` that
lives inside a context returned by `browser.newContext()`.

For single-tab tests this is exactly what you want — the shortcuts keep
your code short:

```typescript
await browser.navigateTo('https://example.com');
await browser.click('#submit');
```

For multi-tab or multi-user tests, get a `Page` explicitly:

```typescript
// Multi-tab
const page = await browser.openPage({ url: '/help', type: 'tab' });
await page.click('#close');           // unambiguous

// Multi-user (isolated profiles)
const alice = await browser.newContext();
const aPage = await alice.newPage({ url: '/login' });
await aPage.fill('#user', 'alice');   // browser.fill() would target the
                                      // default context, NOT alice.
```

If you need to be explicit even in single-tab code, `browser.activePage()`
returns the same `Page` the shortcuts would target.

## Launch Options

```typescript
// Chrome (default)
const browser = await Browser.launch({
  browserName: 'chrome', // 'chrome' | 'chromium' | 'firefox'
  storageState: './session.json', // optional: pre-load saved session state
});

// Firefox
const browser = await Browser.launch({
  browserName: 'firefox',
});
```

### Running tests on Firefox

Set `BROWSER_NAME=firefox` before running your test command:

```bash
BROWSER_NAME=firefox npx vitest run
# or use the built-in script if your package.json has it:
npm run test:firefox
```

### Custom WebDriver binary or port

`Browser.launch()` resolves the driver binary automatically. To pin a
specific binary, change the host/port, or pass extra command-line
arguments to the driver, construct a `ChromeService` or `FirefoxService`
and pass it via `chromeService` / `firefoxService`:

```typescript
import { Browser, ChromeService, FirefoxService } from 'craftdriver';

// Pin a specific chromedriver binary on a fixed port
const browser = await Browser.launch({
  browserName: 'chrome',
  chromeService: new ChromeService({
    binaryPath: '/opt/chromedriver/chromedriver',
    port: 9515,
    hostname: '127.0.0.1',
    args: ['--log-level=ALL'],
  }),
});

// Custom geckodriver path for Firefox
const ff = await Browser.launch({
  browserName: 'firefox',
  firefoxService: new FirefoxService({
    binaryPath: '/usr/local/bin/geckodriver',
  }),
});
```

Without an explicit `binaryPath`, both services check (in order) the
matching env var (`CHROMEDRIVER_PATH` / `GECKODRIVER_PATH`),
`node_modules/.bin/`, then `$PATH`. If `port` is omitted, a free port
is picked automatically.

## With Vitest

```typescript
import { describe, it, beforeEach, afterEach } from 'vitest';
import { Browser } from 'craftdriver';

describe('My App', () => {
  let browser: Browser;

  beforeEach(async () => {
    browser = await Browser.launch({ browserName: 'chrome' });
  });

  afterEach(async () => {
    await browser.quit();
  });

  it('shows welcome message after login', async () => {
    await browser.navigateTo('http://localhost:3000/login');
    await browser.fill('#username', 'testuser');
    await browser.fill('#password', 'password123');
    await browser.click('#login-btn');

    await browser.expect('#welcome').toContainText('Hello, testuser');
  });
});
```

## Next Steps

- [Browser API](./browser-api.md) - Full browser control reference
- [Selectors](./selectors.md) - Finding elements with CSS, XPath, and semantic locators
- [Session Management](./session-management.md) - Save/restore login sessions
