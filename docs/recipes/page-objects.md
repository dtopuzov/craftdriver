# Organize Flows With Page Objects

As a suite grows, the same selectors and steps get copy-pasted across tests, and
one markup change breaks them all. A page object puts the selectors and actions
for a screen behind named methods, so tests read like intent (`loginAs(...)`) and
a UI change is a one-line fix in a single class. This recipe wraps the live
[login example](https://dtopuzov.github.io/craftdriver/examples/login.html) in a
`LoginPage`.

```ts
import { Browser } from 'craftdriver';

class LoginPage {
  constructor(private readonly browser: Browser) {}

  async open() {
    await this.browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/login.html');
  }

  async loginAs(username: string, password: string) {
    await this.browser.getByLabel('Username').fill(username);
    await this.browser.getByLabel('Password').fill(password);
    await this.browser.getByRole('button', { name: 'Sign in' }).click();
  }

  async expectWelcome(username: string) {
    await this.browser.expect('#welcome').toContainText(`Welcome back, ${username}!`);
  }
}
```

A test then reads as a sequence of intentions, with no selectors in sight:

```ts
const loginPage = new LoginPage(browser);

await loginPage.open();
await loginPage.loginAs('alice', 'secret');
await loginPage.expectWelcome('alice');
```

## Notes

- Expose intent (`loginAs`) rather than mechanics (`fill`, `click`) so tests survive markup changes.
- Keep assertions the test cares about in the test; put reusable expectations (like `expectWelcome`) on the page object.
- Pass the `browser` in rather than launching inside the page object, so lifecycle stays in your Vitest hooks.

## Learn More

- [Use CraftDriver With Vitest Hooks](./vitest-browser-lifecycle.md)
- [Selectors](../selectors.md)
- [Assertions](../assertions.md)
