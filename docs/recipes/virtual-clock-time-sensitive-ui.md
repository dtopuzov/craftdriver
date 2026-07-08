# Test Time-Sensitive UI With The Virtual Clock

Use this pattern for debounced search, trial banners, idle logout, countdowns,
and other UI that normally makes tests sleep.

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import { Browser } from 'craftdriver';

describe('debounced search', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: 'chrome' });
  });

  beforeEach(async () => {
    await browser.clock.install({ time: '2030-01-01T00:00:00Z' });
    await browser.navigateTo('http://localhost:3000/search');
  });

  afterEach(async () => {
    await browser.clock.uninstall();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('fires search only after the debounce window', async () => {
    await browser.network.mock('**/api/search?q=lap', {
      status: 200,
      body: { results: ['Laptop stand'] },
    });

    await browser.getByLabel('Search').fill('lap');

    await browser.clock.tick(299);
    await browser.expect('#results').toHaveText('');

    await browser.clock.tick(1);
    await browser.expect('#results').toContainText('Laptop stand');
  });
});
```

## Fixed Dates

For date-dependent UI, freeze the wall clock before navigation:

```ts
await browser.clock.setFixedTime('2026-06-15T23:59:00Z');
await browser.navigateTo('http://localhost:3000/billing');
await browser.expect('#trial-banner').toContainText('expires today');
```

## Learn More

- [Virtual Clock](../clock.md)
- [Network Mocking And Request Waiting](../network.md)
