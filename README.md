# Craftdriver 🍺🍺🍺

Crafted Node.js browser automation built directly on the WebDriver protocol.

Think of it as a modern take on Selenium with automatic waits and ergonomic API, while staying true to the W3C standards so your tests stay stable across real browsers.

## Getting started

Install from npm (package coming soon):

```bash
npm install craftdriver
```

Quick example:

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });
await browser.navigateTo('http://127.0.0.1:8080/login.html');
await browser.fill('#username', 'testuser');
await browser.fill('#password', 'secret');
await browser.click('#submit');
await browser.expect('#result').toHaveText('Welcome testuser');
await browser.quit();
```

## Feature Overview

### Core Features

- **Simple API** - Easy to use, works as expected
- **TypeScript-first** - Full type definitions included
- **Flexible locators** - CSS, XPath, text, role, and semantic selectors that stay stable
- **Bulletproof interactions** - Reliable element, mouse, and keyboard control
- **Auto-waiting** - Smart waits built into all actions
- **Real browsers** - Test on actual Chrome, Edge, and other W3C-compliant browsers

### Advanced Features (BiDi)

- **Session persistence** - Save/load cookies and localStorage
- **Network mocking** - Intercept and mock HTTP requests
- **Console/Error logs** - Capture browser console messages

## Documentation

| Guide                                              | Description                                         |
| -------------------------------------------------- | --------------------------------------------------- |
| [Getting Started](./docs/getting-started.md)       | Installation, prerequisites, and first test         |
| [Browser API](./docs/browser-api.md)               | Core browser control: navigation, clicks, forms     |
| [Element API](./docs/element-api.md)               | ElementHandle methods for interacting with elements |
| [Selectors](./docs/selectors.md)                   | CSS, XPath, and semantic locators (By helpers)      |
| [Assertions](./docs/assertions.md)                 | Built-in expect API for testing                     |
| [Keyboard & Mouse](./docs/keyboard-mouse.md)       | Low-level input simulation                          |
| [Session Management](./docs/session-management.md) | Cookies, localStorage, and session persistence      |
| [Screenshots](./docs/screenshots.md)               | Capturing page and element screenshots              |
| [BiDi Features](./docs/bidi-features.md)           | Network mocking and console log capture             |

## Contributing

PRs and issues are welcome. Be kind. Brew great tests.

## License

MIT
