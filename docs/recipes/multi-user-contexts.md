# Test Multi-User Workflows

Chat, approvals, permissions, and admin/customer flows need two signed-in users
at the same time — but sharing one browser leaks cookies between them. A browser
context is an isolated cookie and storage jar inside one launched browser, so two
users can act independently without a second browser process. This recipe signs
two users into the live
[login example](https://dtopuzov.github.io/craftdriver/examples/login.html) and
shows they stay isolated.

```ts
const alice = await browser.newContext();
const bob = await browser.newContext();

const alicePage = await alice.newPage({
  url: 'https://dtopuzov.github.io/craftdriver/examples/login.html',
});
await alicePage.find('#username').fill('alice');
await alicePage.find('#password').fill('secret');
await alicePage.find('#submit').click();
await alicePage.expect('#welcome').toContainText('Welcome back, alice!');

const bobPage = await bob.newPage({
  url: 'https://dtopuzov.github.io/craftdriver/examples/login.html',
});
await bobPage.find('#username').fill('bob');
await bobPage.find('#password').fill('secret');
await bobPage.find('#submit').click();
await bobPage.expect('#welcome').toContainText('Welcome back, bob!');

// Alice is unaffected by Bob signing in — cookies are per-context.
await alicePage.expect('#welcome').toContainText('Welcome back, alice!');

await alice.close();
await bob.close();
```

## Notes

- Use one context per user or role.
- In a real suite, close contexts in `afterEach()` so a failed assertion cannot leak sessions.
- Combine with saved `storageState` when users should start already signed in.

## Learn More

- [Browser Contexts](../browser-context.md)
- [Session Management](../session-management.md)
