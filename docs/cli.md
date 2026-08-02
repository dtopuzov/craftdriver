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

One-terminal browser workflow (run the application separately if needed):

```bash
# the first command starts the daemon and returns refs in its snapshot
npx craftdriver go http://127.0.0.1:8080/login.html --browser chrome --headless --observe=delta
npx craftdriver fill ref=e4 alice
npx craftdriver fill ref=e6 hunter2 --submit --observe=delta

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
fill "#password" hunter2 --submit --observe=delta
text "#result"
' | npx craftdriver --ephemeral
```

## Commands

```
craftdriver go|open <url> [--observe=page|delta]
craftdriver find <selector> [--all] [--limit N] [--offset M]
craftdriver click <selector> [--observe=page|delta]
craftdriver dblclick <selector>
craftdriver fill <selector> <value> [--submit] [--observe=page|delta]
                                       # clear, enter, optionally press Enter
craftdriver type <text>                # type into the focused element
craftdriver clear <selector>
craftdriver check <selector> | craftdriver uncheck <selector>
craftdriver select <selector> <value>  # <option> by its value attribute
craftdriver focus <selector>           # caret to end, ready to type
craftdriver scroll <selector>
craftdriver press <key> [selector]
craftdriver hover <selector>

craftdriver key press|down|up <key> [--selector S]
craftdriver mouse move|click [selector] [--x N --y N] [--button b]
craftdriver mouse down|up [--button left|middle|right]
craftdriver mouse wheel [selector] [--delta-x N] [--delta-y N]
craftdriver dialog inspect | craftdriver dialog accept [text] | craftdriver dialog dismiss
craftdriver upload <selector> <file> [file...]

craftdriver text [selector] [--limit N]
craftdriver attr <selector> <name>
craftdriver value <selector>
craftdriver is visible|enabled|checked <selector>

craftdriver wait <selector> [--state visible|hidden|attached|detached] [--timeout ms]
craftdriver wait load [--state load|domcontentloaded|networkidle]
craftdriver exists <selector>          # 0-wait probe; exit 0 if any match

craftdriver pages
craftdriver page list                  # open tabs, marking the active one
craftdriver page open [url]            # open a tab and select it
craftdriver page select <index|id>     # send later commands to that tab
craftdriver page close <index|id>
craftdriver snapshot                   # sanitized DOM summary with refs
craftdriver locators <selector>        # durable selectors, live-validated
craftdriver a11y [selector] [--min-impact minor|moderate|serious|critical]
                 [--rules id,id] [--disable-rules id,id]
                 [--limit N] [--nodes N] [--check]
                                       # axe-core audit; violation nodes
                                       # carry refs
craftdriver screenshot [-o file.png] [--full-page] [--selector S]
                                       # without -o, lands in
                                       # .craftdriver/screenshots as
                                       # screenshot-<session>.png (overwritten)
craftdriver eval <js> [--observe=page|delta]  # last resort
craftdriver back | forward | reload | status | quit

craftdriver logs [list] [--kind console,error,request,response] [--level error]
                       [--contains text] [--since N] [--limit N]
craftdriver logs wait --contains <text> [--kind k] [--timeout ms]
craftdriver logs clear
craftdriver mock add <pattern> [--status N] [--body S] [--content-type T]
craftdriver mock block <pattern>
craftdriver mock list | craftdriver mock remove <id> | craftdriver mock clear
craftdriver trace start [name] [--no-screenshots]
craftdriver trace stop [--zip]         # then open the NDJSON or zip
craftdriver trace status
craftdriver state save <name> [--session-storage]
craftdriver state load <name>          # load before navigation on BiDi
craftdriver state list

craftdriver daemon start|status|stop
craftdriver session list               # open sessions and the limit
craftdriver session close [name]       # quit one session's browser

craftdriver init [--agent claude|codex|copilot|all] [--dry-run] [--mcp]
craftdriver mcp                        # speak MCP on stdio
```

That is every command. Global flags are:

```text
--browser chrome|chromium|firefox|safari   which browser to launch
--headless | --headed                      override the default
--session <name>                           route to a named browser
--ephemeral                                one browser for one script on stdin
--timeout <ms>                             per-command wait (default 5000)
--json | --pretty                          force output format
--help | --version
```

`--limit` and `--offset` are command-specific pagination flags where shown
above; they are rejected by commands that do not return lists.

