# Use CraftDriver With Vitest Hooks

Most test files want the same shape: launch one browser, start each test from a
known page, and fail loudly if the browser logged an error. This recipe is that
skeleton — one browser per file, a fresh navigation per test, and an error gate
in `afterEach`. The rest of the recipes on this site build on it, so they can
show only the flow they are teaching and assume a launched `browser`.

It drives the live [login example](https://dtopuzov.github.io/craftdriver/examples/login.html).

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import { Browser } from 'craftdriver';

describe('login page', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({
      browserName: 'chrome',
      captureLogs: true,
    });
  });

  beforeEach(async () => {
    browser.logs.clearLogs();
    await browser.network.removeAllIntercepts();
    await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/login.html');
  });

  afterEach(() => {
    browser.logs.assertNoErrors();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('signs the user in', async () => {
    await browser.getByLabel('Username').fill('alice');
    await browser.getByLabel('Password').fill('secret');
    await browser.getByRole('button', { name: 'Sign in' }).click();
    await browser.expect('#welcome').toContainText('Welcome back, alice!');
  });
});
```

## Notes

- Launch in `beforeAll()` when tests in the file can share one browser process.
- Navigate in `beforeEach()` so each test starts from a known URL.
- Clear network mocks and logs before each test so one test cannot influence the next.
- Use `afterAll()` for `browser.quit()` so the local driver and browser processes are cleaned up.

## Learn More

- [Browser API](../browser-api.md)
- [Console Logs And JavaScript Errors](../browser-logs.md)
- [Network Mocking And Request Waiting](../network.md)
