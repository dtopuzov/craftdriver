# Log In Once And Reuse The Session

Signing in through the UI in every test is slow, and for most tests logging in
is not the thing being proven. Do it once, save the resulting session, then
launch later tests already authenticated with `storageState`. Both halves below
run against the live
[login example](https://dtopuzov.github.io/craftdriver/examples/login.html),
which persists auth in a cookie and user preferences in localStorage.

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

On supported WebDriver BiDi sessions, launch restores cookies **and every
captured localStorage origin** before the first real navigation. CraftDriver
uses a private, locally fulfilled same-origin document because BiDi has no
out-of-band localStorage command. The state is written once, so application
changes survive reload.

`storageState` does not restore IndexedDB, Cache Storage, service workers, or
reusable sessionStorage. Context and launch APIs reject non-empty
sessionStorage rather than silently dropping it.

WebDriver Classic cannot restore arbitrary-origin localStorage at launch, so a
non-empty launch `storageState` is rejected. Its strict single-origin fallback
is explicit:

```ts
const browser = await Browser.launch({ enableBiDi: false });

await browser.navigateTo('https://example.test/app');  // reach the origin
await browser.loadState('.auth/alice.json');           // now storage can land
await browser.reload();                                // let the app read it
```

The fallback validates the complete snapshot before applying anything. A
second origin or a cookie that cannot be set from the active page fails loudly.
Chrome/Chromium and Firefox BiDi use the simpler launch form above.

## Notes

- Add `.auth/` to `.gitignore`; generated state contains live session cookies.
- Regenerate auth state when the app changes its login or session behavior.
- Use separate files such as `.auth/admin.json` and `.auth/customer.json` for different roles.

## Learn More

- [Session Management](../session-management.md)
- [Browser Contexts](../browser-context.md)
