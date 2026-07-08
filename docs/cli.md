# Command-line interface

`craftdriver` ships with a CLI binary that wraps the library for
**shell scripts, ad-hoc exploration, and AI agents** (Copilot, Claude
Code, Cursor, Codex, Gemini CLI, Goose, OpenCode, …).

```bash
npm install craftdriver
npx craftdriver --help
```

The CLI uses the same Browser API as the library, so anything you can
script in TypeScript you can also drive from `bash` — but the CLI tunes
defaults for **fast, fail-fast probing** instead of stable test runs.

## Quick start

Two-terminal workflow:

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

Each call opens a fresh connection to the daemon and exits — but the
**browser, page, and cookies all persist** between calls. That makes
the CLI feel like a REPL for the browser.

If you don't want a daemon (sandboxed cloud agents, one-shot scripts),
pipe a script through `--ephemeral` and the CLI launches a short-lived
browser for the whole script:

```bash
printf 'go http://127.0.0.1:8080/login.html
fill "#username" alice
fill "#password" hunter2
click "button[type=submit]"
text "#result"
' | npx craftdriver --ephemeral
```

## Commands

```
craftdriver go <url>
craftdriver find <selector> [--all] [--limit N] [--offset M]
craftdriver click <selector>
craftdriver fill <selector> <value>
craftdriver press <key> [selector]
craftdriver hover <selector>

craftdriver text [selector] [--limit N]
craftdriver attr <selector> <name>
craftdriver value <selector>
craftdriver is visible|enabled|checked <selector>

craftdriver wait <selector> [--state visible|hidden|attached|detached] [--timeout ms]
craftdriver wait load [--state load|domcontentloaded|networkidle]
craftdriver exists <selector>          # 0-wait probe; exit 0 if any match

craftdriver pages
craftdriver snapshot                   # sanitized DOM summary with refs
craftdriver screenshot [-o file.png] [--full-page] [--selector S]
craftdriver eval <js>                  # last resort
craftdriver back | forward | reload | status | quit

craftdriver daemon start|status|stop
```

Run `craftdriver --help` for the full list.

## Selector syntax

CSS is the default. Switch kind with a `prefix=value` form:

| Prefix         | Maps to                                 | Example                          |
| -------------- | --------------------------------------- | -------------------------------- |
| _none_, `css=` | `By.css`                                | `'.product-list li'`             |
| `xpath=`       | `By.xpath`                              | `'xpath=//button[1]'`            |
| `role=`        | `By.role` (+ `[name=...]` for the name) | `'role=button[name=Submit]'`     |
| `text=`        | `By.text` (exact)                       | `'text=Sign In'`                 |
| `text*=`       | `By.partialText`                        | `'text*=Sign'`                   |
| `label=`       | `By.labelText`                          | `'label=Email'`                  |
| `placeholder=` | `By.placeholder`                        | `'placeholder=name@example.com'` |
| `alt=`         | `By.altText`                            | `'alt=Logo'`                     |
| `title=`       | `By.title`                              | `'title=Help'`                   |
| `testid=`      | `By.testId`                             | `'testid=login-btn'`             |
| `id=`          | `By.id`                                 | `'id=submit'`                    |
| `name=`        | `By.name`                               | `'name=email'`                   |
| `ref=`         | snapshot ref (`craftdriver snapshot`)   | `'ref=e5'`                       |

Anything else is treated as a CSS selector, so attribute selectors with
`=` inside (e.g. `'button[type=submit]'`) work as expected.

## Snapshot — sanitized DOM with refs

`craftdriver snapshot` returns one line per visible interactive element
on the active page, with a stable ref (`e1`, `e2`, …) that you can
use as a selector for the next command:

```bash
$ craftdriver snapshot
page: Login — http://127.0.0.1:8080/login.html
e1: heading "Login"
e2: form "Username Password Sign in" #login-form
e3: label "Username"
e4: textbox "Username" #username
e5: label "Password"
e6: textbox "Password" #password
e7: button "Sign in" #submit

$ craftdriver fill ref=e4 alice
$ craftdriver fill ref=e6 hunter2
$ craftdriver click ref=e7
```

Refs are recomputed on every `snapshot` call and invalidated on
navigation. A stale ref just returns `NO_MATCH` — take a fresh
snapshot.

Internally `ref=eN` resolves to a CSS attribute selector
(`[data-craftdriver-ref="eN"]`); auto-waiting works unchanged.

