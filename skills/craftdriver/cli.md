# CraftDriver CLI for agent exploration

Use the CLI to learn the live page and exercise a flow. Use the TypeScript
library for committed tests.

## Safe setup

```bash
npm install --save-dev craftdriver
npx craftdriver init
npx craftdriver --help
```

The init command installs `.claude/skills/craftdriver/` (Claude Code, Copilot)
and `.agents/skills/craftdriver/` (Codex, Copilot). `--agent claude|codex`
narrows to one of those directories; `--agent copilot` uses
`.github/skills/craftdriver/`. It never reads or changes `AGENTS.md`,
`CLAUDE.md`, other assistant instructions, or any host's MCP configuration.
`--dry-run` previews the installation. `--mcp` only prints an optional
project-pinned MCP snippet. A later default `init` also reconciles an existing
CraftDriver-owned `.github/skills/craftdriver/` copy so it cannot become stale.

## Persistent browser

```bash
npx craftdriver go http://127.0.0.1:8080/login.html --browser chrome --headless --observe=delta
npx craftdriver daemon stop
```

The first ordinary command auto-starts the daemon when needed. `open <url>` is
an alias for `go <url>`. On the first call, `--observe=delta` returns the full
bounded snapshot, so no separate initial snapshot is needed. State, cookies,
and the active page survive between commands.

Agent sessions start at a 1280x800 desktop layout. Use
`go <url> --viewport WIDTHxHEIGHT` only when the task intentionally targets a
different responsive size.

For a mutation whose result determines the next step, append `--observe=page`
(URL/title/document identity) or `--observe=delta` (bounded semantic change
since the last observation). `documentChange` is `same`, `changed`, or
`unknown`; unknown means no preceding observed document exists. The default
stays compact and does not snapshot after every action.

The daemon uses a Unix socket and is not available on Windows. On Windows, or in
a sandbox that cannot keep a background process, use the configured MCP server
for a persistent agent session, or send the whole flow in one `--ephemeral`
script.

## Current commands

```text
go|open <url> [--observe=page|delta]
find <selector> [--all] [--limit N] [--offset N]
exists <selector>
click <selector> [--observe=page|delta]
dblclick <selector>
fill <selector> <value> [--submit] [--observe=page|delta]
type <text>
clear <selector>
check <selector> | uncheck <selector>
select <selector> <value>
focus <selector> | scroll <selector>
press <key> [selector]
hover <selector>
key press|down|up <key> [--selector S]
mouse move|click [selector] [--x N --y N] [--button left|middle|right]
mouse down|up [--button left|middle|right]
mouse wheel [selector] [--delta-x N] [--delta-y N]
dialog inspect | dialog accept [text] | dialog dismiss
upload <selector> <file> [file...]
text [selector] [--limit N]
attr <selector> <name>
value <selector>
is visible|enabled|checked <selector>
wait <selector> [--state visible|hidden|attached|detached] [--timeout ms]
wait load [--state load|domcontentloaded|networkidle]
pages
page list | open [url] | select <index|id> | close <index|id>
snapshot
locators <selector>
a11y [selector] [--min-impact minor|moderate|serious|critical]
     [--rules id,id] [--disable-rules id,id] [--limit N] [--nodes N]
     [--check]
screenshot [-o out.png] [--full-page] [--selector selector]
eval <javascript> [--observe=page|delta]
run < script.txt   (one command per line; see "Batching known commands")
back | forward | reload | status | quit
daemon start | status | stop
session list | close [name]
state save <name> [--session-storage] | load <name> | list
logs [list] [--kind console,error,request,response] [--level l]
     [--contains s] [--since N] [--limit N] | wait ... | clear
mock add <pattern> [--status N] [--body S] | block <pattern>
     | list | remove <id> | clear
trace start [name] [--no-screenshots] | stop [--zip] | status
```

## Batching known commands

`run` sends a whole script of already-known commands to the live session in one
process, one round trip. Measured on a five-step flow: 1.85 s as five
invocations, 0.54 s as one batch, with 237 ms of that actual browser work.

```bash
npx craftdriver run --session shopper <<'EOF'
fill '#nickname' mitko
check #newsletter
select #plan pro
click #save --observe=delta
EOF
```

Same script syntax as `--ephemeral`, against the daemon session rather than a
throwaway browser. The batch is one session queue slot, so nothing interleaves.
It stops at the first failed step and reports `failedStep` and `skipped`; pass
`--continue-on-error` only for genuinely independent probes. Every step returns
its own `ok`, `durationMs` and result. It returns one observation, not one per
step: put `--observe` on the last step — it is refused anywhere else — and
`--observe=delta` there accumulates what the earlier steps changed. A failed
step keeps its `recoverySnapshot`. Nothing is ever retried, healed, or
substituted.

