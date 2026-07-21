# Log In Once And Reuse The Session

Signing in through the UI in every test is slow, and for most tests logging in
is not the thing being proven. Do it once, save the resulting session, then
launch later tests already authenticated with `storageState`. Both halves below
run against the live
[login example](https://dtopuzov.github.io/craftdriver/examples/login.html),
which persists its session in a **cookie** — that detail matters, see the
limitation below.

## Generate Auth State

Run this once as a setup step. It is one of the few recipes that shows
`launch`/`quit`, because saving state is a self-contained script, not a test.

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch();

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
const browser = await Browser.launch({ storageState: '.auth/alice.json' });

await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/login.html');
await browser.expect('#welcome').toContainText('Welcome back, alice!');
```

## What `storageState` Restores

**Cookies only.** `saveState` captures cookies *and* localStorage, but the
launch option restores just the cookies.

The reason is not an oversight you can configure around: localStorage and
sessionStorage are scoped to an origin and can only be written by a page
already on that origin. `storageState` is applied at launch, when the browser
is still on `about:blank` and has no origin — so there is nowhere for those
entries to land.

If your app authenticates with a cookie — most do, including the example above
— this costs you nothing. If it keeps the token in localStorage, the launch
option will appear to work and then fail on the first authenticated request.
Navigate first, then load the state explicitly:

```ts
const browser = await Browser.launch();

await browser.navigateTo('https://example.test/app');  // reach the origin
await browser.loadState('.auth/alice.json');           // now storage can land
await browser.reload();                                // let the app read it
```

The CLI enforces that order rather than letting it fail quietly: `craftdriver
state load` refuses when the active page is not on the state's origin and tells
you which origin to visit.

## Notes

- Keep generated auth files out of source control if they contain real secrets.
- Regenerate auth state when the app changes its login or session behavior.
- Use separate files such as `.auth/admin.json` and `.auth/customer.json` for different roles.

## Learn More

- [Session Management](../session-management.md)
- [Browser Contexts](../browser-context.md)
