# Use CraftDriver With Vitest Hooks

Use this pattern when a test file should launch one browser, navigate to a clean
page before each test, and fail if the page reports unexpected JavaScript errors.

This keeps tests fast without sharing dirty page state.

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import { Browser } from 'craftdriver';

describe('settings page', () => {
  let browser: Browser;
  const baseUrl = 'http://localhost:3000';

  beforeAll(async () => {
    browser = await Browser.launch({
      browserName: 'chrome',
      captureLogs: true,
    });
  });

  beforeEach(async () => {
    browser.logs.clearLogs();
    await browser.network.removeAllIntercepts();
    await browser.navigateTo(`${baseUrl}/settings`);
  });

  afterEach(() => {
    browser.logs.assertNoErrors();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('updates the display name', async () => {
    await browser.getByLabel('Display name').fill('Alice');
    await browser.getByRole('button', { name: 'Save' }).click();
    await browser.expect('#toast').toContainText('Saved');
  });
});
```

## Notes

- Launch in `beforeAll()` when tests in the file can share one browser process.
- Navigate in `beforeEach()` so each test starts from a known URL.
- Clear network mocks and logs before each test so one test cannot influence the next.
- Use `afterAll()` for `browser.quit()` so local driver and browser processes are cleaned up.

## Learn More

- [Browser API](../browser-api.md)
- [Console Logs And JavaScript Errors](../browser-logs.md)
- [Network Mocking And Request Waiting](../network.md)