CLI agent sessions start at a 1280x800 desktop layout so responsive pages expose
their primary controls. `go URL --viewport WIDTHxHEIGHT` overrides it before
that navigation when the task intentionally targets another responsive size.

`--observe=page` returns URL, title, document identity, revision, and
`documentChange` after a mutation. The state is `same`, `changed`, or `unknown`;
`unknown` means there was no preceding observed document and must not be treated
as `same`. `--observe=delta` returns the bounded semantic change since the last
observation. If intervening actions intentionally skipped observation, their
visible changes can appear in that delta too. The equivalent space-separated
forms are also accepted. Both capture the action and observation in one session
queue slot; without the flag, action results stay compact and no post-action
snapshot is taken.

For searchboxes and single-field forms, `fill TARGET VALUE --submit` fills and
presses Enter through the focused field without resolving `TARGET` again. This
keeps submission atomic when a reactive fill replaces the input or its sibling
button. If the flow genuinely needs a separate sibling action, use
`fill TARGET VALUE --observe=delta` and take the sibling's fresh ref from that
delta.

For a conventional multi-field form, fill the earlier fields normally and add
`--submit` to the final single-line field. Use `--observe=delta` when the
resulting validation message or state determines the next step. Do not use this
pattern for textareas, multi-step wizards, or flows that require a specific
secondary action.

Observed `fill --submit` and `press Enter` actions use a bounded navigation
fence: they detect navigation that starts within about 140 ms after the input
command returns, then wait at most 500 ms for its load. These bounds are
independent of `--timeout`, so a same-page validation does not add seconds to
every Enter. Navigation started later by application code can therefore land
after the observation; wait for a destination-specific selector when a flow
performs asynchronous validation before navigating. Ordinary `click` relies on
WebDriver's own navigation wait and does not add this extra fence, so the same
explicit wait applies to navigation scheduled only after the click command has
already completed.

After a predictable navigation, `--observe=page` plus targeted `text`, `attr`,
or `value` reads is usually the smallest evidence path. Use `--observe=delta`
when the next action depends on discovering what changed.

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

Except for a bare live snapshot ref described below, anything else is treated
as a CSS selector, so attribute selectors with `=` inside (e.g.
`'button[type=submit]'`) work as expected.

## Snapshot — sanitized DOM with refs

`craftdriver snapshot` returns visible semantic elements on the active page,
with a stable ref (`e1`, `e2`, …) that you can use as a selector for the next
command. Open Shadow DOM is traversed recursively and shown with indented
`#shadow-root (open)` boundaries; closed roots are never inspected:

```bash
$ craftdriver snapshot
page: Craftdriver Login Example — http://127.0.0.1:8080/login.html
e1: heading "Login" [level=1]
e2: form (container) #login-form
  e3: label "Username"
  e4: textbox "Username" #username
  e5: label "Password"
  e6: input "Password" #password
  e7: button "Sign in" #submit

$ craftdriver fill ref=e4 alice
$ craftdriver fill ref=e6 hunter2 --submit --observe=delta
```

Each line is `ref: role "accessible name"`, then whatever helps you pick the
next step: `[level=N]` on headings, `href="…"` on links, `value="…"` on filled
fields, a locator hint (`#id`, `[data-testid=…]`, `tag[name=…]`), and state
flags — `(disabled)`, `(checked)`, `(selected)`, `(expanded=…)`,
`(pressed=…)`, `(current=…)`.

Structural containers (`form`, `main`, `navigation`, `region`, `list`, `table`, …)
are marked `(container)`, and their semantic descendants are indented. They are
named only from an explicit `aria-label`/`aria-labelledby`, never from their
descendants' text — so `e2` above is `form (container) #login-form`, not a form
named `"Username Password Sign in"`.

Status and result text appears too, as `text` lines: `<output>`, `aria-live`
regions, `<caption>`/`<figcaption>`, and short `<p>` elements whose
`id`/`data-testid` reads like evidence (`status`, `result`, `error`,
`message`, `success`, `log`, …). Long prose is left out — read it with
`craftdriver text` when you actually need it.

Anything hidden from assistive technology is hidden here too: an element under
an `aria-hidden="true"` or `inert` ancestor never appears, even when it is
on screen and clickable.

