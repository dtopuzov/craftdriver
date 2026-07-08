# Log In Once And Reuse The Session

Use this pattern when login is slow, rate-limited, or not the thing most tests
are trying to prove. Log in once, save cookies and localStorage, then launch
future tests already signed in.

## Generate Auth State

Run this as a setup step before the tests that need an authenticated user.

```ts
import { mkdir } from 'node:fs/promises';
import { Browser } from 'craftdriver';

const authState = '.auth/alice.json';

await mkdir('.auth', { recursive: true });

const browser = await Browser.launch({ browserName: 'chrome' });

try {
  await browser.navigateTo('http://localhost:3000/login');
  await browser.getByLabel('Email').fill('alice@example.com');
  await browser.getByLabel('Password').fill(process.env.TEST_PASSWORD!);
  await browser.getByRole('button', { name: 'Sign in' }).click();
  await browser.expect('#account').toContainText('Alice');

  await browser.saveState(authState);
} finally {
  await browser.quit();
}
```

## Use Auth State In Tests

```ts
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { Browser } from 'craftdriver';

describe('authenticated dashboard', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({
      browserName: 'chrome',
      storageState: '.auth/alice.json',
    });
  });

  beforeEach(async () => {
    await browser.navigateTo('http://localhost:3000/dashboard');
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('shows account data', async () => {
    await browser.expect('#account').toContainText('Alice');
  });
});
```

## Notes

- Keep generated auth files out of source control if they contain real secrets.
- Regenerate auth state when the app changes login/session behavior.
- Use separate files such as `.auth/admin.json` and `.auth/customer.json` for different roles.

## Learn More

- [Session Management](../session-management.md)
- [Browser Contexts](../browser-context.md)
