# Fail On Console And JavaScript Errors

Use this pattern when a flow can look correct in the DOM while still logging
client-side errors. Start log capture early, run the flow, then fail on
unexpected JavaScript errors.

```ts
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { Browser } from 'craftdriver';

describe('critical browser flows', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({
      browserName: 'chrome',
      captureLogs: true,
    });
  });

  beforeEach(async () => {
    browser.logs.clearLogs();
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('saves settings without browser errors', async () => {
    await browser.navigateTo('http://localhost:3000/settings');
    await browser.getByLabel('Display name').fill('Alice');
    await browser.getByRole('button', { name: 'Save' }).click();

    await browser.expect('#toast').toContainText('Saved');
    browser.logs.assertNoErrors();
  });
});
```

## Wait For A Known Log

When the log itself is part of the expected behavior, arm the wait before the
action that emits it:

```ts
const saved = browser.logs.waitForConsole((message) => {
  return message.level === 'info' && message.text.includes('settings:saved');
});

await browser.getByRole('button', { name: 'Save' }).click();
await saved;
```

## Learn More

- [Console Logs And JavaScript Errors](../browser-logs.md)
- [Tracing](../tracing.md)
