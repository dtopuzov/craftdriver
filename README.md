# CraftDriver 🍺

[![CI](https://github.com/dtopuzov/craftdriver/actions/workflows/ci.yml/badge.svg)](https://github.com/dtopuzov/craftdriver/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/craftdriver.svg)](https://www.npmjs.com/package/craftdriver)
[![npm downloads](https://img.shields.io/npm/dm/craftdriver.svg)](https://www.npmjs.com/package/craftdriver)
[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-2563eb.svg)](https://dtopuzov.github.io/craftdriver/)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-43853d.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-f59e0b.svg)](./LICENSE)

Crafted Node.js browser automation built on W3C WebDriver and BiDi.

**Playwright-style ergonomics. WebDriver standards. AI friendly.**

CraftDriver is for writing boringly reliable automation against real browsers, with code that reads nicely.

## Why CraftDriver?

- 🍺 **Focused Node.js API** - browser automation without a giant framework around it.
- 🧭 **Real browsers** - drives installed Chrome, Firefox, and Safari instead of patched browser engine builds
- 🌐 **Standards that age well** - WebDriver Classic and BiDi keep tests on a W3C path instead of browser-private protocol churn.
- 🚦 **Readable, auto-waited flows** - role, label, text, test id, CSS, XPath, click, fill, and expect.
- 📡 **Network control** - mock, block, intercept, and wait for browser requests and responses.
- 🔐 **Reusable sessions** - save cookies and localStorage, then launch already signed in.
- ⏱️ **Virtual clock** - freeze or fast-forward `Date`, timers, and time-sensitive UI.
- ♿ **Accessibility audits** - run axe-core checks on pages, elements, and locators.
- 🧾 **Trace evidence** - capture actions, console output, errors, network events, and screenshots.
- 🤖 **Agent-friendly** - CLI, MCP, and assistant rules when coding agents need the browser.

## Choose Your Path

| You want to...                    | Start here                                   |
| --------------------------------- | -------------------------------------------- |
| Write browser automation          | [Getting started](./docs/getting-started.md) |
| Give an AI coding agent a browser | [AI agent guide](./docs/agents.md)           |

## Quick Start

```bash
npm install craftdriver --save-dev
```

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });

await browser.navigateTo('https://example.com/login');
await browser.getByLabel('Username').fill('alice');
await browser.getByLabel('Password').fill('hunter2');
await browser.getByRole('button', { name: 'Sign in' }).click();
await browser.expect('#result').toHaveText('Welcome alice');

await browser.quit();
```

No separate chromedriver or geckodriver setup for normal use. CraftDriver resolves and caches the right driver for your installed browser.

## AI Agent Bonus

If your coding agent can use a shell or MCP, CraftDriver can give it a real browser too. Same selectors, same behavior, same error codes as the library API.

```bash
npx craftdriver init agents
claude mcp add craftdriver -- npx -y craftdriver mcp
```

See the [AI agent guide](./docs/agents.md) when you need the full setup.

## What It Can Do

```ts
// Mobile emulation
await Browser.launch({
  browserName: 'chrome',
  mobileEmulation: 'iPhone 14',
});

// Network mocking
await browser.network.mock('**/api/users', {
  status: 200,
  body: { users: [] },
});

// Save and reuse login state
await browser.saveState('./session.json');

await Browser.launch({
  browserName: 'chrome',
  storageState: './session.json',
});

// Built-in accessibility checks via axe-core
await browser.a11y.check();
```

## Feature Guide

| Area                 | What you get                                                                       | Learn more                                                                       |
| -------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Getting started      | Install, launch a browser, write the first test                                    | [Getting started](./docs/getting-started.md)                                     |
| Driver management    | Zero-config driver resolution, cache behavior, env vars, offline mode              | [Driver configuration](./docs/driver-configuration.md)                           |
| Browser control      | Navigation, tabs, popups, iframes, content helpers, evaluate, init scripts         | [Browser API](./docs/browser-api.md)                                             |
| Locators             | CSS, XPath, text, role, label, test id, and composable `locator()` chains          | [Selectors](./docs/selectors.md)                                                 |
| Element actions      | Click, fill, upload, inspect, and interact through element handles                 | [Element API](./docs/element-api.md)                                             |
| Assertions           | Built-in `expect(...)`, retries, visibility, text, attributes, and timing behavior | [Assertions](./docs/assertions.md)                                               |
| Input                | Low-level key presses, mouse movement, hover, drag, and pointer input              | [Keyboard and mouse](./docs/keyboard-mouse.md)                                   |
| Dialogs              | `alert`, `confirm`, `prompt`, and `beforeunload` handling                          | [Dialogs](./docs/dialogs.md)                                                     |
| Sessions             | Cookies, localStorage, save/load state, persistent login flows                     | [Session management](./docs/session-management.md)                               |
| Network mocking      | Mock, block, intercept, and wait for browser requests and responses                | [Network mocking](./docs/network.md)                                             |
| Console and errors   | Capture console output and fail tests on JavaScript errors                         | [Console logs](./docs/browser-logs.md)                                           |
| Screenshots          | Page and element screenshots for tests and debugging                               | [Screenshots](./docs/screenshots.md)                                             |
| Mobile and emulation | Device presets, viewport, locale, timezone, offline, reduced motion                | [Mobile emulation](./docs/mobile-emulation.md), [Emulation](./docs/emulation.md) |
| Browser contexts     | Isolated profiles for multi-user and multi-session testing                         | [Browser contexts](./docs/browser-context.md)                                    |
| Tracing              | Crash-resilient NDJSON traces and evidence screenshots                             | [Tracing](./docs/tracing.md)                                                     |
| Accessibility        | Built-in axe-core audits for page, element, and locator scopes                     | [Accessibility](./docs/accessibility.md)                                         |
| Virtual time         | Fake `Date`, `setTimeout`, and `setInterval` for time-sensitive flows              | [Virtual clock](./docs/clock.md)                                                 |
| AI agents            | CLI, MCP server, assistant bootstrap, packaged skill files                         | [AI agent guide](./docs/agents.md)                                               |

## Links

- [Documentation site](https://dtopuzov.github.io/craftdriver/)
- [Documentation home](./docs/index.md)
- [API reference](./docs/api-reference.md)
- [Changelog](./CHANGELOG.md)
- [Contributing guide](./CONTRIBUTING.md)

## Contributing

PRs and issues are welcome. Be kind. Brew great tests.

## License

MIT
