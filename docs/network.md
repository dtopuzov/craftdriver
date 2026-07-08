# Network Mocking And Request Waiting

Use CraftDriver network tools when a test needs to control or observe HTTP traffic:

- mock an API response without changing the backend
- block analytics, ads, or flaky third-party services
- add headers such as auth tokens or test markers
- wait for the request or response triggered by a click
- assert that the app sent the right method, URL, or headers

> **Requires the default browser event connection.** Network interception and
> request/response waiting require `enableBiDi: true` (the default) and a
> browser that supports WebDriver BiDi. If you launch with
> `enableBiDi: false`, these methods throw a clear `requires BiDi` error.

## Browser Support

CraftDriver supports these network APIs on Chrome, Chromium, and Firefox.

## Quick Mock

```typescript
await browser.network.mock('**/api/users', {
  status: 200,
  body: {
    users: [{ id: 1, name: 'Test User' }],
  },
});

await browser.navigateTo('https://example.com/dashboard');
await browser.expect('#users').toContainText('Test User');
```

The pattern uses URL globs. `**/api/users` matches that path on any host.

## Common Tasks

| Goal | API |
| ---- | --- |
| Return a fake response | `browser.network.mock(pattern, response)` |
| Block matching requests | `browser.network.block(pattern)` |
| Dynamically inspect and respond | `browser.network.intercept(pattern, handler)` |
| Remove one route | `browser.network.removeIntercept(id)` |
| Remove every route | `browser.network.removeAllIntercepts()` |
| Add headers to outgoing requests | `browser.network.setExtraHeaders(headers)` |
| Bypass or restore browser cache | `browser.network.setCacheBehavior(behavior)` |
| Wait until traffic settles | `browser.network.waitForNetworkIdle(opts?)` |
| Wait for one request | `browser.waitForRequest(patternOrPredicate, opts?)` |
| Wait for one response | `browser.waitForResponse(patternOrPredicate, opts?)` |

## Mock Responses

### Static response

```typescript
await browser.network.mock('**/api/login', {
  status: 401,
  body: { error: 'Invalid credentials' },
});

await browser.getByLabel('Username').fill('baduser');
await browser.getByLabel('Password').fill('wrongpass');
await browser.getByRole('button', { name: 'Sign in' }).click();

await browser.expect('#error').toHaveText('Invalid credentials');
```

### Dynamic response

```typescript
await browser.network.mock('**/api/items/*', (request) => {
  const id = request.url.split('/').pop();

  return {
    status: 200,
    body: { id, name: `Item ${id}`, price: 9.99 },
  };
});
```

## Block Requests

```typescript
await browser.network.block('**/analytics/**');
await browser.network.block('**/tracking/**');
```

This is useful when third-party services make tests slower or less predictable.

## Add Headers

```typescript
await browser.network.setExtraHeaders({
  'X-Test-Mode': 'true',
  Authorization: 'Bearer test-token',
});
```

Extra headers are applied to matching browser requests after they are configured.

## Control Cache

```typescript
await browser.network.setCacheBehavior('bypass');

// Later, restore normal browser caching.
await browser.network.setCacheBehavior('default');
```

## Intercept Requests

Use `intercept()` when the response depends on request details or asynchronous
test setup.

```typescript
const seen: string[] = [];

const interceptId = await browser.network.intercept('**/api/**', async (request) => {
  seen.push(`${request.method} ${request.url}`);

  return {
    status: 200,
    body: { intercepted: true, originalUrl: request.url },
  };
});

// Later, remove only this intercept.
await browser.network.removeIntercept(interceptId);
```

You can also delay a response to test loading UI:

```typescript
await browser.network.intercept('**/api/**', async () => {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return { status: 200, body: { data: 'delayed response' } };
});

await browser.getByRole('button', { name: 'Load data' }).click();
await browser.expect('#loading-spinner').toBeVisible();
```

## Wait For Real Traffic

`browser.waitForRequest()` and `browser.waitForResponse()` observe real network
traffic without mocking it. Register the wait before the action that triggers the
request. `Promise.all` is the safest pattern:

```typescript
const [response] = await Promise.all([
  browser.waitForResponse('**/api/users'),
  browser.getByRole('button', { name: 'Load users' }).click(),
]);

expect(response.status).toBe(200);
```

Both methods accept a URL glob or a predicate:

```typescript
const [response] = await Promise.all([
  browser.waitForResponse((res) => {
    return res.url.includes('/api/users') && res.status === 200;
  }),
  browser.getByRole('button', { name: 'Load users' }).click(),
]);
```

### Response shape

| Property | Type | Description |
| -------- | ---- | ----------- |
| `url` | `string` | Full request URL |
| `status` | `number` | HTTP status code |
| `statusText` | `string` | Status text such as `"OK"` |
| `headers` | `Record<string, string>` | Response headers |
| `mimeType` | `string` | Response MIME type |
| `fromCache` | `boolean` | Whether the browser served it from cache |
| `request` | `{ id, url, method, headers }` | Matching request info |

### Request shape

| Property | Type | Description |
| -------- | ---- | ----------- |
| `id` | `string` | Browser request id |
| `url` | `string` | Full URL |
| `method` | `string` | Request method, such as `"GET"` or `"POST"` |
| `headers` | `Record<string, string>` | Request headers |

## Timeouts

Both wait methods accept `{ timeout?: number }`. The default is the browser
navigation timeout, 30 seconds.

```typescript
await browser.waitForResponse('**/api/users', { timeout: 10_000 });
```

On timeout, CraftDriver throws a clear error:

```text
waitForResponse("**/api/users") timed out after 30000ms
```