Output is bounded independently at 80 semantic nodes, 7 ordinary text nodes,
and 10 status/result evidence nodes, with 80 characters per name, value, and
link destination, so page prose or a generated URL cannot crowd out the
controls or validation evidence. Read a complete link with `attr TARGET href`.

In a terminal this prints as shown; piped or redirected it emits JSON
(`--json` and `--pretty` force either form).

### Refs bind to an element, not to a position

A ref names one specific element for as long as that element lives:

- a node that survives a DOM change keeps its ref across snapshots;
- a new node always gets a fresh number — refs are never reused, not even
  after a navigation;
- if the element is removed, or the page navigates or
  reloads, the ref fails with `STALE_REF` instead of resolving to
  whatever now sits in that position.

That last point is the reason to trust them. Take a fresh `snapshot`
when you see `STALE_REF` without an attached `recoverySnapshot`; craftdriver
will not guess a replacement or retry the action.
`error.detail.reason` says which case fired (`detached`,
`document-changed`, `unknown-ref`, `ambiguous`, `no-snapshot`).

For copy-paste convenience, a bare token such as `e9` resolves as that ref when
the current session previously issued it. An unknown bare ref-shaped token
fails immediately with `BARE_REF` instead of waiting on CSS. Use `css=e9` to
select a literal `<e9>` element.

Internally `ref=eN` returns the exact element from the page's identity registry,
including elements inside open shadow roots. The diagnostic
`data-craftdriver-ref` attribute is never used for lookup or uniqueness, so an
authored or cloned marker cannot redirect or invalidate a ref. Auto-waiting and
native WebDriver actions work unchanged after identity resolution.

### Field values in snapshots

Snapshots print `value="…"` for ordinary text fields so you can confirm what
was typed without a second command. Never printed:

- `password`, `hidden` and `file` inputs;
- `checkbox`, `radio`, `submit`, `button`, `reset` and `image` inputs, whose
  `value` is a constant like `"on"` or a copy of the button label;
- fields whose `autocomplete` is `one-time-code`, `current-password`,
  `new-password`, or any `cc-*` token;
- fields whose id, name, placeholder, `aria-label`, or accessible name reads
  like a secret — `password`, `otp`, `token`, `secret`, `api key`,
  `access key`, `credit card`, `card number`, `cvv`, `cvc`, `security code`.

This is **best-effort noise and exposure reduction, not a classifier**. It
recognises conventional naming; it cannot know that `#field7` holds a session
key. Use test credentials, and don't point an agent-driven browser at an
account whose secrets you would not want in a transcript.

## Tabs

Commands act on one tab — the active one. A tab that opens on its own
(`window.open`, `target=_blank`) is listed but is _not_ selected, so nothing
switches under you:

```bash
$ craftdriver page list
[0] http://127.0.0.1:8080/checkout.html  —  Checkout   (active)
[1] http://127.0.0.1:8080/help.html      —  Help

$ craftdriver page select 1
$ craftdriver text h1        # reads the help tab
```

Select by index or by the id from `page list`. An unknown id or an
out-of-range index is an error rather than a fallback to the active tab —
acting on the wrong tab is the confusion this exists to remove.

Selecting, opening, or closing a tab clears the ref registry, so a ref from
the previous tab fails `STALE_REF` instead of resolving against the new
document. Take a fresh `snapshot` after switching.

## Locators — durable selectors for a test

Refs are for exploring a live page. Never put one in a committed test:
it means nothing in a later session. `craftdriver locators` turns an
element into selectors that do survive, and re-resolves each one against
the current page before offering it:

```bash
$ craftdriver locators ref=e7
best: role=button[name=Sign in]
✓ role=button[name=Sign in]
    By.role('button', { name: "Sign in" })
✓ testid=login-btn
    By.testId("login-btn")
~ text=Sign in  (3 matches)
    By.text("Sign in")
```

`✓` unique, `~` ambiguous, `✗` no longer matches. Candidates are ordered
by durability: role + accessible name, associated label, test id, unique
text, then minimal CSS. Obviously generated ids (`#a1b2c3d4e5f6`) are
never offered as CSS candidates — they look stable and are not.

If nothing resolves uniquely, that is reported rather than papered over;
the fix is a `data-testid` in the application, not a cleverer selector.

## Accessibility — audit, then fix

