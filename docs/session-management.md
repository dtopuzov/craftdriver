# Session Management

CraftDriver supports Playwright-style session persistence, allowing you to save and restore browser state including cookies and localStorage. This is perfect for:

- **Skipping login in tests** - Log in once, reuse session across test runs
- **Sharing auth state** - Generate auth state in setup, use in parallel tests
- **Debugging** - Capture session state at any point

Session management is the user-facing feature. Under the hood, CraftDriver uses
the best available WebDriver transport for the browser you launched.

`storageState` is CraftDriver's native cookies-plus-localStorage format. It is
not a promise of Playwright JSON compatibility and does not include IndexedDB,
Cache Storage, service workers, or reusable sessionStorage.

State files contain live session cookies. Keep them in a dedicated ignored
directory:

```text
.auth/
```

## Saving Session State

```typescript
// Save all cookies and localStorage to a file
await browser.saveState('.auth/session.json');

// Save with options
await browser.saveState('.auth/session.json', {
  includeCookies: true, // default: true
  includeLocalStorage: true, // default: true
  includeSessionStorage: false, // default: false
});
```

The saved file contains:

```json
{
  "cookies": [
    {
      "name": "session",
      "value": "abc123",
      "domain": "example.com",
      "path": "/",
      "secure": true,
      "httpOnly": true,
      "sameSite": "lax"
    }
  ],
  "localStorage": {
    "https://example.com": {
      "theme": "dark",
      "userId": "12345"
    }
  }
}
```

## Loading Session State

```typescript
// Load state into current browser
await browser.loadState('.auth/session.json');

// Paths and in-memory state objects are equivalent
await browser.loadState(await browser.storage.getState());
```

## Working With State Objects

Use the state object directly when you do not want to write a file:

```typescript
const state = await browser.storage.getState();
await browser.storage.setState(state);
```

`browser.storage.setState()` is an active-page operation: navigate to the
state's sole HTTP(S) origin first. `browser.loadState()` uses the full
multi-origin hydrator on BiDi when the state has no sessionStorage; otherwise it
uses the same strict active-page rules.

## Launching with Pre-loaded State

The most common pattern - launch a browser with existing session:

```typescript
const browser = await Browser.launch({
  browserName: 'chrome',
  storageState: '.auth/session.json',
});

// Navigate directly to authenticated page
await browser.navigateTo('https://example.com/dashboard');
// Already logged in!
```

On supported BiDi sessions, cookies and every captured localStorage origin are
ready before the first real navigation. A private intercepted document seeds
each origin once; application changes are not overwritten on reload.

## Browser and Transport Support

| Surface | Chrome/Chromium BiDi | Firefox BiDi | Chrome/Firefox/Safari Classic |
| --- | --- | --- | --- |
| `Browser.launch({ storageState })` | Full cookies + multi-origin localStorage | Full cookies + multi-origin localStorage | Non-empty state rejected before mutation |
| `browser.newContext({ storageState })` | Full isolated restore | Full isolated restore | Unavailable (Classic has no user contexts) |
| `context.loadStorageState()` | Full multi-origin overlay | Full multi-origin overlay | Unavailable |
| `browser.loadState()` | Full multi-origin overlay without sessionStorage; strict active page with it | Same | Strict single-active-origin restore |
| Save | Cookies + current/open-page localStorage origins | Same | Cookies + current-page localStorage |

Chrome and Firefox BiDi and the Chrome/Firefox Classic fallback are covered by
the integration suite. Chromium uses the same Chrome-family BiDi implementation.
Safari is Classic-only and therefore receives the standards-only active-origin
contract, not launch-time restore.

### WebDriver Classic

Classic cannot write arbitrary-origin localStorage at launch. Use the explicit
fallback instead:

```typescript
const browser = await Browser.launch({ enableBiDi: false });
await browser.navigateTo('https://example.com');
await browser.loadState('.auth/session.json');
await browser.reload(); // the app can now read the restored state
```

CraftDriver validates the entire snapshot before mutation. `about:blank`,
multiple storage origins, a mismatched cookie domain, or a secure cookie that
cannot be set from the active page fails with `STATE_INVALID`. Non-empty
`storageState` at Classic launch fails with `UNSUPPORTED` instead of pretending
that a partial restore succeeded.

### sessionStorage and runtime failure semantics

`sessionStorage` capture is opt-in diagnostic state. Context and launch APIs
reject a non-empty `sessionStorage` section because it cannot be transferred to
future tabs. Active-page APIs can restore one matching origin after navigation.

Fresh launch and `newContext` restoration clean up the new session/context on
failure. An overlay into an existing context is not rollback-safe across
multiple protocol calls. A runtime failure throws `DRIVER_ERROR` with
`detail.phase` and `detail.partialApplied`; use a fresh context when failure
isolation matters.

