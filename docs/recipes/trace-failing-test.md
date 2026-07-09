# Capture Failure Evidence With Tracing

When a complex or occasionally-flaky test fails, the message alone rarely tells
you why. A trace records the actions, navigation, console output, JavaScript
errors, network events, and screenshots so you can replay what happened. Wrap
the flow in a helper that starts a trace, keeps it on failure, and always stops
it. This recipe traces a sign-in against the live
[login example](https://dtopuzov.github.io/craftdriver/examples/login.html).

The `try/catch` here is deliberate — it is what keeps the trace directory when
the flow throws.

```ts
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

await withTrace('login', async () => {
  await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/login.html');
  await browser.getByLabel('Username').fill('alice');
  await browser.getByLabel('Password').fill('secret');
  await browser.getByRole('button', { name: 'Sign in' }).click();
  await browser.expect('#welcome').toContainText('Welcome back, alice!');
});
```

## Notes

- The trace file is NDJSON, so it stays useful even if the test throws before `stopTrace()`.
- Screenshots are stored under the trace directory.
- For high-volume suites, turn screenshots off unless a test is under investigation:

```ts
await browser.startTrace({ outDir: './traces/smoke', screenshots: 'off' });
```

## Learn More

- [Tracing](../tracing.md)
- [Screenshots](../screenshots.md)
- [Console Logs And JavaScript Errors](../browser-logs.md)
