# Craftdriver 🍺🍺🍺

[![CI](https://github.com/dtopuzov/craftdriver/actions/workflows/ci.yml/badge.svg)](https://github.com/dtopuzov/craftdriver/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/craftdriver.svg)](https://www.npmjs.com/package/craftdriver)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Crafted Node.js browser automation built directly on the WebDriver protocols.

**Playwright-style ergonomics, WebDriver-standard internals.** Auto-waiting,
semantic locators, and a small public surface — without leaving the W3C spec
behind, so your tests stay stable across real browsers.

## Getting started

```bash
npm install craftdriver
```

## Prerequisites

You need the appropriate WebDriver binary on your PATH (or as a dev-dependency).

**Chrome / Chromium:**

```bash
npm install --save-dev chromedriver
```

**Firefox:**

```bash
npm install --save-dev geckodriver
# or: brew install geckodriver
```

Quick example:

```ts
import { Browser } from 'craftdriver';

// Chrome
const browser = await Browser.launch({ browserName: 'chrome' });

// Firefox
// const browser = await Browser.launch({ browserName: 'firefox' });

await browser.navigateTo('http://127.0.0.1:8080/login.html');
await browser.fill('#username', 'testuser'); // string = CSS selector
await browser.fill('#password', 'secret');
await browser.click('#submit');
await browser.expect('#result').toHaveText('Welcome testuser');
await browser.quit();
```

String selectors are CSS by default. For text, role, label, or test id, use
the `By.*` helpers or `browser.getBy*()` methods — see
[Selectors](./docs/selectors.md).

Mobile emulation:

```ts
const browser = await Browser.launch({
  browserName: 'chrome',
  mobileEmulation: 'iPhone 14',
});
```

Network mocking (BiDi is on by default):

```ts
const browser = await Browser.launch({ browserName: 'chrome' });

await browser.network.mock('**/api/users', {
  status: 200,
  body: { users: [] },
});
```

Session persistence:

```ts
await browser.saveState('./session.json');

// Later: restore with storageState option
const browser2 = await Browser.launch({
  browserName: 'chrome',
  storageState: './session.json',
});
```

## Feature Overview

### Core Features

- **Simple API** — Easy to use, works as expected
- **TypeScript-first** — Full type definitions included
- **Flexible locators** — CSS, XPath, text, role, label, alt text, title, and test id
- **Composable Locators** — Lazy, chainable `locator()` API with `.nth()`, `.filter()`, `.all()`
- **Auto-waiting** — Smart waits built into every action and assertion
- **Configurable timeouts** — `setDefaultTimeout()` / `setDefaultNavigationTimeout()`
- **Built-in assertions** — `browser.expect(selector).toHaveText(...)` etc.
- **Real browsers** — Tested on Chrome and Firefox (geckodriver) in CI
- **Mobile emulation** — Device presets (iPhone, Pixel, iPad) plus custom metrics
- **Iframes** — Interact with iframe content via `browser.frame(selector)`
- **Tabs & popups** — `browser.openPage()` and `browser.waitForPage()`
- **Dialogs** — `waitForDialog()`, `acceptDialog()`, `dismissDialog()`
- **File uploads & downloads** — `element.setInputFiles()` and `browser.waitForDownload()`
- **Navigation helpers** — `goBack()`, `goForward()`, `reload()`, `content()`, `setContent()`
- **In-page scripts** — `browser.evaluate()` and `browser.addInitScript()`
- **Virtual clock** — Test idle timeouts, trial expirations, and debounced inputs without `sleep()`. See [docs/clock.md](./docs/clock.md).

### Advanced Features (BiDi)

- **Browser contexts** — Isolated profiles for multi-user tests with `browser.newContext()`
- **Session persistence** — Save/load cookies and localStorage
- **Network mocking & listeners** — Intercept, mock, or observe traffic with `network.mock()` and `network.on('request' | 'response')`
- **Console & error logs** — Capture browser console messages and JS errors
- **Permissions & geolocation** — `grantPermissions()`, `setGeolocation()`
- **Emulation** — dark mode, locale, timezone, offline, reduced motion via `browser.emulate({...})`. See [docs/emulation.md](./docs/emulation.md).
- **Tracing** — Append-only NDJSON timeline of actions, network, console, navigations + on-action/on-error screenshots, written synchronously so a thrown `expect` cannot lose data
- **Accessibility audits** — Run axe-core against any page, element, or locator. WCAG violations come back with rule IDs, impact, and help URLs — with a one-line `disableRules` escape hatch for rules your project knowingly skips. Works out of the box; no extra install. See [docs/accessibility.md](./docs/accessibility.md).

## Documentation

| Guide                                              | Description                                                 |
| -------------------------------------------------- | ----------------------------------------------------------- |
| [Getting Started](./docs/getting-started.md)       | Installation, prerequisites, and first test                 |
| [Browser API](./docs/browser-api.md)               | Core browser control: navigation, clicks, forms             |
| [Element API](./docs/element-api.md)               | ElementHandle methods for interacting with elements         |
| [Selectors](./docs/selectors.md)                   | CSS, XPath, semantic locators, and composable `Locator` API |
| [Assertions](./docs/assertions.md)                 | Built-in expect API for testing                             |
| [Keyboard & Mouse](./docs/keyboard-mouse.md)       | Low-level input simulation                                  |
| [Dialogs](./docs/dialogs.md)                       | Handling `alert`, `confirm`, `prompt`, and `beforeunload`   |
| [Session Management](./docs/session-management.md) | Cookies, localStorage, and session persistence              |
| [Screenshots](./docs/screenshots.md)               | Capturing page and element screenshots                      |
| [Mobile Emulation](./docs/mobile-emulation.md)     | Test with mobile device viewports and touch events          |
| [Emulation](./docs/emulation.md)                   | Dark mode, locale, timezone, offline, reduced motion        |
| [Browser Contexts](./docs/browser-context.md)      | Isolated user profiles for multi-user testing               |
| [BiDi Features](./docs/bidi-features.md)           | Network mocking and console log capture                     |
| [Tracing](./docs/tracing.md)                       | Crash-resilient NDJSON event log + evidence screenshots for failed tests |
| [Accessibility](./docs/accessibility.md)           | axe-core powered a11y audits, scoped to page/element/locator |
| [Virtual Clock](./docs/clock.md)                   | Fake `Date`, `setTimeout`, and `setInterval` for time-dependent tests |

## Contributing

PRs and issues are welcome. Be kind. Brew great tests.

## License

MIT
