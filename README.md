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
- 🧭 **Real browsers** - drives installed Chrome, Chromium, and Firefox instead of patched browser engine builds, plus real [Safari on macOS](https://dtopuzov.github.io/craftdriver/safari).
- 🌐 **Standards that age well** - W3C WebDriver standards stay stable while browser-private protocols change.
- 🚦 **Readable, auto-waited flows** - role, label, text, test id, CSS, XPath, click, fill, and expect.
- 📡 **Network control** - mock, block, intercept, and wait for browser requests and responses.
- 🔐 **Reusable sessions** - save cookies and localStorage, then launch already signed in.
- ⏱️ **Virtual clock** - freeze or fast-forward `Date`, timers, and time-sensitive UI.
- ♿ **Accessibility audits** - find WCAG 2.2 and Section 508 violations with built-in axe-core checks.
- 🖼️ **Visual testing** - catch visual regressions against baselines, without fighting anti-aliasing flakiness.
- 🧾 **Trace evidence** - capture actions, console output, errors, network events, and screenshots.
- ☁️ **Remote WebDriver** - use the Browser API with a self-hosted Selenium Grid or a cloud provider like [BrowserStack](https://www.browserstack.com/).
- ⚛️ **Electron apps** - drive packaged Electron desktop apps and mock native OS dialogs (open/save, message boxes).
- 🤖 **Agent-friendly** - one command sets up Claude Code, Codex, and Copilot with a CLI, a project-local skill, and optional MCP.

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

Your coding agent can write tests, but it can't see your app — so it guesses
selectors and hands you a test that fails on first run. CraftDriver gives it a
real browser to look at the page first.

```bash
npm install --save-dev craftdriver
npx craftdriver init
```

`init` installs a project-local skill that makes the CraftDriver CLI
discoverable to Claude Code, Codex, and Copilot. It never touches `AGENTS.md`,
`CLAUDE.md`, Copilot instructions, or any host's MCP configuration. Then ask:

> Use the CraftDriver skill. Explore `http://localhost:3000/login` and add a
> browser test for a failed sign-in, following this repository's existing test
> conventions. Verify every locator against the live page, run the focused test,
> and tell me what you changed.

The agent reads the accessibility tree, checks which locators actually resolve,
and writes the test against what it found. Start with
[Ask Your Agent To Write A Browser Test](https://dtopuzov.github.io/craftdriver/recipes/ask-an-agent-to-write-a-test).
The same prompt works over optional MCP when the host has no shell; full setup
is in the [AI agent guide](https://dtopuzov.github.io/craftdriver/agents).

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
await browser.saveState('.auth/session.json');

await Browser.launch({
  browserName: 'chrome',
  storageState: '.auth/session.json',
});

// Built-in accessibility checks via axe-core
await browser.a11y.check();
```

Launch-time state restores cookies plus multi-origin localStorage on supported
WebDriver BiDi sessions (Chrome/Chromium and Firefox). WebDriver Classic has an
explicit single-active-origin fallback after navigation; see
[Session management](https://dtopuzov.github.io/craftdriver/session-management#browser-and-transport-support).

## Feature Guide

| Area                 | What you get                                                                       | Learn more                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Getting started      | Install, launch a browser, write the first test                                    | [Getting started](https://dtopuzov.github.io/craftdriver/getting-started)                                                                  |
| Driver management    | Zero-config driver resolution, cache behavior, env vars, offline mode              | [Driver configuration](https://dtopuzov.github.io/craftdriver/driver-configuration)                                                        |
| Browser control      | Navigation, tabs, popups, iframes, content helpers, evaluate, init scripts         | [Browser API](https://dtopuzov.github.io/craftdriver/browser-api)                                                                          |
| Locators             | CSS, XPath, text, role, label, test id, and composable `locator()` chains          | [Selectors](https://dtopuzov.github.io/craftdriver/selectors)                                                                              |
| Open Shadow DOM      | Explicit lazy `shadowRoot()` boundaries over WebDriver Classic and BiDi            | [Shadow DOM](https://dtopuzov.github.io/craftdriver/selectors#open-shadow-dom)                                                             |
| Element actions      | Click, fill, upload, inspect, and interact through element handles                 | [Element API](https://dtopuzov.github.io/craftdriver/element-api)                                                                          |
| Assertions           | Built-in `expect(...)`, retries, visibility, text, attributes, and timing behavior | [Assertions](https://dtopuzov.github.io/craftdriver/assertions)                                                                            |
| Input                | Low-level key presses, mouse movement, hover, drag, and pointer input              | [Keyboard and mouse](https://dtopuzov.github.io/craftdriver/keyboard-mouse)                                                                |
| Dialogs              | `alert`, `confirm`, `prompt`, and `beforeunload` handling                          | [Dialogs](https://dtopuzov.github.io/craftdriver/dialogs)                                                                                  |
| Sessions             | Cookies, localStorage, save/load state, persistent login flows                     | [Session management](https://dtopuzov.github.io/craftdriver/session-management)                                                            |
| Network mocking      | Mock, block, intercept, and wait for browser requests and responses                | [Network mocking](https://dtopuzov.github.io/craftdriver/network)                                                                          |
| Console and errors   | Capture console output and fail tests on JavaScript errors                         | [Console logs](https://dtopuzov.github.io/craftdriver/browser-logs)                                                                        |
| Screenshots          | Page and element screenshots for tests and debugging                               | [Screenshots](https://dtopuzov.github.io/craftdriver/screenshots)                                                                          |
| Visual testing       | Compare screenshots to baselines with tolerances, retries, and diff artifacts      | [Visual testing](https://dtopuzov.github.io/craftdriver/visual-testing)                                                                    |
| Mobile and emulation | Device presets, viewport, locale, timezone, offline, reduced motion                | [Mobile emulation](https://dtopuzov.github.io/craftdriver/mobile-emulation), [Emulation](https://dtopuzov.github.io/craftdriver/emulation) |
| Browser contexts     | Isolated profiles for multi-user and multi-session testing                         | [Browser contexts](https://dtopuzov.github.io/craftdriver/browser-context)                                                                 |
| Tracing              | Crash-resilient NDJSON plus Vibium Player compatible trace zips                    | [Tracing](https://dtopuzov.github.io/craftdriver/tracing)                                                                                  |
| Accessibility        | Built-in axe-core audits for page, element, and locator scopes                     | [Accessibility](https://dtopuzov.github.io/craftdriver/accessibility)                                                                      |
| Virtual time         | Fake `Date`, `setTimeout`, and `setInterval` for time-sensitive flows              | [Virtual clock](https://dtopuzov.github.io/craftdriver/clock)                                                                              |
| Electron apps        | Drive packaged Electron renderers with a version-pinned chromedriver               | [Electron apps](https://dtopuzov.github.io/craftdriver/electron)                                                                            |
| Safari (macOS)       | Real desktop Safari via WebDriver Classic — enable once with `safaridriver --enable` | [Safari](https://dtopuzov.github.io/craftdriver/safari)                                                                                     |
| Remote WebDriver     | Run on a self-hosted Selenium Grid or a cloud provider like BrowserStack           | [Remote WebDriver](https://dtopuzov.github.io/craftdriver/remote-webdriver)                                                                |
| AI agents            | One-command skill install for Claude Code, Codex, and Copilot; CLI and MCP surfaces | [AI agent guide](https://dtopuzov.github.io/craftdriver/agents)                                                                            |

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
