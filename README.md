# Craftdriver 🍺🍺🍺

Crafted Node.js browser automation built directly on the WebDriver protocol.

Think of it as a modern take on Selenium with automatic waits and ergonomic API, while staying true to the W3C standards so your tests stay stable across real browsers.

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

String selectors are treated as CSS selectors. For semantic locators such as
text, role, label, or test id, use the `By.*` helpers or `browser.getBy*()`
methods.

Quick example:

```ts
import { Browser } from 'craftdriver';

// Chrome
const browser = await Browser.launch({ browserName: 'chrome' });

// Firefox
// const browser = await Browser.launch({ browserName: 'firefox' });

await browser.navigateTo('http://127.0.0.1:8080/login.html');
await browser.fill('#username', 'testuser');
await browser.fill('#password', 'secret');
await browser.click('#submit');
await browser.expect('#result').toHaveText('Welcome testuser');
await browser.quit();
```

Mobile emulation:

```ts
const browser = await Browser.launch({
  browserName: 'chrome',
  mobileEmulation: 'iPhone 14',
});
```

Network mocking:

```ts
const browser = await Browser.launch({
  browserName: 'chrome',
  enableBiDi: true,
});

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

- **Simple API** - Easy to use, works as expected
- **TypeScript-first** - Full type definitions included
- **Flexible locators** - CSS, XPath, text, role, and semantic selectors that stay stable
- **Composable Locators** - Lazy, chainable `locator()` API with `.nth()`, `.filter()`, `.all()`
- **Bulletproof interactions** - Reliable element, mouse, and keyboard control
- **Auto-waiting** - Smart waits built into all actions
- **Real browsers** - Test on actual Chrome, Chromium, and Firefox (via geckodriver)
- **Mobile emulation** - Test responsive designs with device presets (iPhone, Pixel, iPad)
- **Iframes** - Interact with iframe content via `browser.frame(selector)`
- **Tabs & popups** - Open with `browser.openPage()`; capture popups with `browser.waitForPage()`

### Advanced Features (BiDi)

- **Browser contexts** - Isolated profiles for multi-user tests with `browser.newContext()`
- **Session persistence** - Save/load cookies and localStorage
- **Network mocking** - Intercept and mock HTTP requests
- **Console/Error logs** - Capture browser console messages
- **Tracing** - Record network, console, and navigation events to a JSON bundle

## Documentation

| Guide                                              | Description                                         |
| -------------------------------------------------- | --------------------------------------------------- |
| [Getting Started](./docs/getting-started.md)       | Installation, prerequisites, and first test         |
| [Browser API](./docs/browser-api.md)               | Core browser control: navigation, clicks, forms     |
| [Element API](./docs/element-api.md)               | ElementHandle methods for interacting with elements |
| [Selectors](./docs/selectors.md)                   | CSS, XPath, semantic locators, and composable `Locator` API |
| [Assertions](./docs/assertions.md)                 | Built-in expect API for testing                     |
| [Keyboard & Mouse](./docs/keyboard-mouse.md)       | Low-level input simulation                          |
| [Session Management](./docs/session-management.md) | Cookies, localStorage, and session persistence      |
| [Screenshots](./docs/screenshots.md)               | Capturing page and element screenshots              |
| [Mobile Emulation](./docs/mobile-emulation.md)     | Test with mobile device viewports and touch events  |
| [Browser Contexts](./docs/browser-context.md)      | Isolated user profiles for multi-user testing       |
| [BiDi Features](./docs/bidi-features.md)           | Network mocking and console log capture             |
| [Tracing](./docs/tracing.md)                       | Record events and screenshots to a JSON trace bundle |

## Contributing

PRs and issues are welcome. Be kind. Brew great tests.

## License

MIT