`craftdriver a11y` runs [axe-core](https://github.com/dequelabs/axe-core) over
the page, or over one region if you pass a selector. axe ships with craftdriver;
there is nothing to install.

```bash
$ craftdriver a11y
4 violations at minor+ (24 passes, 0 incomplete)

✗ button-name (critical) · WCAG 2.0 A · 4.1.2
    Buttons must have discernible text
    https://dequeuniversity.com/rules/axe/4.12/button-name
    ref=e5  <button id="nameless"></button>

✗ image-alt (critical) · WCAG 2.0 A · 1.1.1
    Images must have alternative text
    https://dequeuniversity.com/rules/axe/4.12/image-alt
    ref=e4  <img id="no-alt" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
```

The `ref=eN` on each node is the difference between a report and a fix. axe
itself hands back a CSS *path* — `div > p:nth-child(3)` — which describes where
the element sat, not which element it is. A ref is the same handle `snapshot`
issues, so the loop closes with commands you already have:

```bash
craftdriver a11y                       # violation → ref=e4
craftdriver locators ref=e4            # ref → #no-alt, live-validated
#   … add alt="…" in the source, reload …
craftdriver a11y --check               # re-run; exits 0 when clean
```

An element the snapshot already listed keeps the ref it already had — an audit
never issues a second number for the same node. Elements the snapshot leaves
out (images, long prose, headings — most violations, in practice) get one
minted on the spot. The usual rule is unchanged: **a ref is live-session state
and never belongs in committed source.** Run `locators` first.

| Flag                    | Effect                                                                  |
| ----------------------- | ----------------------------------------------------------------------- |
| `--min-impact`          | Lowest impact reported or checked. Default `minor` (all violations).    |
| `--rules id,id`         | Run only these axe rules.                                               |
| `--disable-rules id,id` | Skip these. Mutually exclusive with `--rules`.                          |
| `--limit N`             | Violations reported. Default 20.                                        |
| `--nodes N`             | Nodes per violation. Default 3.                                         |
| `--check`               | Return a pass/fail verdict and exit 1 when a reported violation exists. |

Output is bounded by default — a raw axe report on a real page is thousands of
tokens — and `truncated` says when something was dropped. Check mode uses the
whole audit, not the truncated view, so a small `--limit` cannot turn a failed
verification green.

Without `--check`, `a11y` exits **0** even with violations: it is a report, and
a non-zero status would break `craftdriver a11y | jq` and read as "the command
is broken". Add `--check` to verify; combine it with `--min-impact serious` when
the project deliberately gates only serious and critical findings.

`PASS` means axe found no violations at that threshold. The `incomplete` count
still names checks that need manual review; like `A11y.check()`, it does not
turn the automated verdict into a failure.

Two limits worth knowing:

- A violation inside an **open shadow root** gets a ref and works as a selector,
  but `locators` cannot yet propose a durable selector across a shadow
  boundary — it reports `element not readable`. Use the component's own test id.
- Violations inside **iframes** are reported without a ref. Resolving an
  iframe-scoped selector against the top document could match a different
  element, and a ref that points somewhere the agent never looked is worse than
  no ref at all.

Rule IDs, WCAG mapping, and how to manage known violations are in
[accessibility.md](./accessibility.md).

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

| Code | Meaning                                                                          |
| ---- | -------------------------------------------------------------------------------- |
| `0`  | success (or `exists` matched at least one element, or an `a11y` report)          |
| `1`  | assertion / timeout / `NO_MATCH` / `exists` matched zero / failed `a11y --check` |
| `2`  | usage error (missing argument, unknown command)                                  |

## Fail-fast defaults

The library auto-waits up to **30 s** because tests want stability. The
CLI lowers that to **5 s** because agents probe with guesses and should
learn from failures fast.

- Override per call with `--timeout <ms>`.
- Override globally with `CRAFTDRIVER_AGENT_TIMEOUT=2000`.
- Use `exists` as a 0-wait probe before `click` / `wait` when you're not
  sure a selector matches.

## Named sessions

One daemon, several independent browsers. Pass `--session <name>` and the
command runs against that session's own browser, page selection, cookies,
snapshot baseline and refs:

```bash
npx craftdriver go http://127.0.0.1:8080/login.html --session shopper
npx craftdriver go http://127.0.0.1:8080/login.html --session admin

# separate browsers, so separate logins
npx craftdriver fill '#username' alice --session shopper
npx craftdriver fill '#username' root  --session admin

npx craftdriver session list
npx craftdriver session close admin
```

Commands with no `--session` use the session named `default`, which is why
everything above still works if you never pass the flag.

Worth knowing:

- **Sessions are created on first use.** Naming one costs nothing until a
  command actually needs a browser.
- **They run independently.** Each session has its own FIFO queue, so a
  slow command in one does not hold up another.
- **Up to 8 at a time**, because each is a real browser process. Past that,
  creating a new one fails and tells you which are open rather than
  quietly quitting someone else's browser. `session close <name>` frees a
  slot; `craftdriver quit --session <name>` just closes that session's
  browser and keeps the slot.
- **A ref belongs to the session that issued it.** `e4` in one session and
  `e4` in another are different elements, and craftdriver cannot tell you
  that you mixed them up — it sees a valid ref either way. Keep `snapshot`
  and the commands that spend its refs on the same `--session`.
- **Names** are 1–32 characters of letters, digits, `-` and `_`, starting
  with a letter or digit. Anything else is rejected before a socket is
  opened.
- **Not available with `--ephemeral`**, which is one browser that exits
  with the command; a name there would promise a continuity that does not
  exist, so the combination is an error rather than a no-op.

## Console and network history

What the page logged and requested, asked for _after_ the fact:

```bash
npx craftdriver go http://127.0.0.1:8080/checkout.html
npx craftdriver click '#pay'

npx craftdriver logs --kind error           # exceptions + console.error
npx craftdriver logs --kind request,response --contains /api/
npx craftdriver logs wait --contains 'payment ok' --timeout 10000
```

Capture starts when the browser starts, not when you ask — so an error thrown
during the first navigation is still there when you go looking. You do not
arrange capture in advance, and you do not re-run the flow with a listener
attached.

Worth knowing:

- **`--kind error` means both** an uncaught exception and a `console.error`.
  They are recorded as different entries, but a caller asking for errors wants
  each of them, and an empty answer on a page that loudly logged one would be
  the most misleading result on offer.
- **Ask "what changed since", not "what happened".** Every entry has a
  monotonic `seq`, and each result carries a `cursor`. Pass it back as
  `--since` and you get only what is new:

  ```bash
  CURSOR=$(npx craftdriver logs --json | jq .result.cursor)
  npx craftdriver click '#submit'
  npx craftdriver logs --since "$CURSOR"
  ```

- **`logs wait` checks what already arrived before it waits.** By the time an
  agent asks, the event has usually already happened; a wait that only
  subscribed would time out on the common case. It waits only if the entry is
  not already there.
- **History is bounded and eviction is counted.** 500 entries or 512 KB,
  oldest first. The result reports `dropped`, and `droppedBeforeCursor` is
  non-zero when the page you asked for has a hole — so "no errors" and "the
  errors scrolled off" never look alike.
- **Network rows are summaries, not captures.** URL, method, status, MIME type
  and time. No bodies, no cookies, no headers of any kind — a journal an agent
  pastes into a transcript cannot carry an `Authorization` header. URLs are
  kept whole, including query strings, so a query token can still enter a
  CLI/MCP transcript when logs are requested. The journal is memory-only; use
  `logs clear` after inspecting sensitive development traffic.
- **Responses are attributed browser-wide.** The response event carries no
  browsing context, so only requests report a page. That is the protocol's
  limit, reported honestly rather than guessed.
- **Requires BiDi**, which Chrome and Firefox negotiate by default. Where it is
  unavailable the result says `capturing: false` rather than returning an empty
  list that reads like a quiet page.

## Traces and network mocking

A trace records actions, console output, network events and screenshots to a
file you can read afterwards — useful when a failure is not reproducible by
staring at the page:

```bash
npx craftdriver trace start checkout
npx craftdriver go http://127.0.0.1:8080/checkout.html
npx craftdriver click '#pay'
npx craftdriver trace stop --zip
```

Output lands under `.craftdriver/traces/<name>/` (override with
`CRAFTDRIVER_TRACE_DIR`): `trace.ndjson` plus a `screenshots/` directory.
`--zip` also writes a Vibium/Playwright-compatible archive. `--no-screenshots`
turns off the bulk of the size when you only want the event log.

Only one trace records at a time; starting a second is an error rather than a
silent replacement. Quitting the browser aborts a running trace, so an
abandoned session leaves nothing dangling.

Mocking covers the two rule shapes that are expressible as data:

```bash
npx craftdriver mock add '**/api/orders*' --status 500 --body '{"error":"nope"}'
npx craftdriver mock block '**/analytics/**'
npx craftdriver mock list
npx craftdriver mock clear
```

Worth knowing:

- **`mock add` replies; `mock block` fails the request.** Both take a URL
  pattern, and both return an id you can `mock remove`.
- **Everything is validated before installation.** A bad status or an
  oversized body is refused up front — a mock installed wrong surfaces much
  later as an unexplained page error, which is far harder to diagnose.
- **Up to 20 active at once**, each bounded to a 64 KB body. craftdriver is
  not a fixture server; mock the one call you are testing.
- **No handler functions.** The library's `network.intercept()` takes a
  callback, which a command line cannot express. Rather than invent a rule
  language, the CLI offers only the flat cases — reach for the library API when
  you need dynamic behaviour.
- **Requires BiDi**, and says so with `UNSUPPORTED` rather than silently doing
  nothing.

## Saved login state

Log in once, then reuse it instead of replaying the form on every run:

```bash
# log in by hand, once
npx craftdriver go http://127.0.0.1:8080/login.html
npx craftdriver fill '#username' alice
npx craftdriver fill '#password' secret
npx craftdriver click '#submit'
npx craftdriver state save alice

# later, in a fresh BiDi browser — load before the first real navigation
npx craftdriver state load alice
npx craftdriver go http://127.0.0.1:8080/login.html
```

On Chrome/Chromium and Firefox BiDi, `state load` restores cookies and all
captured localStorage origins through the same library hydrator as
`Browser.launch({ storageState })`; no navigate-before-load workaround is
needed. If a page is already open and must react to the overlay, reload it.

WebDriver Classic (including Safari) has a smaller contract: `go <url>` →
`state load <name>` → `reload`. The active page must match the snapshot's sole
storage origin and every cookie must be settable there. Broader state fails
before mutation instead of being partially ignored. A snapshot saved with
`--session-storage` also uses this active-page path because sessionStorage is
tab-scoped, even when BiDi is available.

Worth knowing:

- **State files are credentials.** They hold live session cookies. They are
  written to `.craftdriver/state/` (override with `CRAFTDRIVER_STATE_DIR`,
  which the daemon reads from its own working directory — every `state`
  result reports the `root` it used, so check there if a file is not where
  you expected),
  created owner-only (`0600`) inside an owner-only directory, and written via
  a temp file and a rename so a crash cannot leave a half-written one. Add
  `.craftdriver/` to `.gitignore`.
- **A save captures every cookie in that browser, not just the current
  site's.** Cookies are stored per browser profile, so `state save` on one
  site also writes any other site you happen to be logged into in that
  session. Local storage is the narrow half — only the current origin's. Use a
  separate `--session` for a login you do not want mixed in.
- **Nothing is ever printed back.** `state save` reports counts and origins —
  never a cookie value, token, storage value or file path contents.
- **Pass a name, not a path.** `state save alice` writes `alice.json` under the
  state root. Names are letters, digits, `-` and `_`; a path, a `..`, or a
  leading `-` is rejected, and a symlink inside the state directory cannot
  redirect a write outside it.
- **Sessions each have their own cookies**, so `state save --session shopper`
  captures that browser's login and no other's.
- **`state load` clears refs.** The document you snapshotted was a different
  logged-out page; take a fresh `snapshot` afterwards.
- `--session-storage` adds `sessionStorage` to a save. It is off by default,
  since most apps keep nothing durable there.

The library equivalent is `browser.saveState(path)` and
`Browser.launch({ storageState: path })`. On supported BiDi sessions that launch
form restores cookies plus multi-origin localStorage before the first real
navigation. Non-empty state at Classic launch is rejected; use the explicit
active-origin fallback above.

## Daemon details

- One daemon per project. The socket and PID file live in
  `~/.craftdriver/projects/<project>-<hash>/`, where the hash is derived from
  the project root — the nearest ancestor directory holding a `package.json`
  or `.git`. Running from a subdirectory reaches the same daemon; running in a
  different project reaches a different one, with its own browser, cookies and
  refs. Override the paths with `CRAFTDRIVER_SOCKET` / `CRAFTDRIVER_PID`.
- Saved state and traces are anchored to that same project root
  (`<project>/.craftdriver/{state,traces}`), not to the working directory the
  daemon was started from. Override with `CRAFTDRIVER_STATE_DIR` /
  `CRAFTDRIVER_TRACE_DIR`.
- A screenshot without `-o` overwrites
  `<project>/.craftdriver/screenshots/screenshot-<session>.png`, so repeated
  exploratory captures stay bounded. Pass `-o` when you intentionally want to
  keep multiple images.
- **Not available on Windows.** The daemon binds a Unix domain socket, which
  Windows does not provide. `craftdriver daemon …` and any command that would
  auto-start it exit with `UNSUPPORTED` there. The two socket-free modes work
  on every platform: `craftdriver --ephemeral < script.txt` for a one-shot run,
  and `craftdriver mcp` for an agent session over stdio. The library itself is
  unaffected and runs on Windows normally.
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

`open <url>` is an alias for `go <url>`, included for agents and users familiar
with other browser CLIs.

## When to use the CLI vs. the library

- **Library** — write a test suite. Stable, 30 s auto-waits, full TS
  types, runs under vitest / jest / playwright-test.
- **CLI** — exploration, debugging, agent-driven loops, REPL-style
  poking at a real page from your shell.

Both share the same underlying Browser API and the same error codes, so
findings transfer directly between the two.

## Install the project skill (`craftdriver init`)

Install the package-shipped CraftDriver skill in the nearest project root:

```bash
npx craftdriver init                    # Claude Code, Codex, and Copilot
npx craftdriver init --dry-run
npx craftdriver init --agent claude     # one agent only
```

Hosts disagree about where a project skill lives, so `init` writes the smallest
set that covers all three:

| Destination                   | Agents that read it  |
| ----------------------------- | -------------------- |
| `.claude/skills/craftdriver/` | Claude Code, Copilot |
| `.agents/skills/craftdriver/` | Codex, Copilot       |

`--agent claude` and `--agent codex` narrow the install to the corresponding
row. `--agent copilot` uses Copilot's own `.github/skills/craftdriver/`
location. `--agent all` is the default. `init codex` is the pre-1.10 spelling
of `--agent codex` and still works, with a deprecation notice.

If `.github/skills/craftdriver/` already exists from a targeted Copilot
install, a later default `init` also reports and updates that owned copy. This
prevents Copilot CLI's first-choice project location from silently remaining
on an older CraftDriver version.

An ownership manifest makes repeat installation deterministic and prevents
updates from overwriting user edits or unowned files. A conflict in any
destination being reconciled refuses the whole command. There is no destructive
`--force` mode.

The installer never reads or changes `AGENTS.md`, `CLAUDE.md`, Copilot
instructions, Cursor rules, `GEMINI.md`, `.codex/config.toml`, `.mcp.json`, or
`.vscode/mcp.json`.

To use optional MCP, run `npx craftdriver init --mcp`. It prints a
project-pinned snippet per host for manual configuration; it does not configure
MCP. See the [AI agent guide](./agents.md) for the full walkthrough.

## Skill pack

For agents that load skills explicitly (Claude Code's Skills system,
Copilot agent customization, custom orchestrators), the npm tarball
ships a tiered skill pack under `skills/craftdriver/`:

`SKILL.md` is the entry point. The remaining files are linked from it and
loaded only when needed, keeping the initial context small.

| File                                                                                                  | Purpose                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`SKILL.md`](https://github.com/dtopuzov/craftdriver/blob/main/skills/craftdriver/SKILL.md)           | Entry point. Selector order, error-code-first, auto-wait, routing.  |
| [`workflow.md`](https://github.com/dtopuzov/craftdriver/blob/main/skills/craftdriver/workflow.md)     | Explore → validate selectors → write test → debug from evidence.    |
| [`cheatsheet.md`](https://github.com/dtopuzov/craftdriver/blob/main/skills/craftdriver/cheatsheet.md) | Public TypeScript API reference for writing tests.                  |
| [`patterns.md`](https://github.com/dtopuzov/craftdriver/blob/main/skills/craftdriver/patterns.md)     | Worked recipes (login, upload, network-wait, a11y, tracing, clock). |
| [`cli.md`](https://github.com/dtopuzov/craftdriver/blob/main/skills/craftdriver/cli.md)               | Agent-facing CLI reference.                                         |

Use `npx craftdriver init` to install these files safely. The other files
are referenced from `SKILL.md` and loaded on demand.
