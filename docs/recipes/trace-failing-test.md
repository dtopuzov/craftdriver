# Capture Failure Evidence With Tracing

Use this pattern when a flaky or complex test needs evidence: actions,
navigation, console output, JavaScript errors, network events, and screenshots.

```ts
import { afterAll, beforeAll, describe, it } from 'vitest';
import { Browser } from 'craftdriver';

describe('checkout', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: 'chrome' });
  });

  afterAll(async () => {
    await browser.quit();
  });

  async function withTrace(name: string, run: () => Promise<void>) {
    const outDir = `./traces/${name}-${Date.now()}`;
    await browser.startTrace({ outDir });

    try {
      await run();
    } catch (error) {
      console.error(`Trace kept at ${outDir}`);
      throw error;
    } finally {
      await browser.stopTrace().catch(() => undefined);
    }
  }

  it('places an order', async () => {
    await withTrace('checkout-order', async () => {
      await browser.navigateTo('http://localhost:3000/cart');
      await browser.getByRole('button', { name: 'Checkout' }).click();
      await browser.getByLabel('Card number').fill('4242424242424242');
      await browser.getByRole('button', { name: 'Pay' }).click();
      await browser.expect('#order-status').toContainText('Confirmed');
    });
  });
});
```

## Notes

- The trace file is NDJSON, so it remains useful even if the test throws before cleanup.
- Screenshots are stored under the trace directory.
- For high-volume suites, turn screenshots off unless the test is under investigation.

```ts
await browser.startTrace({
  outDir: './traces/smoke',
  screenshots: 'off',
});
```

## Learn More

- [Tracing](../tracing.md)
- [Screenshots](../screenshots.md)
- [Console Logs And JavaScript Errors](../browser-logs.md)