## Output: pretty on a TTY, JSON when piped

- TTY: human-readable text, one line per result for `find` / `pages`.
- Piped or redirected: `{ "ok": true, "result": … }` per line.
- Force either with `--json` or `--pretty`.

Errors carry the same machine-readable `code` field as the library, plus
an optional one-line `hint:`. See [error-codes.md](./error-codes.md).

```bash
$ npx craftdriver find '#nope'
error: find: no element matches css selector=#nope
code:  NO_MATCH
```

## Exit codes

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| `0`  | success (or `exists` matched at least one element)                |
| `1`  | assertion / timeout / `NO_MATCH` / `exists` matched zero elements |
| `2`  | usage error (missing argument, unknown command)                   |

## Fail-fast defaults

The library auto-waits up to **30 s** because tests want stability. The
CLI lowers that to **5 s** because agents probe with guesses and should
learn from failures fast.

- Override per call with `--timeout <ms>`.
- Override globally with `CRAFTDRIVER_AGENT_TIMEOUT=2000`.
- Use `exists` as a 0-wait probe before `click` / `wait` when you're not
  sure a selector matches.

## Daemon details

- Socket: `~/.craftdriver/sock` (override with `CRAFTDRIVER_SOCKET`).
- PID file: `~/.craftdriver/pid` (override with `CRAFTDRIVER_PID`).
- Wire: line-delimited JSON, one request per connection.
- First request after `daemon start` triggers the browser launch; later
  requests reuse the same browser, page and cookies.
- `craftdriver daemon status` reports PID + active page URL.
- `craftdriver daemon stop` cleans up the socket and PID file.

The CLI also auto-starts a daemon for you on the first command if none
is running — `daemon start` is only required when you want to control
the timing (or to choose a non-default browser):

```bash
npx craftdriver daemon start --browser firefox
```

## When to use the CLI vs. the library

- **Library** — write a test suite. Stable, 30 s auto-waits, full TS
  types, runs under vitest / jest / playwright-test.
- **CLI** — exploration, debugging, agent-driven loops, REPL-style
  poking at a real page from your shell.

Both share the same underlying Browser API and the same error codes, so
findings transfer directly between the two.

## Teach your AI assistant (`craftdriver init`)

For every supported assistant, the CLI can drop an opinionated rules
file into the **current project** so the assistant picks up
craftdriver conventions (selector preference, auto-waiting, error
codes, CLI usage) on every turn:

```bash
npx craftdriver init copilot   # .github/copilot-instructions.md
npx craftdriver init claude    # CLAUDE.md
npx craftdriver init cursor    # .cursor/rules/craftdriver.mdc
npx craftdriver init gemini    # GEMINI.md
npx craftdriver init agents    # AGENTS.md (Codex, OpenCode, Aider, Amp, Cursor)
npx craftdriver init all       # every file above
```

Files are per-project (commit them to git so the team's agents share
the rules). Pre-existing files are skipped unless you pass `--force`;
use `--dry-run` to see what would be written. The body is identical
across flavors, only the file name and any tool-specific header
(e.g. Cursor's `.mdc` frontmatter) differ.

## Skill pack

For agents that load skills explicitly (Claude Code's Skills system,
Copilot agent customization, custom orchestrators), the npm tarball
ships a tiered skill pack under `skills/craftdriver/`:

| File                                                                                                  | Purpose                                                               |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`SKILL.md`](https://github.com/dtopuzov/craftdriver/blob/main/skills/craftdriver/SKILL.md)           | Always-on, ≤ 500 tokens. Selector order, error-code-first, auto-wait. |
| [`cheatsheet.md`](https://github.com/dtopuzov/craftdriver/blob/main/skills/craftdriver/cheatsheet.md) | Command-by-command reference for writing tests.                       |
| [`patterns.md`](https://github.com/dtopuzov/craftdriver/blob/main/skills/craftdriver/patterns.md)     | Worked recipes (login, upload, network-wait, a11y, tracing, clock).   |
| [`cli.md`](https://github.com/dtopuzov/craftdriver/blob/main/skills/craftdriver/cli.md)               | Agent-facing CLI reference.                                           |

Point your agent at `node_modules/craftdriver/skills/craftdriver/SKILL.md`
or copy it into your project. The other files are referenced from
`SKILL.md` and loaded on demand.
