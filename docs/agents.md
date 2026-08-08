# AI Agent Guide

CraftDriver gives a coding agent a real browser. The agent explores the running
application, learns its DOM and accessibility structure, validates durable
selectors against the live page, and then writes and runs ordinary CraftDriver
tests — the same tests a person would write, in the same files.

One setup command covers Claude Code, Codex, and GitHub Copilot. MCP is
optional.

## Install

From a project that already has a `package.json`:

```bash
npm install --save-dev craftdriver
npx craftdriver init
```

That's the whole setup. `init` installs the CraftDriver skill into the
directories your agent reads:

```
installed .claude/skills/craftdriver  (Claude Code, Copilot)
installed .agents/skills/craftdriver  (Codex, Copilot)
```

Preview without writing anything:

```bash
npx craftdriver init --dry-run
```

Installing for one agent only:

```bash
npx craftdriver init --agent claude    # .claude/skills/craftdriver
npx craftdriver init --agent codex     # .agents/skills/craftdriver
npx craftdriver init --agent copilot   # .github/skills/craftdriver
```

### Why two directories

Skills follow the [Agent Skills](https://agentskills.io) open standard, but the
hosts disagree about where a project skill lives:

| Agent          | Project skill directories it reads                      |
| -------------- | ------------------------------------------------------- |
| Claude Code    | `.claude/skills/`                                       |
| Codex          | `.agents/skills/`                                       |
| GitHub Copilot | `.github/skills/`, `.claude/skills/`, `.agents/skills/` |

Two directories are the smallest default set that covers all three. A targeted
`--agent copilot` install uses Copilot's own `.github/skills/` location instead.
If that third CraftDriver directory already exists, later default `init` runs
also report and update it so a Copilot surface cannot load a stale duplicate;
Copilot CLI checks `.github/skills/` first. Commit the installed skill, or add
it to `.gitignore` and let each developer run `npx craftdriver init` — both
work.

### What it will not touch

`init` writes CraftDriver-owned skill directories and nothing else. It does not
read or change `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`,
Cursor rules, `GEMINI.md`, `.codex/config.toml`, `.mcp.json`, or
`.vscode/mcp.json`.

It refuses rather than overwriting: user-edited files, unowned destinations,
extra files, and symlinked paths all stop the install with a message naming the
file in the way. A conflict in any destination being reconciled refuses the
whole command, so you never end up with one agent configured and another not.

## Verify it loaded

Worth doing once. This is where skill setup usually goes wrong, and each host
reports it differently.

| Agent                  | Check                                                                  | If it isn't there                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code**        | Type `/craftdriver`                                                    | Restart Claude Code. A skills directory that did not exist when the session started is not watched.                                   |
| **Copilot in VS Code** | Type `/skills` to open the Skills menu, or `/craftdriver` to invoke it | Reload the window, then check that `chat.useAgentSkills` is enabled and `chat.agentSkillsLocations` includes the installed directory. |
| **Copilot CLI**        | Type `/skills list`, or `/craftdriver` to invoke it                    | Start a new session from the repository root.                                                                                         |
| **Codex**              | Type `/skills`, or `$craftdriver` to invoke it                         | Codex detects skill changes automatically; restart it if a new one doesn't appear.                                                    |

Copilot cloud and other supported IDEs use the same project skill files, but do
not share one portable verification command. Use the explicit prompt below;
surface support also depends on the installed Copilot version.

Project trust does **not** gate `.agents/skills` — it gates the `.codex/`
configuration layer, which matters for [Codex MCP setup](#optional-mcp) but not
for the skill.

Then just ask for what you want. The agent loads the skill when the request
matches it:

> Explore the login page at http://127.0.0.1:8080/login.html and write a test
> for a failed sign-in.

## The loop

The installed skill contains the compact live loop directly and loads
test-authoring detail only when a durable test is requested. The shape of the
live loop, if you want to drive the CLI yourself:

```bash
npx craftdriver go http://127.0.0.1:8080/login.html --browser chrome --headless --observe=delta
npx craftdriver fill ref=e4 alice
npx craftdriver fill ref=e6 hunter2 --submit --observe=delta
npx craftdriver daemon stop
```

The first `go` auto-starts the daemon; `open` is an equivalent alias. Adding
`--observe=delta` is what makes it return the initial semantic snapshot with
the refs used on the next lines — without the flag, results stay compact and
no snapshot is taken. Use `--observe` on the steps whose visible result decides
what to do next, not on every command.

For a conventional multi-field form, filling the final single-line field with
`--submit` keeps the submit atomic and returns the validation or destination in
the same observed action. Use a separate button when the flow requires a
specific secondary action rather than ordinary Enter submission.

The daemon keeps the page and cookies between commands, one per project. It
binds a Unix domain socket, so it is not available on Windows — see
[sandboxes and one-shot runs](#sandboxes-windows-and-one-shot-runs) below. The
[CLI reference](./cli.md) lists every command.

Two rules matter more than the rest:

- **Snapshot refs are exploration-only.** `ref=e7` names one element in one live
  document. It fails `STALE_REF` rather than drifting onto something else, and
  it means nothing tomorrow. Never copy one into a test.
- **Turn the element into a durable locator before writing the test.** Ask
  CraftDriver, and it validates the candidates against the live page:

  ```bash
  npx craftdriver locators ref=e7
  ```

  Use the candidate reported as `best`. When an accessible name looks dynamic —
  a counter, a price, a date — the ranker demotes it below a stable anchor and
  says so.

Put the loop to work with [Ask Your Agent To Write A Browser
Test](./recipes/ask-an-agent-to-write-a-test.md).

## Sandboxes, Windows, and one-shot runs

The daemon needs a Unix domain socket, so it is unavailable on Windows, and some
hosts — cloud agents, restricted sandboxes — cannot keep a background process
between tool calls. `--ephemeral` covers both: one browser, one script, exits
when it's done.

Put the commands in a file so the invocation works in every shell:

```text
# smoke.txt
go http://127.0.0.1:8080/login.html
snapshot
fill "label=Username" alice
fill "label=Password" hunter2
click "role=button[name=Sign in]"
text "#welcome"
```

```bash
npx craftdriver --ephemeral < smoke.txt              # bash, zsh, cmd
Get-Content smoke.txt | npx craftdriver --ephemeral  # PowerShell
```

**Quote any selector containing a space.** Script lines are whitespace-tokenized,
so `click role=button[name=Sign in]` is three arguments and a usage error, while
`click "role=button[name=Sign in]"` is one selector.

Each line returns one JSON object, and a failed command exits non-zero — so this
also works as a CI smoke step. The script stops at the first failed command, so
what you read is the failure, not the confusing output of four more commands run
against a page that never got there. The alternative for a host that wants
structured tool calls is [MCP](#optional-mcp).

## There is no arbitrary-code tool

`craftdriver eval <js>` runs its argument **in the page**, through
`page.evaluate()`. It is a last resort for inspection, and it is the only
code-execution surface craftdriver offers.

There is deliberately no equivalent of a "run this function against the driver"
tool. Handing an agent a callback that executes in the automation process is
remote code execution by another name: the agent reads a web page, the page
contains instructions, and the instructions become code running with your
shell's privileges. Playwright renamed its own version to
`browser_run_code_unsafe` and now documents it as RCE-equivalent and suitable
only for trusted clients, after exactly that escape was demonstrated.

So there is no flag to enable and no capability to audit here. When a flow needs
real logic — custom waits, sequencing, dynamic interception — write it with the
[library API](./browser-api.md) in a test file, where it is reviewed, versioned
and diffable, rather than generated into a prompt.

## Optional MCP

The CLI plus the installed skill needs no MCP. If your host prefers structured
tool calls, or runs somewhere that cannot spawn a process per command, print the
project-pinned configuration for your agent:

```bash
npx craftdriver init --mcp                    # Claude, Copilot in VS Code, Codex
npx craftdriver init --agent claude --mcp     # just this one
```

Each surface reads a different file, and the schemas differ:

| Surface                | File                 | Top-level key                     |
| ---------------------- | -------------------- | --------------------------------- |
| Claude Code            | `.mcp.json`          | `mcpServers`                      |
| Copilot **in VS Code** | `.vscode/mcp.json`   | `servers`, with `"type": "stdio"` |
| Codex                  | `.codex/config.toml` | `[mcp_servers.craftdriver]`       |

These are three surfaces, not three families: Copilot CLI and the Copilot cloud
agent are configured elsewhere, and Codex skips project `.codex/config.toml`
entirely for an untrusted project. The [MCP reference](./mcp.md) covers both,
plus Cursor, Windsurf, Zed, Gemini CLI, and Goose.

Add it yourself. CraftDriver prints these and never reads or writes host
configuration. Claude Code users can also run:

```bash
claude mcp add --scope project craftdriver -- npx --no-install craftdriver mcp
```

See the [MCP reference](./mcp.md) for the tool surface, the snapshot-diff
payload, and protocol bounds.

## Installed skill files

| File            | Purpose                                                               |
| --------------- | --------------------------------------------------------------------- |
| `SKILL.md`      | Short browser-to-test rules and routing.                              |
| `workflow.md`   | Exploration, selector validation, test authoring, and debugging loop. |
| `cli.md`        | Current shell command reference for agent exploration.                |
| `cheatsheet.md` | Public TypeScript API reference for writing tests.                    |
| `patterns.md`   | Focused library recipes loaded on demand.                             |

Full package docs stay available to the agent at
`node_modules/craftdriver/docs/`.

## Troubleshooting

**The skill isn't loading.** Check the verify table above first — a restart or
window reload covers most of it. Then confirm the files are actually there:
`npx craftdriver init --dry-run` reports `unchanged` when a current install is
already in place.

**The agent has the skill but no browser.** It needs your app running at a URL
it can reach. Start the dev server yourself, or tell the agent which
`package.json` script starts it.

**`init` refuses to run.** It found something it does not own at the
destination. The message names the file. Move or delete it, or install for one
agent with `--agent`.

**The agent put `ref=e4` in a test.** It fails with `STALE_REF` on the next run.
That is the design — refs are exploration state. Have it run
`craftdriver locators` and use a durable candidate.

**`STALE_REF` mid-exploration.** The element was removed, or the page navigated
or reloaded. Use the attached `recoverySnapshot`, or take a fresh snapshot when
it is unavailable; CraftDriver will not guess a replacement or retry the action.

**Selectors that pass once and fail later.** Usually a dynamic or localized
accessible name baked into `By.role({ name })`. Anchor on a stable id or test id
instead — see [Find Elements On The Page](./recipes/find-elements.md).
