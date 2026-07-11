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
- 🧭 **Real browsers** - drives installed Chrome, Chromium, and Firefox instead of patched browser engine builds.
- 🌐 **Standards that age well** - W3C WebDriver standards stay stable while browser-private protocols change.
- 🚦 **Readable, auto-waited flows** - role, label, text, test id, CSS, XPath, click, fill, and expect.
- 📡 **Network control** - mock, block, intercept, and wait for browser requests and responses.
- 🔐 **Reusable sessions** - save cookies and localStorage, then launch already signed in.
- ⏱️ **Virtual clock** - freeze or fast-forward `Date`, timers, and time-sensitive UI.
- ♿ **Accessibility audits** - run axe-core checks on pages, elements, and locators.
- 🧾 **Trace evidence** - capture actions, console output, errors, network events, and screenshots.
- 🤖 **Agent-friendly** - CLI, MCP, and assistant rules when coding agents need the browser.

## Choose Your Path

| You want to...                    | Start here                                                                |
| --------------------------------- | ------------------------------------------------------------------------- |
| Write browser automation          | [Getting started](https://dtopuzov.github.io/craftdriver/getting-started) |
| Give an AI coding agent a browser | [AI agent guide](https://dtopuzov.github.io/craftdriver/agents)           |

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

See the [AI agent guide](https://dtopuzov.github.io/craftdriver/agents) when you need the full setup.

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

| Area                 | What you get                                                                       | Learn more                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Getting started      | Install, launch a browser, write the first test                                    | [Getting started](https://dtopuzov.github.io/craftdriver/getting-started)                                                                  |
| Driver management    | Zero-config driver resolution, cache behavior, env vars, offline mode              | [Driver configuration](https://dtopuzov.github.io/craftdriver/driver-configuration)                                                        |
| Browser control      | Navigation, tabs, popups, iframes, content helpers, evaluate, init scripts         | [Browser API](https://dtopuzov.github.io/craftdriver/browser-api)                                                                          |
| Locators             | CSS, XPath, text, role, label, test id, and composable `locator()` chains          | [Selectors](https://dtopuzov.github.io/craftdriver/selectors)                                                                              |
| Element actions      | Click, fill, upload, inspect, and interact through element handles                 | [Element API](https://dtopuzov.github.io/craftdriver/element-api)                                                                          |
| Assertions           | Built-in `expect(...)`, retries, visibility, text, attributes, and timing behavior | [Assertions](https://dtopuzov.github.io/craftdriver/assertions)                                                                            |
| Input                | Low-level key presses, mouse movement, hover, drag, and pointer input              | [Keyboard and mouse](https://dtopuzov.github.io/craftdriver/keyboard-mouse)                                                                |
| Dialogs              | `alert`, `confirm`, `prompt`, and `beforeunload` handling                          | [Dialogs](https://dtopuzov.github.io/craftdriver/dialogs)                                                                                  |
| Sessions             | Cookies, localStorage, save/load state, persistent login flows                     | [Session management](https://dtopuzov.github.io/craftdriver/session-management)                                                            |
| Network mocking      | Mock, block, intercept, and wait for browser requests and responses                | [Network mocking](https://dtopuzov.github.io/craftdriver/network)                                                                          |
| Console and errors   | Capture console output and fail tests on JavaScript errors                         | [Console logs](https://dtopuzov.github.io/craftdriver/browser-logs)                                                                        |
| Screenshots          | Page and element screenshots for tests and debugging                               | [Screenshots](https://dtopuzov.github.io/craftdriver/screenshots)                                                                          |
| Mobile and emulation | Device presets, viewport, locale, timezone, offline, reduced motion                | [Mobile emulation](https://dtopuzov.github.io/craftdriver/mobile-emulation), [Emulation](https://dtopuzov.github.io/craftdriver/emulation) |
| Browser contexts     | Isolated profiles for multi-user and multi-session testing                         | [Browser contexts](https://dtopuzov.github.io/craftdriver/browser-context)                                                                 |
| Tracing              | Crash-resilient NDJSON plus Vibium Player compatible trace zips                    | [Tracing](https://dtopuzov.github.io/craftdriver/tracing)                                                                                  |
| Accessibility        | Built-in axe-core audits for page, element, and locator scopes                     | [Accessibility](https://dtopuzov.github.io/craftdriver/accessibility)                                                                      |
| Virtual time         | Fake `Date`, `setTimeout`, and `setInterval` for time-sensitive flows              | [Virtual clock](https://dtopuzov.github.io/craftdriver/clock)                                                                              |
| AI agents            | CLI, MCP server, assistant bootstrap, packaged skill files                         | [AI agent guide](https://dtopuzov.github.io/craftdriver/agents)                                                                            |

## Links

- [Documentation site](https://dtopuzov.github.io/craftdriver/)
- [API reference](https://dtopuzov.github.io/craftdriver/api-reference)
- [Recipes](https://dtopuzov.github.io/craftdriver/recipes) — recipes for brewing great tests 🍺
- [Changelog](./CHANGELOG.md)
- [Contributing guide](./CONTRIBUTING.md)

## Contributing

PRs and issues are welcome. Be kind. Brew great tests.

## License

MIT
