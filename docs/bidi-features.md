# BiDi Features

CraftDriver supports the WebDriver BiDi protocol for advanced browser control including network interception and browser logs.

## Enabling BiDi

Enable BiDi when launching the browser:

```typescript
const browser = await Browser.launch({
  browserName: 'chrome',
  enableBiDi: true,
});
```

> **Note:** BiDi requires a browser with WebDriver BiDi support. Chrome 115+ and Firefox 121+ support BiDi.

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

## Console & Error Logs

Access browser console output and JavaScript errors via `browser.logs`.

### getConsoleLogs()

Get all console messages.

```typescript
const messages = browser.logs.getConsoleLogs();

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

const messages = browser.logs.getConsoleLogs();
const trackingLogs = messages.filter((m) => m.text.includes('Analytics event:'));

expect(trackingLogs.length).toBeGreaterThan(0);
```

#### Debug Test Failures

```typescript
test('form submission', async () => {
  const browser = await Browser.launch({
    browserName: 'chrome',
    enableBiDi: true,
  });

  try {
    await browser.navigateTo('https://example.com/form');
    await browser.find('#submit').click();
    await browser.expect('#success').toBeVisible();
  } catch (error) {
    // On failure, log browser console output
    console.log('Console messages:', browser.logs.getConsoleLogs());
    console.log('JS errors:', browser.logs.getErrors());
    throw error;
  } finally {
    await browser.quit();
  }
});
```

---

## Session Storage

Manage cookies and browser storage via `browser.storage`. Works with both BiDi (preferred) and Classic WebDriver.

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

// Cookie value is a BytesValue object
for (const cookie of cookies) {
  console.log(`${cookie.name}=${cookie.value.value}`);
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
  enableBiDi: true,
  storageState: './auth.json', // Auto-load on launch
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

## BiDi vs Classic WebDriver

| Feature             | Classic | BiDi           |
| ------------------- | ------- | -------------- |
| Navigation          | ✅      | ✅             |
| Element interaction | ✅      | ✅             |
| Network mocking     | ❌      | ✅             |
| Request blocking    | ❌      | ✅             |
| Console logs        | ❌      | ✅             |
| JS error capture    | ❌      | ✅             |
| Cookie management   | ✅      | ✅ (preferred) |
| Session persistence | ✅      | ✅ (preferred) |

When BiDi is enabled, CraftDriver uses BiDi for features like cookie management (which provides real-time updates) and falls back to Classic WebDriver for other operations.
