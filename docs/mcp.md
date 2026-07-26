# MCP server

`craftdriver` ships an optional [Model Context Protocol](https://modelcontextprotocol.io)
STDIO adapter so MCP-aware coding agents can drive the same local session and
dispatcher as the CLI.

CLI plus the installed CraftDriver skill is the recommended workflow. MCP is
not required for exploration or test authoring.

```bash
# Start once via your MCP client — examples below
npx --no-install craftdriver mcp
```

The server speaks JSON-RPC 2.0 on stdio. The browser launches lazily
on the first tool call and shuts down when the client disconnects.
Each newline-delimited input frame is limited to 1 MiB (1,048,576 UTF-8
bytes); oversized frames return a parse error and are discarded.

## Manual project-pinned setup

Run `npx craftdriver init --mcp` to print the Claude Code, Copilot in VS Code,
and Codex snippets, or `npx craftdriver init --agent claude --mcp` for one. The
installer prints; it never reads or changes MCP configuration.

The three major hosts each read a different file, and two of them use different
schemas — pasting Claude Code's shape into `.vscode/mcp.json` produces a config
that silently does nothing.

### Claude Code — `.mcp.json` at the repository root

```json
{
  "mcpServers": {
    "craftdriver": {
      "command": "npx",
      "args": ["--no-install", "craftdriver", "mcp"]
    }
  }
}
```

Project-scoped `.mcp.json` is meant to be committed; Claude Code prompts for
approval before using a server from it. The equivalent one-liner:

```bash
claude mcp add --scope project craftdriver -- npx --no-install craftdriver mcp
```

### Copilot in VS Code — `.vscode/mcp.json`

Note `servers` rather than `mcpServers`, and the required `type`.

```json
{
  "servers": {
    "craftdriver": {
      "type": "stdio",
      "command": "npx",
      "args": ["--no-install", "craftdriver", "mcp"]
    }
  }
}
```

### Other Copilot surfaces

"Copilot" is several products with different MCP configuration. The snippet
above is VS Code only:

| Surface | Where MCP is configured |
| --- | --- |
| Copilot in VS Code | `.vscode/mcp.json` (above) |
| Copilot CLI | `~/.copilot/mcp-config.json`; `.mcp.json` or `.github/mcp.json` in a repository |
| Copilot coding agent (cloud) | Repository Copilot settings on GitHub |

The command and args are the same everywhere — `npx --no-install craftdriver
mcp` — only the file and its schema change. Check your surface's own
documentation for the exact shape.

### Codex — `.codex/config.toml`

```toml
[mcp_servers.craftdriver]
command = "npx"
args = ["--no-install", "craftdriver", "mcp"]
```

Project-scoped Codex config is skipped entirely for an untrusted project. Either
trust the project, or put the server in `~/.codex/config.toml` instead.

### Cursor / Windsurf / Zed (`.cursor/mcp.json` and similar)

```json
{
  "mcpServers": {
    "craftdriver": {
      "command": "npx",
      "args": ["--no-install", "craftdriver", "mcp"]
    }
  }
}
```

### Gemini CLI

```bash
gemini mcp add craftdriver npx --no-install craftdriver mcp
```

### Goose

```bash
goose configure   # add craftdriver as a stdio server
```

## Tools

One line each; the long help lives in the schema description, which clients
render into the model's context once per session. Every tool dispatches a
command the CLI also has — there are no MCP-only browser semantics.

| Tool                    | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `browser_navigate`      | Go to a URL (waits for load).                                          |
| `browser_click`         | Click an element; set `double` for a double-click.                     |
| `browser_fill`          | Fill an input/textarea (clears first, real key events).                |
| `browser_type`          | Type into whatever holds focus (no selector).                          |
| `browser_element`       | `dblclick`/`focus`/`scroll`/`clear`/`check`/`uncheck`/`select`.        |
| `browser_press`         | Press a key (`Enter`, `Tab`, `Control+A`).                             |
| `browser_key`           | Low-level `press`/`down`/`up` for modifier combinations.               |
| `browser_mouse`         | `move`/`click`/`down`/`up`/`wheel`, by element or coordinate.          |
| `browser_hover`         | Hover over an element.                                                 |
| `browser_upload`        | Set files on a file input (bounded; paths never echoed).               |
| `browser_dialog`        | `inspect`/`accept`/`dismiss` a native dialog.                          |
| `browser_find`          | Locate elements without acting (tag/text/visibility).                  |
| `browser_exists`        | **0-wait probe.** Returns `{exists, count}` in one roundtrip.          |
| `browser_wait`          | Wait for a selector state or a load state.                             |
| `browser_read`          | Read `text` / `attr` / `value` / `is(visible\|enabled\|checked)`.      |
| `browser_snapshot`      | **Sanitized DOM summary with refs.** Use `ref=eN` as a selector.       |
| `browser_locators`      | **Turn an element into durable selectors for a test.** Never a ref.    |
| `browser_page`          | `list`/`open`/`select`/`close` tabs.                                   |
| `browser_logs`          | Console + network history, with cursors. See below.                    |
| `browser_mock`          | Serve a fixed response or block matching requests.                     |
| `browser_state`         | Save/restore cookies and local storage (a login, once).                |
| `browser_trace`         | Record a run to an owned directory; `zip` for a Vibium archive.        |
| `browser_screenshot`    | Capture PNG to a file under the artifact dir; never inlined.           |
| `browser_status`        | Browser up? Which URL is active?                                       |
| `browser_advanced_eval` | Evaluate JS in the page. Last resort.                                  |

Each tool carries MCP `annotations` — `title`, `readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint` — and they are accurate:
a tool marked read-only never dispatches a command the dispatcher treats as
page-mutating, which is asserted by test rather than by review.

### Debugging with evidence

`browser_logs` captures console and network from launch, so an error thrown
during the first navigation is still answerable afterwards. Every result
carries a `cursor`; pass it back as `since` for only what is new. `kind=error`
covers both uncaught exceptions and `console.error`. Network rows are
summaries — url, method, status, mime type — and never carry bodies, cookies,
or headers.

```jsonc
{ "name": "browser_logs", "arguments": { "action": "list", "kind": "error" } }
{ "name": "browser_logs", "arguments": {
  "action": "wait", "contains": "checkout ok", "timeout_ms": 10000
} }
```

### Tracing

```jsonc
{ "name": "browser_trace", "arguments": { "action": "start", "name": "agentflow" } }
// ...browser_navigate / browser_fill / browser_click calls...
{ "name": "browser_trace", "arguments": { "action": "stop", "zip": true } }
```

The response reports where the trace and archive landed; the zip opens at
[player.vibium.dev](https://player.vibium.dev/). Output goes to an owned
directory (`CRAFTDRIVER_TRACE_DIR`), and `name` is a bare name rather than a
path — an earlier version accepted an arbitrary filesystem path straight off
the wire. If the client disconnects before `stop`, the raw NDJSON is still
valid, just without a finalized zip.

## Argument validation

Every tool declares its arguments once; that declaration produces both the
advertised `inputSchema` and the runtime check, so a tool cannot promise a
constraint it does not enforce. Invalid arguments are rejected as JSON-RPC
`-32602` **before** anything reaches the browser:

- an unknown field (rather than being silently ignored — a misspelled required
  argument would otherwise look like a successful call that did something else);
- a wrong type, a non-finite number, an out-of-range number, an invalid enum;
- an oversized string or array.

`-32602` also covers an unknown tool name. Ordinary browser failures — a
missing element, a timeout — are **not** protocol errors; they come back as
successful responses with `isError: true`, which is what keeps the two
distinguishable.

## Selector syntax

Identical to the CLI. CSS by default; switch with a `prefix=value`
form:

```
role=button[name=Submit]   text=Sign In            text*=Sign
label=Email                placeholder=Search…     testid=login-btn
alt=Logo                   title=Help              xpath=//div[1]
id=submit                  name=email              tag=h1
ref=e5                     (← from browser_snapshot, see below)
```

## Refs — the token-efficient locator

Call `browser_snapshot` (or just navigate — the post-action diff
carries refs too) and you get a sanitized accessibility-tree summary
where each visible interactive element is numbered:

```
page: Login — http://…/login.html
e1: heading "Login"
e2: form "Username Password Sign in" #login-form
e3: label "Username"
e4: textbox "Username" #username
e5: label "Password"
e6: textbox "Password" #password
e7: button "Sign in" #submit
```

Use `ref=eN` as the selector for the next call:

```jsonc
{ "name": "browser_fill",  "arguments": { "selector": "ref=e4", "value": "alice" } }
{ "name": "browser_fill",  "arguments": { "selector": "ref=e6", "value": "hunter2" } }
{ "name": "browser_click", "arguments": { "selector": "ref=e7" } }
```

**Use refs only for immediate exploration**

- **A ref names one element for as long as it lives.** A surviving node keeps
  its ref across snapshots, and refs are never reused — so a ref cannot drift
  onto a different element. If it is removed or the page
  navigates, the call fails `STALE_REF`; take a fresh snapshot then.
- **Never copy refs into test code.** Convert live role/name, label, test ID,
  text, or DOM evidence into a durable selector and validate it.
- **Token efficient.** `ref=e7` is 5 characters; `role=button[name=Sign in]`
  is 26. Over a 50-step flow that adds up.
- **Auto-waiting still works.** `ref=eN` resolves directly to the exact element
  in the page identity registry, including inside an open shadow root; every
  action takes the normal visible+enabled wait path.

**Invalidation rules**

- A ref binds to one element. An element that survives a DOM change keeps
  its ref across snapshots; snapshots do **not** renumber it.
- New elements get fresh numbers. Refs are never reused, including after a
  navigation or reload.
- A ref whose element was removed, or that was issued before
  the page navigated or reloaded, fails with `STALE_REF` — take a fresh
  snapshot. It never resolves to a different element.
- `error.detail.reason` distinguishes `detached`, `document-changed`,
  `unknown-ref`, `ambiguous`, and `no-snapshot`.
- Refs are exploration state and must never appear in committed tests.

Snapshots recursively enter open Shadow DOM, mark each boundary with an
indented `#shadow-root (open)` line, flatten slot assignment without duplicate
entries, and never inspect closed roots.

## Post-action payload

Every tool returns a content array. Mutating tools (`navigate`,
`click`, `fill`, `press`, `hover`, `advanced_eval`) additionally
include a **compact a11y snapshot, diffed from the previous turn**:

```jsonc
{
  "content": [
    { "type": "text", "text": "{\"ok\":true,\"selector\":\"css selector=button[type=submit]\"}" },
    {
      "type": "text",
      "text": "page: Login — http://…/login.html\n- form \"Username Password Sign in\" #login-form\n- textbox \"Username\" #username\n- button \"Sign in\" #submit\n+ button \"Logout\" #logout"
    }
  ],
  "structuredContent": { "result": { "ok": true, "selector": "css selector=button[type=submit]" } }
}
```

- **First call in a session** returns the full snapshot (one line per
  visible interactive element: role + accessible name + locator hint).
- **Subsequent calls** return only the lines that appeared (`+`) or
  disappeared (`-`).
- **URL change** triggers a fresh full snapshot.
- Capped at 80 nodes / 80 chars per name so the payload stays bounded
  regardless of page complexity.

This is the MCP server's "killer feature" over the CLI: the agent sees
what changed without a follow-up `read` call, in ~50–500 text tokens
instead of 800–1500 image tokens for a screenshot.

## Artifact spilling (token efficiency)

MCP content blocks count against the model's context window on every
turn. To keep the per-call cost bounded, large payloads are **written
to disk** and the inline block becomes a short preview plus the
absolute path:

```
heading "Selectors Playground"
textbox "by id" #by-id
textbox "by name" #by-name
img "Logo ALT" #by-alt
button "Click me" #by-text
…
(full output: /tmp/craftdriver-mcp-1234-abc/0001-snapshot.txt, 1872 bytes)
```

Applies to:

- **Screenshots** — always written to a server-allocated file under the
  per-session artifact directory. The inline block carries the absolute path
  and byte count — **zero** image tokens. The tool accepts no destination
  path, so it cannot write outside that directory.
- **A11y snapshot diffs** — spill when the rendered diff exceeds the
  threshold (typically only the full first-call snapshot on big pages).
- **Tool results** — `browser_read`, `browser_advanced_eval`, etc. spill
  when the JSON-stringified result exceeds the threshold. No more silent
  truncation.

Configuration:

| Env var                            | Default          | Effect                                            |
| ---------------------------------- | ---------------- | ------------------------------------------------- |
| `CRAFTDRIVER_MCP_ARTIFACTS_DIR`    | `os.tmpdir()`    | Root directory for the per-session artifact dir.  |
| `CRAFTDRIVER_MCP_SPILL_BYTES`      | `2048` (~500 tk) | Inline content blocks larger than this spill.     |
| `CRAFTDRIVER_MCP_MAX_RESPONSE_BYTES` | `32768`        | Maximum serialized result from one tool call.     |

The per-session directory (`<root>/craftdriver-mcp-<pid>-<stamp>/`) is
not deleted on shutdown — agents may still be reading past artifacts.
Use `$CRAFTDRIVER_MCP_ARTIFACTS_DIR` to point at a dir with your own
cleanup policy. Each server process refuses more than 500 artifacts or 256 MiB
in its session directory; browser-written screenshots are counted by their
actual file size after capture.

Small results still round-trip in full through `structuredContent`. When the
complete result would exceed the response cap, it becomes explicit truncation
metadata and a bounded preview rather than duplicating the full spilled value.

## Errors

Browser and action failures are returned as `isError: true` content (per MCP
spec), **not** as JSON-RPC errors. JSON-RPC errors are reserved for
protocol-level failures: a malformed request (`-32700`/`-32600`), an unknown
method (`-32601`), and an unknown tool or invalid arguments (`-32602`).

The split matters: "the element was not there" is a fact about the page that an
agent should reason about, while "you sent an argument that does not exist" is
a mistake about the protocol that it should correct.

```jsonc
{
  "isError": true,
  "content": [
    { "type": "text", "text": "error: click: no element matches css selector=#nope\ncode:  NO_MATCH" }
  ],
  "structuredContent": {
    "error": { "code": "NO_MATCH", "message": "click: no element matches css selector=#nope" }
  }
}
```

Match on `structuredContent.error.code` — full list in
[error-codes.md](./error-codes.md).

## Fail-fast defaults

Same rules as the CLI:

- Default per-call timeout: **5 s** (override per call with
  `timeout_ms`, globally with `CRAFTDRIVER_AGENT_TIMEOUT`).
- `browser_exists` is a **0-wait probe**. Call it before `browser_click`
  / `browser_wait` when you're guessing.
- `browser_click` / `browser_fill` reject immediately with `NO_MATCH`
  when the selector matches zero elements at `t=0` — no burning the
  full timeout on a typo.

## When to use MCP vs. the CLI

- **MCP** — your agent runs in a hosted or sandboxed environment that
  can't spawn child processes per call, or you want tool discovery via
  `tools/list`. Schema-typed args, structured errors, snapshot diffing.
- **CLI** — your agent has a shell. Same surface, leaner per-call cost,
  also great for humans.
