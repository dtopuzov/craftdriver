# Mock APIs And Assert Network Traffic

Use this pattern when the UI should be tested independently from unstable,
slow, or expensive backend services. Mock the response the app needs, then wait
for the request or response caused by the user action.

```ts
import { expect, it } from 'vitest';
import { Browser } from 'craftdriver';

it('loads mocked users and verifies the request', async () => {
  const browser = await Browser.launch({ browserName: 'chrome' });

  try {
    await browser.navigateTo('http://localhost:3000/users');

    await browser.network.mock('**/api/users', {
      status: 200,
      body: {
        users: [{ id: 1, name: 'Alice', plan: 'Pro' }],
      },
    });

    const [request, response] = await Promise.all([
      browser.waitForRequest((req) => {
        return req.url.includes('/api/users') && req.method === 'GET';
      }),
      browser.waitForResponse('**/api/users'),
      browser.getByRole('button', { name: 'Load users' }).click(),
    ]);

    expect(request.method).toBe('GET');
    expect(response.status).toBe(200);
    await browser.expect('#user-list').toContainText('Alice');
  } finally {
    await browser.quit();
  }
});
```

## Keep Mocks Isolated

If you share a browser across tests, clear intercepts in `afterEach()`:

```ts
afterEach(async () => {
  await browser.network.removeAllIntercepts();
});
```

## Notes

- Register waits before the click that triggers the request.
- Use a glob for simple URL matching and a predicate when method, status, or headers matter.
- Mock before navigation if the page fetches data during initial load.

## Learn More

- [Network Mocking And Request Waiting](../network.md)
- [Console Logs And JavaScript Errors](../browser-logs.md)
