# Console Logs And JavaScript Errors

Use `browser.logs` to capture what the page writes to the console and what
JavaScript errors the browser reports. This is useful for failing tests on
unexpected client-side errors, debugging flaky flows, or asserting that an app
emitted a known log message.

> **Requires the default browser event connection.** Console and JavaScript
> error capture requires `enableBiDi: true` (the default) and a browser that
> supports WebDriver BiDi. If you launch with `enableBiDi: false`, these
> methods throw a clear `requires BiDi` error.

## Capture Timing

Capture is automatic. CraftDriver subscribes to log events at launch, so
messages emitted at any point — including during the first navigation, before you
ever touch `browser.logs` — are captured. There is nothing to enable and no
listener to pre-arm:

```typescript
await browser.navigateTo('https://example.com');
await browser.getByRole('button', { name: 'Show warning' }).click();
const messages = browser.logs.getMessages(); // includes the warning
```

The subscription rides the connect-time batch, so it costs no extra round trip
and no measurable overhead. Use `clearLogs()` if you want to assert only on
messages emitted after a certain point.

## Read Collected Messages

```typescript
const messages = browser.logs.getMessages();

for (const msg of messages) {
  console.log(`[${msg.level}] ${msg.text}`);
}
```

Each console message has:

| Property | Description |
| -------- | ----------- |
| `type` | Always `'console'` |
| `level` | `'debug'`, `'info'`, `'warn'`, or `'error'` |
| `text` | Message text |
| `method` | Console method, such as `'log'`, `'warn'`, or `'error'` |
| `args` | Arguments passed to `console.*` |
| `timestamp` | When the message was logged |
| `stackTrace` | Optional stack frames |

Filter by level:

```typescript
const warnings = browser.logs.getLogsByLevel('warn');
const errors = browser.logs.getLogsByLevel('error');
```

## Read JavaScript Errors

```typescript
const errors = browser.logs.getErrors();

for (const error of errors) {
  console.log(`Error: ${error.text}`);
}
```

Each JavaScript error has:

| Property | Description |
| -------- | ----------- |
| `type` | Always `'javascript'` |
| `level` | Always `'error'` |
| `text` | Error message |
| `timestamp` | When the error occurred |
| `stackTrace` | Optional stack frames with function, URL, line, and column |

## Wait For A Log Or Error

```typescript
const consoleMessage = browser.logs.waitForConsole((msg) => {
  return msg.level === 'info' && msg.text.includes('Saved');
});

await browser.getByRole('button', { name: 'Save' }).click();
expect((await consoleMessage).text).toContain('Saved');
```

```typescript
const pageError = browser.logs.waitForError((error) => {
  return error.text.includes('Cannot read properties');
});

await browser.getByRole('button', { name: 'Trigger error' }).click();
expect((await pageError).text).toContain('Cannot read properties');
```

## Subscribe In Real Time

```typescript
const unsubscribeConsole = browser.logs.onConsole((msg) => {
  if (msg.level === 'error') {
    console.log('Console error:', msg.text);
  }
});

const unsubscribeErrors = browser.logs.onError((error) => {
  console.log('JavaScript error:', error.text);
});

// Later:
unsubscribeConsole();
unsubscribeErrors();
```

## Fail On Unexpected Errors

```typescript
await browser.navigateTo('https://example.com');
await browser.getByRole('button', { name: 'Run flow' }).click();

browser.logs.assertNoErrors();
```

You can also inspect errors yourself:

```typescript
const errors = browser.logs.getErrors();
expect(errors).toHaveLength(0);
```

## Other Helpers

| Method | Description |
| ------ | ----------- |
| `onLog(handler)` | Subscribe to all log messages |
| `on(level, handler)` | Subscribe to one level: `debug`, `info`, `warn`, or `error` |
| `getLogs()` | Return all captured console and JavaScript error messages |
| `clearLogs()` | Clear all collected console messages and errors |
| `waitForConsole(predicate, timeout?)` | Wait for a matching console message |
| `waitForError(predicate?, timeout?)` | Wait for a JavaScript error |
| `assertNoErrors()` | Throw if any JavaScript errors were captured |
