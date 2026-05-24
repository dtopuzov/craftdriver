# craftdriver CLI

The `craftdriver` binary is what you reach for from a **shell**, not from
TypeScript. Use it for probing, debugging, and agent-driven exploration.

## Install once

```bash
npm install craftdriver
npx craftdriver --help
```

## Daemon model (preferred)

Long-lived browser; each command is a one-shot RPC. State (page,
cookies, storage) survives between calls.

```bash
npx craftdriver daemon start
npx craftdriver go http://127.0.0.1:8080/login.html
npx craftdriver click 'button[type=submit]'
npx craftdriver daemon stop
```

If no daemon is running, the first command auto-starts one. Use
`daemon start` explicitly when you want a non-default browser
(`--browser firefox`) or a specific timing.

## Ephemeral mode (sandboxed agents)

```bash
printf 'go http://127.0.0.1:8080/login.html
fill "#user" alice
click "button[type=submit]"
text "#result"
' | npx craftdriver --ephemeral
```

One short-lived browser for the whole script. No daemon, no socket.

## Commands you actually use

```
go <url>                navigate active page
find <sel> [--all]      first match (or all); pretty-prints index + tag + text
exists <sel>            0-wait probe; exit 0 = match, exit 1 = none
click <sel>
fill <sel> <value>
press <key> [sel]
hover <sel>
text [sel]              page text or element text
attr <sel> <name>
value <sel>
is visible|enabled|checked <sel>
wait <sel> [--state visible|hidden|attached|detached] [--timeout ms]
wait load [--state load|domcontentloaded|networkidle]
pages
screenshot [-o out.png] [--full-page] [--selector sel]
eval <js>               last resort
back | forward | reload | status | quit
daemon start|status|stop
```

## Selector syntax

CSS by default. Switch kind with `prefix=value`:

```
role=button[name=Submit]   text=Sign In            text*=Sign
label=Email                placeholder=Search…     testid=login-btn
alt=Logo                   title=Help              xpath=//div[1]
id=submit                  name=email              tag=h1
```

Anything else (including CSS attribute selectors like
`button[type=submit]`) is parsed as CSS.

## Output

- TTY → human-readable text.
- Piped or redirected → `{"ok":true,"result":…}` per line.
- Force with `--json` or `--pretty`.
- Errors include a stable `code:` line (same codes as the library
  — see `docs/error-codes.md`). Use the code, not the prose.

## Exit codes

- `0` success (or `exists` matched ≥ 1)
- `1` assertion / timeout / `NO_MATCH` / `exists` matched zero
- `2` usage error

## Defaults

- 5 s per-call timeout (override with `--timeout ms` or
  `CRAFTDRIVER_AGENT_TIMEOUT`).
- Probe with `exists` before `click`/`wait` when you're guessing.
- Don't `sleep`. `wait <sel>` is auto-waiting; `wait load` waits on
  document state.

## When NOT to use the CLI

Writing a test suite. Use the library (`import { Browser } from
'craftdriver'`) — it has 30 s default timeouts, full TS types, and
chainable `Locator` ergonomics.