Batch only what is already known. Return and look between steps whenever the
next selector comes from the previous step's delta, the flow crosses a
navigation or a wizard step, an intermediate result decides whether to continue,
or a fresh snapshot or ref is needed.

Exit status is 0 when every step passed, otherwise the status the first failing
step would have produced alone. A script that fails to parse exits 2 before
anything is started. `run` needs the daemon, so on Windows use the MCP
`browser_batch` tool instead.

## Named sessions

Add `--session <name>` to any command to run it against its own browser,
cookies, page selection, snapshot baseline and refs. Omitting the flag means
the session named `default`.

```bash
npx craftdriver go http://127.0.0.1:8080/login.html --session shopper
npx craftdriver go http://127.0.0.1:8080/admin.html  --session admin
npx craftdriver session list
npx craftdriver session close admin
```

Use this when one workflow needs two logged-in identities at once, not as a
default habit — each session is a real browser process and only 8 may be open
at a time. Sessions start on first use and run independently, so a slow
command in one does not block another.

**Refs are per-session.** `e4` in one session and `e4` in another are
different elements, and nothing will warn you if you mix them up. Run
`snapshot` and the commands that use its refs with the same `--session`.

`--session` is not available with `--ephemeral`, which is a single browser
that exits with the command.

`select` matches an `<option>` by its `value` attribute, not its label.

Use `fill <selector> <value>` to put a value in a field — it clears first and
delivers real key events, so fields with key handlers work. For a searchbox or
single-field form, add `--submit`: CraftDriver presses Enter through the focused
field without resolving the selector again, so a reactive rerender cannot stale
a sibling submit ref. If a separate sibling action is required, observe the
fill's delta and use its fresh ref. `type <text>` takes no selector and types
into whatever holds focus, mapping onto
`browser.keyboard.type()`; reach for `focus <selector>` then `type` only when
you need to append to existing text. `focus` leaves the caret at the end.

`eval` is a last resort for inspection, not a replacement for public test APIs.

## Selector syntax

CSS is the default. Prefix semantic selectors:

```text
role=button[name=Submit]   label=Email          testid=login-btn
text=Sign In              text*=Sign           placeholder=Search…
alt=Logo                  title=Help           xpath=//div[1]
id=submit                 name=email           tag=h1
```

Use `exists` as a zero-wait uniqueness probe and `find --all` to inspect
ambiguous matches.

## Tabs

Commands act on the active tab. A tab the application opens by itself is
listed by `page list` but is not selected, so nothing switches under you —
use `page select <index|id>` first. An unknown target is an error rather than
a fallback to the active tab. Switching, opening, or closing a tab clears
refs, so take a fresh `snapshot` afterwards.

## Console and network evidence

`logs` answers what the page logged and requested, after the fact — capture is
already running before your first command, so you never arrange it in advance
or re-run a flow to observe it.

Use it to check your work: after a click, `logs --kind error` tells you whether
the app threw, and `logs --kind request,response --contains /api/` shows what it
called. This is the evidence to cite when explaining a failure.

Ask for deltas, not dumps: every result carries a `cursor`; pass it back as
`--since` to get only what happened since. `logs wait --contains <text>` scans
what already arrived before waiting, so it resolves immediately when the event
has already happened.

History is bounded (500 entries / 512 KB, oldest evicted). Check `dropped` and
`droppedBeforeCursor` before concluding that nothing happened — a non-zero
`droppedBeforeCursor` means the page you asked for has a hole in it.

Network rows carry URL, method, status, MIME type and time only. No bodies,
cookies or headers — do not report them as if they were a full capture. URLs
include query strings, so avoid echoing sensitive query tokens into a report.

## Traces and mocking

`trace start <name>` … `trace stop --zip` records actions, console, network and
screenshots under `.craftdriver/traces/`. Reach for it when a failure is not
explicable from a snapshot — not by default, since it costs size and time.
One trace at a time; a second `start` is an error.

`mock add <pattern> --status N --body S` serves a fixed response and
`mock block <pattern>` fails matching requests, so you can drive error paths
without touching the application. `mock list` and `mock clear` manage them;
clear them when done, since they outlive the command that added them.

Only these flat shapes exist. The library's `network.intercept()` takes a
handler function that no command line can express — if you need dynamic
behaviour, write it in a test with the library API instead of asking for a
CLI flag that does not exist.

## Saved login state

