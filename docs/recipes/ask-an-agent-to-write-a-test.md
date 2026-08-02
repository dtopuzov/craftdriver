# Ask Your Coding Agent To Write A Browser Test

Your agent can already write code. What it cannot do is _see your app_ — so it
guesses selectors from source, invents `data-testid`s that don't exist, and
hands you a test that fails on first run.

CraftDriver gives it a real browser. It opens the page, reads the accessibility
tree, checks which locators actually resolve, and writes the test against what
it found. You review a diff, not a guess.

This is the shell path — the agent drives the CraftDriver CLI. It works in
Claude Code, Codex, and Copilot. A host without a shell can use the same prompt
over CraftDriver's optional MCP adapter.

## Setup, once

```bash
npm install --save-dev craftdriver
npx craftdriver init
```

That installs a project-local skill into the directories your agent reads. See
the [AI agent guide](../agents.md) for what lands where and how to confirm it
loaded.

### No shell? Configure MCP

If the agent cannot spawn commands, have a developer print the project-pinned
configuration and add the snippet for that host:

```bash
npx craftdriver init --mcp
```

Restart the host and confirm `craftdriver` appears in its tool list. The prompt
below stays the same; the skill tells the agent to use the available transport.
See the [MCP reference](../mcp.md) for each host's configuration and the tool
surface.

## Start your app, then ask

Leave the app running in its own terminal — the agent needs a live URL.

> **Use the CraftDriver skill.** Explore `http://localhost:3000/login` and add a
> browser test for a failed sign-in with a wrong password. Follow this
> repository's existing test conventions, verify every locator against the live
> page before you commit to it, then run the focused test and report which file
> you changed and which locators you verified.

Invoke the skill explicitly if the agent doesn't pick it up on its own:

| Agent                            | Explicit invocation   |
| -------------------------------- | --------------------- |
| Claude Code                      | `/craftdriver <task>` |
| Copilot in VS Code / Copilot CLI | `/craftdriver <task>` |
| Codex                            | `$craftdriver <task>` |

The portable phrasing — "Use the CraftDriver skill" — works everywhere.

## Ask for an accessibility audit

The same setup can run a useful audit without writing a test:

> **Use the CraftDriver skill.** Audit `http://localhost:3000/checkout` for
> serious and critical accessibility violations. For each finding, report the
> rule, remediation link, and affected element. Fix the issues in the source,
> rerun the audit in check mode, and summarize anything that remains. Do not
> add a test unless I ask.

The agent runs `craftdriver a11y --min-impact serious` through the CLI, or calls
`browser_a11y` with `min_impact: "serious"` over MCP. In either case, each
finding includes a live `ref=eN`; the agent resolves that ref to a durable
locator before editing source and never commits the ref itself.

## What the agent does with the browser

It is worth knowing, because it is what makes the output better than a guess:

```bash
npx craftdriver snapshot --pretty
```

```text
page: Login — http://localhost:3000/login
e1: heading "Login" [level=1]
e2: form (container) #login-form
  e3: label "Username"
  e4: textbox "Username" #username
  e5: label "Password"
  e6: input "Password" #password
  e7: button "Sign in" #submit
```

That is the accessibility tree, not raw HTML — role and accessible name per
element, plus the state the agent needs to choose a next step (heading level,
link target, field value, `(disabled)`/`(checked)`/`(expanded=…)`), in a few
hundred tokens instead of a DOM dump. Status and validation text is captured
too, so a failed submit shows up as a `text` line rather than needing a second
command. For a conventional form the agent can exercise that path atomically:

```bash
npx craftdriver fill ref=e4 invalid@example.test
npx craftdriver fill ref=e6 wrong-password --submit --observe=delta
```

It then converts an element into locators CraftDriver has re-checked against
the live page:

```bash
npx craftdriver locators ref=e7 --pretty
```

```text
best: role=button[name=Sign in]
✓ role=button[name=Sign in]
    By.role("button", { name: "Sign in" })
✓ text=Sign in
✓ #submit
```

Every `✓` matched exactly one element _just now_. The agent puts the `By.…` line
into the test. It also drives the flow first, so it knows the test passes before
you see it — and reads `craftdriver logs --kind error` when something fails, so
"it says something went wrong" becomes "a 405 on `POST /api/checkout`".

## Review what comes back

Skim for these four. They are the difference between a test you keep and one
that rots:

- **No `ref=eN` in the source.** Refs are live-session handles. They fail
  `STALE_REF` on the next run.
- **No hardcoded dynamic text.** `By.role('button', { name: 'Count is 0' })`
  breaks on the next click; a localized name breaks in another language.
- **No sleeps or retry loops.** Actions and `locator.expect()` already auto-wait.
- **It ran the test.** Ask for the command and its output if the report doesn't
  include them.

## Another prompt worth having

**Turn a bug report into a failing test:**

> Use the CraftDriver skill. Reproduce this bug at
> `http://localhost:3000/checkout`: "clicking Place order just says something
> went wrong." Read the console and network journal to find the real cause,
> then write a regression test that fails for that reason and tell me what you
> found.

The console and network are captured from launch, so the agent asks after the
fact instead of re-running the flow with devtools open.

## Notes

- **The agent needs the app running.** It cannot start your dev server unless
  you tell it how; say so in the prompt, or point it at a `package.json` script.
- **Name the conventions you care about.** "Follow this repository's existing
  test conventions" is what stops it inventing a second test framework.
- **On Windows**, or in a sandbox with no persistent process, the agent falls
  back to one-shot `--ephemeral` scripts. Same commands, same results, slower.
- **Nothing here is magic.** The agent is running documented CLI commands you
  can run yourself — see the [CLI reference](../cli.md).

## Learn More

- [AI Agent Guide](../agents.md) — setup, verification, troubleshooting
- [MCP Reference](../mcp.md) — optional setup for a host without a shell
- [CLI Reference](../cli.md) — every command the agent has
- [Accessibility](../accessibility.md) — the audit API
