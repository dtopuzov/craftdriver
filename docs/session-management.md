# Session Management

Craftdriver supports Playwright-style session persistence, allowing you to save and restore browser state including cookies and localStorage. This is perfect for:

- **Skipping login in tests** - Log in once, reuse session across test runs
- **Sharing auth state** - Generate auth state in setup, use in parallel tests
- **Debugging** - Capture session state at any point

## Prerequisites

Session management requires BiDi to be enabled:

```typescript
const browser = await Browser.launch({
  browserName: 'chrome',
  enableBiDi: true, // Required for session management
});
```

## Saving Session State

```typescript
// Save all cookies and localStorage to a file
await browser.saveState('./session.json');

// Save with options
await browser.saveState('./session.json', {
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
      "value": { "type": "string", "value": "abc123" },
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
await browser.loadState('./session.json');
```

## Launching with Pre-loaded State

The most common pattern - launch a browser with existing session:

```typescript
const browser = await Browser.launch({
  browserName: 'chrome',
  enableBiDi: true,
  storageState: './session.json', // Pre-load session on launch
});

// Navigate directly to authenticated page
await browser.navigateTo('https://example.com/dashboard');
// Already logged in!
```

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
  const browser = await Browser.launch({
    browserName: 'chrome',
    enableBiDi: true,
  });

  await browser.navigateTo('https://myapp.com/login');
  await browser.fill('#username', process.env.TEST_USER!);
  await browser.fill('#password', process.env.TEST_PASS!);
  await browser.click('#login-btn');

  // Wait for login to complete
  await browser.expect('#dashboard').toBeVisible();

  // Save the authenticated state
  await browser.saveState('./auth.json');

  await browser.quit();
  console.log('Auth state saved to auth.json');
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
      enableBiDi: true,
      storageState: './auth.json',
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
  let browser = await Browser.launch({
    browserName: 'chrome',
    enableBiDi: true,
  });

  await browser.navigateTo('http://localhost:3000/login');
  await browser.fill('#username', 'testuser');
  await browser.fill('#password', 'secret123');
  await browser.click('#submit');
  await browser.expect('#welcome').toBeVisible();

  await browser.saveState('./session.json');
  await browser.quit();

  // Second browser: Load state and verify logged in
  browser = await Browser.launch({
    browserName: 'chrome',
    enableBiDi: true,
    storageState: './session.json',
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
| `loadState(path)`           | Load cookies and storage from file |

### StorageStateOptions

| Option                  | Type       | Default | Description                    |
| ----------------------- | ---------- | ------- | ------------------------------ |
| `includeCookies`        | `boolean`  | `true`  | Include cookies in saved state |
| `includeLocalStorage`   | `boolean`  | `true`  | Include localStorage           |
| `includeSessionStorage` | `boolean`  | `false` | Include sessionStorage         |
| `origins`               | `string[]` | all     | Limit to specific origins      |

### SessionStateManager (browser.storage)

| Method                      | Description                        |
| --------------------------- | ---------------------------------- |
| `addCookie(cookie)`         | Add a single cookie                |
| `getCookies(filter?)`       | Get cookies, optionally filtered   |
| `setCookies(cookies)`       | Set multiple cookies               |
| `clearCookies(filter?)`     | Clear cookies, optionally filtered |
| `getState(options?)`        | Get current state as object        |
| `setState(state)`           | Set state from object              |
| `saveState(path, options?)` | Save state to file                 |
| `loadState(path)`           | Load state from file               |
