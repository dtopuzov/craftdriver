# Why CraftDriver?

CraftDriver is for writing boringly reliable automation against real browsers, with code that reads nicely.

## What It Cares About

- 🍺 **Focused Node.js API** - browser automation without a giant framework around it.
- 🧭 **Real browsers** - drives installed Chrome, Chromium, and Firefox instead of patched browser engine builds, plus real [Safari on macOS](./safari.md).
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
- 🤖 **Agent-friendly** - CLI, a project-local skill, and optional MCP when coding agents need the browser.

## Good Fits

- End-to-end tests in Node.js.
- Browser scripts and diagnostics.
- Projects that want installed Chrome, Chromium, and Firefox through WebDriver.
- Tests that need network mocks, saved auth state, virtual time, or accessibility gates.
- Coding agents that should use the same browser automation primitives as humans.

## Not The Goal

CraftDriver is not trying to be a giant testing universe. It is the browser control layer: launch, navigate, click, fill, assert, inspect, debug, and get on with your day.
