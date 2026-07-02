# BiDi Features

CraftDriver is built on the WebDriver BiDi protocol, giving you network interception, browser log capture, and precise load-state detection out of the box.

> **Browser support in craftdriver:** Chrome, Chromium, and Firefox.

---

## Feature matrix

Most of craftdriver works against both BiDi and Classic WebDriver. The
features below are **BiDi-only** — they require `enableBiDi: true`
(the default) and a browser that successfully negotiates a BiDi
WebSocket. Calling them after BiDi negotiation failed throws a clear
error; gate them with `browser.isBiDiEnabled()` if your code may run
in Classic mode.

| Capability | API | BiDi-only? |
|---|---|---|
| Network mocking / interception | [`browser.network.*`](#network-mocking) | yes |
| Console & error log capture | [`browser.logs.*`](#console--error-logs) | yes |
| `waitForLoadState('load' \| 'domcontentloaded' \| 'networkidle')` | `browser.waitForLoadState()` | no — event-driven over BiDi, polls `document.readyState` in Classic |
| `navigateTo(..., { waitUntil })` real load events | `browser.navigateTo()` | no — event-driven over BiDi, best-effort settle timer in Classic |
| `waitForRequest()` / `waitForResponse()` | `browser.waitForRequest()` / `waitForResponse()` | yes |
| Init scripts (run before any page script) | `browser.addInitScript()` | yes |
| Open new tab / popup | `browser.openPage()` | yes |
| Capture popup opened by an action | `browser.waitForPage()` | yes |
| Isolated user contexts (incognito profiles) | `browser.newContext()` / `browser.contexts()` | yes |
| Downloads | `browser.waitForDownload()` | yes |
| Tracing | `browser.startTrace()` / `browser.stopTrace()` | yes |
| Storage state (cookies + localStorage) | `browser.storage.*`, `saveState()`, `loadState()` | no — works in Classic too |
| Element actions, locators, assertions, frames, dialogs, screenshots, keyboard/mouse, mobile emulation | rest of the API | no — works in Classic too |

---

## Network Mocking

Intercept and mock network requests using `browser.network`.

### mock(pattern, response)

Return a mocked response for matching requests. Response can be an object or a function for dynamic mocking.

```typescript
// Static mock
await browser.network.mock('**/api/users', {
  status: 200,
  body: { users: [{ id: 1, name: 'Test User' }] },
});

// Dynamic mock - response based on request
await browser.network.mock('**/api/items/*', (request) => {
  const id = request.url.split('/').pop();
  return {
    status: 200,
    body: { id, name: `Item ${id}`, price: 9.99 },
  };
});

// Navigate - API calls will return mocked data
await browser.navigateTo('https://example.com/dashboard');
```

### block(pattern)

Block all requests matching the pattern.

```typescript
// Block analytics and tracking
await browser.network.block('**/analytics/**');
await browser.network.block('**/tracking/**');
```

### setExtraHeaders(headers)

Add extra headers to all requests.

```typescript
await browser.network.setExtraHeaders({
  'X-Test-Mode': 'true',
  Authorization: 'Bearer test-token',
});
```

### setCacheBehavior(behavior)

Control browser caching behavior.

```typescript
// Bypass cache - always fetch fresh
await browser.network.setCacheBehavior('bypass');

// Use default caching
await browser.network.setCacheBehavior('default');
```

### intercept(pattern, handler)

Intercept requests and provide custom responses. The handler receives request details and can return a mock response.

```typescript
let capturedRequests: string[] = [];

const interceptId = await browser.network.intercept('**/api/**', async (request) => {
  // Log request details
  capturedRequests.push(`${request.method} ${request.url}`);

  // Return a mock response
  return {
    status: 200,
    body: { intercepted: true, originalUrl: request.url },
  };
});
```

### removeIntercept(interceptId)

Remove a previously registered intercept using the ID returned from `intercept()` or `mock()`.

```typescript
const interceptId = await browser.network.mock('**/api/users', { status: 200, body: {} });
// ... later
await browser.network.removeIntercept(interceptId);
```

### Examples

#### Mock API Error

```typescript
await browser.network.mock('**/api/login', {
  status: 401,
  body: { error: 'Invalid credentials' },
});

await browser.find('#username').fill('baduser');
await browser.find('#password').fill('wrongpass');
await browser.find('#submit').click();

await browser.expect('#error').toHaveText('Invalid credentials');
```

#### Test Slow Network

```typescript
await browser.network.intercept('**/api/**', async (request) => {
  // Simulate slow network
  await new Promise((resolve) => setTimeout(resolve, 3000));
  // Return mock response after delay
  return { status: 200, body: { data: 'delayed response' } };
});

// Test loading state appears
await browser.find('#load-data').click();
await browser.expect('#loading-spinner').toBeVisible();
```

---

## Waiting for Network

`browser.waitForRequest` and `browser.waitForResponse` let you observe real network
traffic without intercepting it. Register them **before** the action that triggers
the request — the canonical pattern is `Promise.all`:

```typescript
const [response] = await Promise.all([
  browser.waitForResponse('**/api/users'),
  browser.click('#load-users'),
]);
expect(response.status).toBe(200);
```

Both accept a URL **glob** (same `**` syntax as `network.mock`) or a **predicate**:

```typescript
// Glob — matches by pathname
const [res] = await Promise.all([
  browser.waitForResponse('**/api/users'),
  browser.click('#load-users'),
]);

// Predicate — full control over matching
const [res2] = await Promise.all([
  browser.waitForResponse(r => r.url.includes('/api/users') && r.status === 200),
  browser.click('#load-users'),
]);
```

### waitForResponse(pattern, opts?)

Resolves with an `InterceptedResponse` once a matching completed response arrives.

| Property    | Type                       | Description                           |
| ----------- | -------------------------- | ------------------------------------- |
| `url`       | `string`                   | Full request URL                      |
| `status`    | `number`                   | HTTP status code                      |
| `statusText`| `string`                   | E.g. `"OK"`                           |
| `headers`   | `Record<string, string>`   | Response headers                      |
| `mimeType`  | `string`                   | E.g. `"application/json"`             |
| `fromCache` | `boolean`                  | Whether served from browser cache     |
| `request`   | `{ id, url, method, headers }` | Matching request info             |

### waitForRequest(pattern, opts?)

Resolves with an `InterceptedRequest` as soon as the browser sends the request
(before a response arrives). Useful for asserting that a request was made with
the right method/headers without waiting for the response.

| Property  | Type                     | Description            |
| --------- | ------------------------ | ---------------------- |
| `id`      | `string`                 | BiDi request id        |
| `url`     | `string`                 | Full URL               |
| `method`  | `string`                 | `"GET"`, `"POST"`, …   |
| `headers` | `Record<string, string>` | Request headers        |

### Timeout

Both methods accept `{ timeout?: number }` (defaults to the browser navigation
timeout, 30 s). On timeout a clear error is thrown:

```
waitForResponse("**/api/users") timed out after 30000ms
```

---

## Console & Error Logs

Access browser console output and JavaScript errors via `browser.logs`.

> **Capture is lazy by default.** Craftdriver only subscribes to log events
> the first time you touch `browser.logs.onLog()` / `.onConsole()` /
> `.onError()` / `.on()` / `.waitForConsole()` / `.waitForError()` — messages
> emitted before that first touch are not captured, so a bare
> `browser.logs.getMessages()` right after `navigateTo()` can return `[]`.
> Either arm a listener before the action that logs, or launch with
> `Browser.launch({ captureLogs: true })` to start capture immediately.

### getMessages()

Get all console messages.

```typescript
const messages = browser.logs.getMessages();

for (const msg of messages) {
  console.log(`[${msg.level}] ${msg.text}`);
}
```

Each message has:

- `type`: Always `'console'`
- `level`: `'debug'`, `'info'`, `'warn'`, or `'error'`
- `text`: The message content
- `method`: Console method used (`'log'`, `'warn'`, `'error'`, `'info'`, `'debug'`)
- `args`: Array of arguments passed to console
- `timestamp`: When the message was logged (Date object)
- `stackTrace`: Array of stack frames (optional)

### getLogsByLevel(level)

Get logs filtered by level.

```typescript
// Only warnings
const warnings = browser.logs.getLogsByLevel('warn');

// Only errors
const errors = browser.logs.getLogsByLevel('error');
```

### getErrors()

Get JavaScript errors that occurred on the page.

```typescript
const errors = browser.logs.getErrors();

for (const error of errors) {
  console.log(`Error: ${error.text}`);
  if (error.stackTrace) {
    for (const frame of error.stackTrace) {
      console.log(`  at ${frame.functionName} (${frame.url}:${frame.lineNumber})`);
    }
  }
}
```

Each error has:

- `type`: Always `'javascript'`
- `level`: Always `'error'`
- `text`: The error message
- `timestamp`: When the error occurred (Date object)
- `stackTrace`: Array of stack frames (optional), each with:
  - `functionName`: Name of the function
  - `url`: Source file URL
  - `lineNumber`: Line number
  - `columnNumber`: Column number

### clearLogs()

Clear all collected logs (both console messages and errors).

```typescript
browser.logs.clearLogs();
```

### onError(handler)

Subscribe to JavaScript errors in real-time.

```typescript
const unsubscribe = browser.logs.onError((error) => {
  console.log('JS Error detected:', error.text);
  // Take screenshot, log to file, etc.
});

// Later: stop listening
unsubscribe();
```

### onConsole(handler)

Subscribe to console messages in real-time.

```typescript
const unsubscribe = browser.logs.onConsole((msg) => {
  if (msg.level === 'error') {
    console.log('Console error:', msg.text);
  }
});
```

### Examples

#### Verify No Console Errors

```typescript
await browser.navigateTo('https://example.com');

// Interact with the page
await browser.find('#button').click();
await browser.pause(1000);

// Verify no errors occurred
const errors = browser.logs.getErrors();
expect(errors).toHaveLength(0);
```

#### Check for Expected Log

```typescript
await browser.find('#track-event').click();

const messages = browser.logs.getMessages();
const trackingLogs = messages.filter((m) => m.text.includes('Analytics event:'));

expect(trackingLogs.length).toBeGreaterThan(0);
```

#### Debug Test Failures

```typescript
test('form submission', async () => {
  const browser = await Browser.launch({ browserName: 'chrome' });

  try {
    await browser.navigateTo('https://example.com/form');
    await browser.find('#submit').click();
    await browser.expect('#success').toBeVisible();
  } catch (error) {
    // On failure, log browser console output
    console.log('Console messages:', browser.logs.getMessages());
    console.log('JS errors:', browser.logs.getErrors());
    throw error;
  } finally {
    await browser.quit();
  }
});
```

---

## Session Storage

Manage cookies and browser storage via `browser.storage`.

### addCookie(cookie)

Add a cookie.

```typescript
await browser.storage.addCookie({
  name: 'session_id',
  value: 'abc123',
  domain: 'example.com',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  expiry: new Date('2027-01-01'),
});
```

### getCookies(filter?)

Get cookies, optionally filtered.

```typescript
// All cookies
const cookies = await browser.storage.getCookies();

// Filter by domain
const sessionCookies = await browser.storage.getCookies({ domain: 'example.com' });

// Cookie value is a plain string
for (const cookie of cookies) {
  console.log(`${cookie.name}=${cookie.value}`);
}
```

### clearCookies(filter?)

Clear cookies, optionally filtered.

```typescript
// Clear all cookies
await browser.storage.clearCookies();

// Clear specific domain
await browser.storage.clearCookies({ domain: 'example.com' });
```

### saveState(path, options?) / loadState(path)

Save and restore session state (cookies + localStorage) - Playwright-style persistence.

```typescript
// Save login session
await browser.navigateTo('https://example.com/login');
await browser.find('#username').fill('user');
await browser.find('#password').fill('pass');
await browser.find('#submit').click();
await browser.saveState('./auth.json');

// Later: restore session in new browser
const browser2 = await Browser.launch({
  browserName: 'chrome',
  storageState: './auth.json',
});
// Or manually:
await browser2.loadState('./auth.json');
```

### saveState options

```typescript
await browser.saveState('./state.json', {
  includeCookies: true, // default: true
  includeLocalStorage: true, // default: true
  includeSessionStorage: false, // default: false
  origins: ['https://example.com'], // specific origins only
});
```

---