## Cookie Management API

Direct cookie manipulation is also available:

```typescript
// Add a cookie
await browser.storage.addCookie({
  name: 'session',
  value: 'abc123',
  domain: 'localhost',
  path: '/',
  secure: false,
  httpOnly: true,
  sameSite: 'Lax',
  expiry: new Date('2025-12-31'), // or Unix timestamp
});

// Get all cookies
const cookies = await browser.storage.getCookies();

// Get cookies for specific domain
const domainCookies = await browser.storage.getCookies({ domain: 'example.com' });

// Set multiple cookies
await browser.storage.setCookies([
  { name: 'theme', value: 'dark', domain: 'example.com', path: '/' },
]);

// Clear all cookies
await browser.storage.clearCookies();

// Clear cookies by filter
await browser.storage.clearCookies({ name: 'session' });
await browser.storage.clearCookies({ domain: 'example.com' });
```

## Example: Login Once, Reuse Session

### Step 1: Generate Auth State (run once)

```typescript
// scripts/generate-auth.ts
import { Browser } from 'craftdriver';

async function generateAuth() {
  const browser = await Browser.launch({ browserName: 'chrome' });

  await browser.navigateTo('https://myapp.com/login');
  await browser.fill('#username', process.env.TEST_USER!);
  await browser.fill('#password', process.env.TEST_PASS!);
  await browser.click('#login-btn');

  // Wait for login to complete
  await browser.expect('#dashboard').toBeVisible();

  // Save the authenticated state
  await browser.saveState('.auth/session.json');

  await browser.quit();
  console.log('Auth state saved to .auth/session.json');
}

generateAuth();
```

### Step 2: Use Auth State in Tests

```typescript
// tests/dashboard.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import { Browser } from 'craftdriver';

describe('Dashboard', () => {
  let browser: Browser;

  beforeEach(async () => {
    // Launch with saved auth - already logged in!
    browser = await Browser.launch({
      browserName: 'chrome',
      storageState: '.auth/session.json',
    });
  });

  afterEach(async () => {
    await browser.quit();
  });

  it('shows user profile', async () => {
    // Go directly to authenticated page
    await browser.navigateTo('https://myapp.com/profile');

    // No login needed - session cookie is already set
    await browser.expect('#username').toHaveText('testuser');
  });

  it('can update settings', async () => {
    await browser.navigateTo('https://myapp.com/settings');
    await browser.click('#dark-mode-toggle');
    await browser.expect('#theme').toHaveText('dark');
  });
});
```

## Complete E2E Example

```typescript
import { Browser } from 'craftdriver';

async function testLoginPersistence() {
  // First browser: Log in and save state
  let browser = await Browser.launch({ browserName: 'chrome' });

  await browser.navigateTo('http://localhost:3000/login');
  await browser.fill('#username', 'testuser');
  await browser.fill('#password', 'secret123');
  await browser.click('#submit');
  await browser.expect('#welcome').toBeVisible();

  await browser.saveState('.auth/session.json');
  await browser.quit();

  // Second browser: Load state and verify logged in
  browser = await Browser.launch({
    browserName: 'chrome',
    storageState: '.auth/session.json',
  });

  await browser.navigateTo('http://localhost:3000/login');

  // Should already be logged in!
  await browser.expect('#welcome').toContainText('testuser');

  await browser.quit();
}
```

## API Reference

### Browser Methods

| Method                      | Description                        |
| --------------------------- | ---------------------------------- |
| `saveState(path, options?)` | Save cookies and storage to file   |
| `loadState(source)`         | Load cookies and storage from a path or object |

### StorageStateOptions

| Option                  | Type       | Default | Description                    |
| ----------------------- | ---------- | ------- | ------------------------------ |
| `includeCookies`        | `boolean`  | `true`  | Include cookies in saved state |
| `includeLocalStorage`   | `boolean`  | `true`  | Include localStorage           |
| `includeSessionStorage` | `boolean`  | `false` | Include sessionStorage         |
| `origins`               | `string[]` | all     | Filter localStorage/sessionStorage capture by origin. Capture is always scoped to the page's *current* origin — this only decides whether that one origin is included, it does not collect storage from other origins the page hasn't visited. Cookies are unaffected by this option. |

### SessionStateManager (browser.storage)

| Method                      | Description                        |
| --------------------------- | ---------------------------------- |
| `addCookie(cookie)`         | Add a single cookie                |
| `getCookies(filter?)`       | Get cookies, optionally filtered   |
| `setCookies(cookies)`       | Set multiple cookies               |
| `clearCookies(filter?)`     | Clear cookies, optionally filtered |
| `getState(options?)`        | Get current state as object        |
| `setState(source)`          | Set active-page state from path or object |
| `saveState(path, options?)` | Save state to file                 |
| `loadState(source)`         | Load active-page state from path or object |
