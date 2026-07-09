# Fail On Console And JavaScript Errors

A flow can look correct in the DOM while quietly throwing in the console — a
failed fetch, an undefined access, a rejected promise. Logs are captured
automatically from launch, so you can run the flow and then assert no JavaScript
errors were reported, breaking the test instead of reaching users. This recipe
uses the live
[console errors example](https://dtopuzov.github.io/craftdriver/examples/console-errors.html).

```ts
const browser = await Browser.launch();

await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/console-errors.html');
browser.logs.clearLogs();

await browser.click('#btn-console-log'); // your real user flow goes here

// Fails the test if the page reported any JavaScript error during the flow.
browser.logs.assertNoErrors();
```

## Wait For A Known Log

When a log line is itself part of the expected behavior, arm the wait before the
action that emits it:

```ts
const logged = browser.logs.waitForConsole((message) =>
  message.text.includes('Hello from console.log')
);

await browser.click('#btn-console-log');
await logged;
```

## Notes

- `assertNoErrors()` checks captured JavaScript errors — capture is automatic, nothing to enable.
- Call `clearLogs()` before the flow so errors from earlier tests don't bleed in.
- Use `waitForConsole()` / `waitForError()` when a specific message is the thing you're asserting.

## Learn More

- [Console Logs And JavaScript Errors](../browser-logs.md)
- [Tracing](../tracing.md)
