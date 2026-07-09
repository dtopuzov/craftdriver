# Test A Mobile Flow With API Mocks And Logs

Mobile bugs often need three things set up at once: a real device viewport, a
predictable backend response, and a check that nothing errored in the console on
the smaller layout. This recipe combines all three — it launches with a Pixel 7
preset, mocks the API, and gates on browser errors — against the live
[network example](https://dtopuzov.github.io/craftdriver/examples/network.html).
Because mobile emulation is a launch-time capability, this recipe shows the
`launch` call.

```ts
const browser = await Browser.launch({
  browserName: 'chrome', // mobile emulation is Chrome/Chromium only
  mobileEmulation: 'Pixel 7',
  captureLogs: true,
});

// ?bidi=true makes the demo page issue real requests for interception.
await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/network.html?bidi=true');

await browser.network.mock('**/api/users', {
  status: 200,
  body: { users: [{ id: 1, name: 'Alice', plan: 'Pro' }] },
});

await browser.getByRole('button', { name: 'Fetch Users' }).click();
await browser.expect('#users-result').toContainText('Alice');

browser.logs.assertNoErrors();
```

## Notes

- Mobile emulation is currently Chrome/Chromium only.
- Mock before the action if the page reads data during that step.
- Keep `captureLogs: true` so `assertNoErrors()` has something to check.

## Learn More

- [Mobile Emulation](../mobile-emulation.md)
- [Network Mocking And Request Waiting](../network.md)
- [Console Logs And JavaScript Errors](../browser-logs.md)
