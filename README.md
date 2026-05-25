# Craftdriver 🍺🍺🍺

[![CI](https://github.com/dtopuzov/craftdriver/actions/workflows/ci.yml/badge.svg)](https://github.com/dtopuzov/craftdriver/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/craftdriver.svg)](https://www.npmjs.com/package/craftdriver)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Crafted Node.js browser automation built directly on the WebDriver protocols.

**Playwright's ergonomics. WebDriver's standards-compliance. AI-ready.**

Auto-waiting, semantic locators, network mocking, session management, mobile emulation, and more.

Based on W3C specs, so your tests stay stable across real browsers.

Ships AI productivity tooling out of the box: CLI, MCP, assistant bootstrap files, and packaged skill docs — no extra packages required.

## Getting started

```bash
npm install craftdriver --save-dev
```

That's it.
No drivers, no extra steps to install browsers.

Quick example:

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });

await browser.navigateTo('https://example.com');
await browser.fill('#username', 'alice');
await browser.fill('#password', 'hunter2');
await browser.click('#submit');
await browser.expect('#result').toHaveText('Welcome alice');

await browser.quit();
```

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

// Later: restore cookies and localStorage in one shot
const browser2 = await Browser.launch({
  browserName: 'chrome',
  storageState: './session.json',
});
```

## AI Productivity Tooling

`craftdriver` ships three surfaces for AI agents (Copilot, Claude
Code, Cursor, Codex, Gemini CLI, …), in addition to the library:

If you want Craftdriver to work well with coding agents on day one, this is the stack: a shell-friendly CLI, an MCP server for tool-calling hosts, packaged skills, and `craftdriver init` to drop the right repo instructions into place.

- **CLI** (this section) — a `craftdriver` binary for shell-capable agents.
- **Skill pack** — ready-to-load rules at [skills/craftdriver/](./skills/craftdriver/),
  shipped in the npm tarball.
- **MCP server** — stdio JSON-RPC for sandboxed hosts. See below.
- **`craftdriver init`** — drop per-project rules files for the popular
  assistants (Copilot, Claude, Cursor, Gemini, Codex / AGENTS.md).

All four share the same dispatcher, error codes, and selector syntax.

The `craftdriver` binary is for shell scripts, ad-hoc exploration, and
shell-capable AI agents. It wraps the same Browser API as the library,
with fail-fast defaults tuned for probing instead of stable test runs.

```bash
# terminal 1 — keep a long-lived browser around
npx craftdriver daemon start

# terminal 2 — drive it
npx craftdriver go http://127.0.0.1:8080/login.html
npx craftdriver fill '#username' alice
npx craftdriver fill '#password' hunter2
npx craftdriver click 'button[type=submit]'
npx craftdriver wait '#result' --state visible
npx craftdriver text '#result'

npx craftdriver daemon stop
```

State (page, cookies, storage) survives between calls — the CLI feels
like a REPL for the browser. For sandboxed environments that can't keep
a daemon, pipe a script through `--ephemeral` instead.

Selectors are CSS by default; switch with a `prefix=value` form
(`role=button[name=Submit]`, `text=Sign In`, `label=Email`,
`placeholder=...`, `testid=...`, `xpath=...`). Output is pretty on a
TTY and JSON when piped. Every error carries the same stable `code` and
`hint:` as the library. See [docs/cli.md](./docs/cli.md) for the full
command list and selector reference.

### Teach your AI assistant

`craftdriver init <flavor>` writes a short rules file into your project
so Copilot, Claude, Cursor, Codex, Gemini, OpenCode, Aider, &hellip;
pick up the right conventions on every turn (selector preference,
auto-waiting, error codes, CLI usage). Per-project, checked into git,
zero runtime cost.

```bash
npx craftdriver init copilot   # .github/copilot-instructions.md
npx craftdriver init claude    # CLAUDE.md
npx craftdriver init cursor    # .cursor/rules/craftdriver.mdc
npx craftdriver init gemini    # GEMINI.md
npx craftdriver init agents    # AGENTS.md (Codex, OpenCode, Aider, Amp, Cursor)
npx craftdriver init all       # every file above
```

Use `--force` to overwrite existing files, `--dry-run` to preview.

### Skill pack

For agents that load skills explicitly (Claude Code's Skills system,
Copilot agent customization, custom orchestrators), the npm tarball
ships a tiered skill pack under [skills/craftdriver/](./skills/craftdriver/):