`state save <name>` captures the current browser's cookies and local storage;
`state load <name>` puts them back. Use it so you log in once instead of
replaying the form for every exploration.

On Chrome/Chromium and Firefox BiDi, load before the first real navigation:
`state load <name>` → `go <url>`. Cookies plus all captured localStorage origins
are ready for the page's first script. If a page is already open, reload it
after the overlay.

Classic browsers (including Safari) require `go <url>` → `state load <name>` →
`reload`, and only a single matching origin is supported. State saved with
`--session-storage` also requires that active-page order because sessionStorage
is tab-scoped. Unsupported combinations fail before mutation rather than
silently restoring only cookies.

State files are credentials — cookies included. They live under
`.craftdriver/state/`, owner-only. Never print one, commit one, or paste its
contents into a test; pass a bare name (`alice`), never a path. `state save`
reports counts and origins only, and that is all you should report onward.

`state load` clears refs, so take a fresh `snapshot` after it.

## Reading a snapshot line

```text
e4: textbox "Username" value="alice" #username
e7: button "Sign in" #submit (disabled)
e9: text "Field 1 is required" #f1-error
```

`ref: role "accessible name"`, then whatever decides the next step:
`[level=N]` on headings, `href="…"` on links, `value="…"` on filled fields, a
locator hint (`#id`, `[data-testid=…]`, `tag[name=…]`), and state —
`(disabled)`, `(checked)`, `(selected)`, `(expanded=…)`, `(pressed=…)`,
`(current=…)`.

`text` lines are status and result evidence: `<output>`, `aria-live` regions,
captions, and short `<p>` whose id reads like `status`/`result`/`error`/
`message`. Long prose is deliberately excluded — read it with `text` when you
need it.

Structural containers are marked `(container)` and their semantic descendants
are indented. They are named only from an explicit `aria-label`, so a bare
`form (container) #login-form` is normal, not a missing name. Values of password, card,
one-time-code and conventionally named secret fields are never printed, so an
absent `value=` is not evidence that a field is empty — use `value <selector>`.

Anything under an `aria-hidden="true"` or `inert` ancestor is omitted, even
when visible on screen.

## Refs vs. durable locators

A `ref=eN` from `snapshot` names one element for as long as it lives. The CLI
also accepts bare `eN` when the session issued that ref; write `css=eN` to select
a literal `<eN>` element. A ref cannot drift onto a different element: if the
element is removed or duplicated, or the page navigates or reloads, the command
fails with `STALE_REF` and includes a bounded recovery snapshot when available.
Refs are never reused, so an old ref never matches a new page.

Refs are still exploration state and never belong in test code. To write a test,
turn the element into a durable selector and let CraftDriver check it against
the live page first:

```bash
npx craftdriver locators ref=e7
```

Each candidate is reported `unique`, `ambiguous`, or `missing`, ordered by
durability (role + name, label, test id, unique text, minimal CSS). Use one
reported `unique`. If none is, add a `data-testid` to the application rather
than committing a positional selector.

## Accessibility audits

Reach for this only when the task is about accessibility, WCAG, or screen-reader
behaviour. It is not part of the ordinary exploration loop.

`a11y [selector]` runs axe-core over the page, or one region. Every violation
node carries a `ref=eN`, so a finding is directly actionable — axe's own
`target` is a CSS path describing a position, not a handle.

```bash
npx craftdriver a11y                      # violation → ref=e4
npx craftdriver locators ref=e4           # ref → durable selector for the fix
npx craftdriver a11y --check              # re-run; exits 1 until it is clean
```

An element an earlier snapshot already reffed keeps that same ref. `a11y`
mirrors `browser.a11y.audit()` and exits `0` after reporting; `a11y --check`
mirrors `browser.a11y.check()` and exits `1` when findings exist. Both default
to all (`minor+`) violations, and `--min-impact` is their one shared threshold.
Check mode uses the whole audit, not the truncated view. Output is bounded by
`--limit` (violations) and `--nodes` (per violation) and sets `truncated` when
anything was dropped.

Refs from an audit are exploration state exactly like snapshot refs — convert
with `locators` before writing anything into a test. `locators` cannot yet
describe an element inside a shadow root, and violations inside iframes are
reported without a ref.

## Output and failures

- TTY output is concise text; piped output is JSON per line.
- `--json` and `--pretty` force the output format.
- Exit `0` is success, `1` is action/assertion/no-match failure, and `2` is
  invalid CLI usage.
- Errors carry the same stable codes as the public library.

Do not add sleeps. CLI actions already auto-wait, and `wait` expresses explicit
page conditions.
