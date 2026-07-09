# Mock APIs And Assert Network Traffic

Testing the UI against a real backend makes tests slow and flaky and couples them
to data you do not control. Mock the response the page needs, then wait for the
request or response the user action triggers so you can assert both the UI and
the traffic. This recipe drives the live
[network example](https://dtopuzov.github.io/craftdriver/examples/network.html).

```ts
// The ?bidi=true query just tells this demo page to make real network
// requests instead of its built-in stub, so the mock below is what answers.
await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/network.html?bidi=true');

await browser.network.mock('**/api/users', {
  status: 200,
  body: { users: [{ id: 1, name: 'Alice', plan: 'Pro' }] },
});

const [response] = await Promise.all([
  browser.waitForResponse('**/api/users'),
  browser.getByRole('button', { name: 'Fetch Users' }).click(),
]);

expect(response.status).toBe(200);
await browser.expect('#users-result').toContainText('Alice');
```

## Keep Mocks Isolated

When a browser is shared across tests, clear intercepts between them:

```ts
afterEach(async () => {
  await browser.network.removeAllIntercepts();
});
```

## Notes

- Register the wait before the click that triggers the request (the `Promise.all` above).
- Use a glob for simple URL matching and a predicate when method, status, or headers matter.
- Mock before navigation if the page fetches data during initial load.

## Learn More

- [Network Mocking And Request Waiting](../network.md)
- [Console Logs And JavaScript Errors](../browser-logs.md)
