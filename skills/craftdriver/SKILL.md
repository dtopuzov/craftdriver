# craftdriver — SKILL

Modern BiDi-first WebDriver library for Node.js. Playwright ergonomics,
WebDriver standards-compliance, no AI in the hot path.

## Core loop

```
navigate → find → action → assert
```

Every action and every `expect(locator).to…()` **auto-waits** up to the
default timeout (30 s in-library, 5 s on agent surfaces). Never add
`sleep()` / `setTimeout()` — it's a footgun.

## Selector preference order

```
By.testId  >  By.role({name})  >  By.labelText  >
By.text({exact:true})  >  By.css  >  By.xpath
```

`testId` and `role` are stable across DOM refactors; CSS and XPath
break the moment markup shifts.

## Five rules

1. Use `expect(locator).to…()` for assertions. Never hand-roll
   `while (...) { ... sleep(100) }` retry loops — they auto-wait.
2. Read errors by `code`, not by prose. Every public throw is a
   `CraftdriverError` with a stable `code`. See
   [docs/error-codes.md](../../docs/error-codes.md).
3. `instanceof CraftdriverError` is true on every public throw;
   `instanceof Error` is also true.
4. BiDi features (`network`, `logs`, tracing, init scripts, true load
   events) require `Browser.launch({ enableBiDi: true })`. The error
   code on the wrong transport is `UNSUPPORTED`.
5. Tests fetch from the example server. Start it in a separate
   terminal: `npm run examples:start` before `npm test`.

## When you reach for more

- **Writing tests, looking for a method** → read
  [skills/craftdriver/cheatsheet.md](cheatsheet.md). Also see
  [docs/api-reference.md](../../docs/api-reference.md) — every public
  export, one row each.
- **Login, upload, wait-for-network, etc.** → read
  [skills/craftdriver/patterns.md](patterns.md).
- **Driving the browser from a shell or agent loop** → read
  [skills/craftdriver/cli.md](cli.md). Same Browser API, exposed as a
  `craftdriver` binary with daemon + ephemeral modes.
- **Driving from an MCP-aware AI host** (Claude Desktop / Code, Cursor,
  Windsurf, Zed, Goose, Gemini CLI) → `craftdriver mcp` is a stdio
  JSON-RPC server with 14 schema-typed tools. Mutating tools return a
  compact a11y snapshot **diffed from the previous turn** — you see
  what changed without a follow-up read. See
  [docs/mcp.md](../../docs/mcp.md).
- **An error code you don't recognise** → read
  [docs/error-codes.md](../../docs/error-codes.md).

## Probing rule

When unsure a selector exists, check before acting. Today: call
`await locator.count()` (zero-wait, returns the current match count).
Acting on a hallucinated selector wastes the whole auto-wait budget.

For the **CLI and MCP**, the cheapest way to drive a page is to take a
snapshot first and use refs:

```
$ craftdriver snapshot
e4: textbox "Username" #username
e7: button "Sign in" #submit
$ craftdriver fill ref=e4 alice
$ craftdriver click ref=e7
```

`ref=eN` resolves to a CSS attribute selector, auto-waits like any
other selector, and re-allocates on every snapshot. No hallucination.

## Imports

Always `import { ... } from 'craftdriver'`. Never reach into
`craftdriver/src/lib/...` — internals are unstable.
