# Test A Mobile Flow With API Mocks And Logs

Use this pattern when mobile layout depends on a device preset and a backend
configuration response. This combines mobile emulation, network mocking, and log
capture in one test.

```ts
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Browser } from 'craftdriver';

describe('mobile navigation', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({
      browserName: 'chrome',
      mobileEmulation: 'Pixel 7',
      captureLogs: true,
    });
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('shows the mobile menu from mocked config', async () => {
    browser.logs.clearLogs();

    await browser.network.mock('**/api/mobile-config', {
      status: 200,
      body: {
        navigation: 'bottom-tabs',
        showInstallPrompt: false,
      },
    });

    await browser.navigateTo('http://localhost:3000');
    await browser.getByRole('button', { name: 'Menu' }).click();

    await browser.expect('#mobile-menu').toBeVisible();
    await browser.expect('#desktop-nav').not.toBeVisible();
    browser.logs.assertNoErrors();
  });
});
```

## Notes

- Mobile emulation is currently Chrome/Chromium only.
- Mock before navigation when the page reads mobile config during startup.
- Keep `captureLogs: true` if startup logs matter.

## Learn More

- [Mobile Emulation](../mobile-emulation.md)
- [Network Mocking And Request Waiting](../network.md)
- [Console Logs And JavaScript Errors](../browser-logs.md)
