# Getting Started

## Prerequisites

Ensure the appropriate browser driver is in your PATH.

**macOS/Linux:**

```bash
npm i -g chromedriver
```

**Windows:** Download chromedriver from [chromedriver.chromium.org](https://chromedriver.chromium.org/) and add to PATH.

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

## Launch Options

```typescript
const browser = await Browser.launch({
  // Browser type
  browserName: 'chrome', // 'chrome' | 'chromium'

  // Enable WebDriver BiDi for advanced features
  enableBiDi: true,

  // Pre-load saved session state (cookies, localStorage)
  storageState: './session.json',
});
```

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