- [`SKILL.md`](./skills/craftdriver/SKILL.md) — always-on, ≤ 500 tokens.
  Decision rules: selector preference order, error-code-first error
  handling, the auto-wait contract, when to reach for CLI/MCP.
- [`cheatsheet.md`](./skills/craftdriver/cheatsheet.md) — command-by-command
  reference for writing tests.
- [`patterns.md`](./skills/craftdriver/patterns.md) — worked recipes
  (login, upload, network-wait, a11y, tracing, virtual clock).
- [`cli.md`](./skills/craftdriver/cli.md) — agent-facing CLI reference.

Point your agent at `node_modules/craftdriver/skills/craftdriver/SKILL.md`
(or copy the file into your project) and the rest is loaded on demand.

### MCP server

For agents that talk [Model Context Protocol](https://modelcontextprotocol.io)
(Claude Desktop / Code, Cursor, Windsurf, Zed, Goose, Gemini CLI, …),
`craftdriver mcp` exposes the same dispatcher as a stdio JSON-RPC
server with 14 schema-typed tools. Mutating tools return a **compact
a11y snapshot diffed from the previous turn** — the agent sees what
changed on the page without a follow-up read.

```bash
# Claude Code
claude mcp add craftdriver -- npx -y craftdriver mcp
```

```jsonc
// Cursor / Windsurf / Zed
{
  "mcpServers": {
    "craftdriver": { "command": "npx", "args": ["-y", "craftdriver", "mcp"] }
  }
}
```

See [docs/mcp.md](./docs/mcp.md) for the full tool list, install
snippets for every host, and the snapshot format.

## Feature Guide

One table is enough here: what Craftdriver does, and where to learn the exact API.

| Area | What you get | Learn more |
| --- | --- | --- |
| Getting started | Install, launch a browser, write the first test | [Getting Started](./docs/getting-started.md) |
| Driver management | Zero-config driver download, cache behavior, env vars, offline mode | [Driver Configuration](./docs/driver-configuration.md) |
| Browser control | Navigation, tabs, popups, iframes, content helpers, evaluate, init scripts | [Browser API](./docs/browser-api.md) |
| Elements and locators | CSS, XPath, text, role, label, test id, and composable `locator()` chains | [Selectors](./docs/selectors.md) |
| Element actions | Click, fill, upload, inspect, and interact through element handles | [Element API](./docs/element-api.md) |
| Assertions and auto-waiting | Built-in `expect(...)`, retries, visibility, text, attributes, and timing behavior | [Assertions](./docs/assertions.md) |
| Keyboard and mouse | Low-level key presses, mouse movement, hover, drag, and pointer input | [Keyboard & Mouse](./docs/keyboard-mouse.md) |
| Dialogs | `alert`, `confirm`, `prompt`, and `beforeunload` handling | [Dialogs](./docs/dialogs.md) |
| Sessions and storage | Cookies, localStorage, save/load state, persistent flows | [Session Management](./docs/session-management.md) |
| Screenshots | Page and element screenshots for tests and debugging | [Screenshots](./docs/screenshots.md) |
| Mobile and emulation | Device presets, viewport emulation, locale, timezone, offline, reduced motion | [Mobile Emulation](./docs/mobile-emulation.md), [Emulation](./docs/emulation.md) |
| Browser contexts | Isolated profiles for multi-user and multi-session testing | [Browser Contexts](./docs/browser-context.md) |
| BiDi features | Network mocking, request/response listeners, console logs, JS errors | [BiDi Features](./docs/bidi-features.md) |
| Tracing and debugging | Crash-resilient NDJSON traces and evidence screenshots | [Tracing](./docs/tracing.md) |
| Accessibility | Built-in axe-core audits for page, element, and locator scopes | [Accessibility](./docs/accessibility.md) |
| Virtual time | Fake `Date`, `setTimeout`, and `setInterval` for time-sensitive flows | [Virtual Clock](./docs/clock.md) |
| Agent surfaces | Shell CLI, MCP server, assistant bootstrap, and packaged skill files | [CLI](./docs/cli.md), [MCP server](./docs/mcp.md), [Skill pack](./skills/craftdriver/SKILL.md) |

## Contributing

PRs and issues are welcome. Be kind. Brew great tests.

## License

MIT
