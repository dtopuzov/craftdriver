---
name: craftdriver
description: Explore live web applications with the CraftDriver CLI, validate durable selectors, and write, run, and debug CraftDriver tests. Use when a coding agent needs to inspect a page, drive browser flows, choose locators, author browser automation, or diagnose a failing CraftDriver test.
---

# CraftDriver browser workflow

Use CraftDriver's CLI to inspect and exercise the running application, then use
the public TypeScript API to write and run durable tests. Chrome is the default
agent workflow.

## Core loop

```text
start app → navigate → snapshot → inspect → act → validate selector
          → write test → run focused test → debug from fresh evidence
```

Actions and `locator.expect().to…()` auto-wait. Do not add sleeps or hand-written
polling loops.

## Selector order

There is no universal best selector. Prefer the one that is at once the most
**stable** and the most **meaningful** — a semantic locator reads like intent
and doubles as an accessibility check, but only while the value it matches is
stable. From live-page evidence:

```text
1. By.role({ name }) / By.labelText / By.text   — when the name is a STABLE label
2. name is dynamic or the app is translated     → drop the name; anchor on a
   stable id/attribute (By.testId only if the app already has one)
3. By.role (no name) / By.labelText              — stable even as values change
4. stable By.css (real id / semantic class)
5. By.text                                       — mostly for assertions
6. By.xpath                                      — last resort
```

**Never hardcode a localized or dynamic accessible name.** `By.role('button',
{ name: 'Count is 0' })` breaks on the next click; `{ name: 'Save' }` breaks when
the page renders in another language. `name` is a string, not a RegExp — for
fuzzy matching use `{ exact: false }`; for dynamic/localized text use a stable id
or test id. `data-testid` is an escape hatch, not a default: use it when the app
already ships test ids, not ahead of a stable semantic locator.

Confirm a selector against the live page with `craftdriver exists` or
`craftdriver find` before putting it in a test.

## Snapshot refs are exploration-only

CLI snapshots show `ref=eN`. A ref binds to one element for as long as that
element lives, and is never reassigned to another one: if the element is removed
or duplicated, or the page navigates or reloads, the command fails with
`STALE_REF`. Take a fresh snapshot when that happens — CraftDriver will not
guess a replacement.

A ref still means nothing outside the current session, so never copy one into
test source. Convert the element into a durable locator and let CraftDriver
check it against the live page:

```bash
npx craftdriver locators ref=e7
```

Use the candidate reported `best` (the first `unique` one, ordered by the
stability rule above). The ranker demotes a role/name whose accessible name
looks dynamic below a stable anchor and adds a `note` — heed it: if you also
watched the name change while exploring, treat it as dynamic and pick the stable
candidate. If nothing resolves uniquely, add a `data-testid` to the application
instead of committing a positional selector.

## Test rules

1. Inspect the repository's existing tests and package scripts before choosing
   a test location or command.
2. Import only from `craftdriver`, never from `craftdriver/src/...`.
3. Use public locators and `locator.expect()` / `browser.expect(selector)`
   assertions. There is no top-level `expect` export.
4. Read failures by stable `CraftdriverError.code`, then gather a fresh
   snapshot and focused page evidence.
5. Make ordinary reviewable source changes. Never hide a failure with runtime
   locator repair.
6. Always close the browser in `finally` or the repository's existing fixture.

## Focused references

- Explore and write a test: [workflow.md](workflow.md)
- Shell commands: [cli.md](cli.md)
- TypeScript API cheatsheet: [cheatsheet.md](cheatsheet.md)
- Worked library recipes: [patterns.md](patterns.md)
- Full installed package docs: `node_modules/craftdriver/docs/`
- Optional MCP adapter: `node_modules/craftdriver/docs/mcp.md`
