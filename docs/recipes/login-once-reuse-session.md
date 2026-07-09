# Log In Once And Reuse The Session

Signing in through the UI in every test is slow, and for most tests logging in
is not the thing being proven. Do it once, save the resulting cookies and
localStorage, then launch later tests already authenticated with `storageState`.
Both halves below run against the live
[login example](https://dtopuzov.github.io/craftdriver/examples/login.html),
which persists its session in a cookie.

## Generate Auth State

Run this once as a setup step. It is one of the few recipes that shows
`launch`/`quit`, because saving state is a self-contained script, not a test.

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });

await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/login.html');
await browser.getByLabel('Username').fill('alice');
await browser.getByLabel('Password').fill('secret');
await browser.getByRole('button', { name: 'Sign in' }).click();
await browser.expect('#welcome').toContainText('Welcome back, alice!');

await browser.saveState('.auth/alice.json');
await browser.quit();
```

## Use Auth State In Tests

Launch with `storageState` and the browser starts already signed in.

```ts
const browser = await Browser.launch({
  browserName: 'chrome',
  storageState: '.auth/alice.json',
});

await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/login.html');
await browser.expect('#welcome').toContainText('Welcome back, alice!');
```

## Notes

- Keep generated auth files out of source control if they contain real secrets.
- Regenerate auth state when the app changes its login or session behavior.
- Use separate files such as `.auth/admin.json` and `.auth/customer.json` for different roles.

## Learn More

- [Session Management](../session-management.md)
- [Browser Contexts](../browser-context.md)
