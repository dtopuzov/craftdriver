# MCP server

`craftdriver` ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so hosted / sandboxed AI agents (Claude Desktop, Claude Code,
Cursor, Windsurf, Zed, Goose, Gemini CLI, …) can drive a real browser
without managing a daemon, a socket, or filesystem access.

It is a **peer to the CLI**, not a wrapper. Both share the same
dispatcher and error codes, but the MCP server returns a richer
post-action payload (compact a11y snapshot, diffed from the previous
turn) that text models can act on directly.

```bash
# Start once via your MCP client — examples below
npx -y craftdriver mcp
```

The server speaks JSON-RPC 2.0 on stdio. The browser launches lazily
on the first tool call and shuts down when the client disconnects.

## Install snippets

### Claude Code / Claude Desktop

```bash
claude mcp add craftdriver -- npx -y craftdriver mcp
```

### Cursor / Windsurf / Zed (`.cursor/mcp.json` and similar)

```json
{
  "mcpServers": {
    "craftdriver": {
      "command": "npx",
      "args": ["-y", "craftdriver", "mcp"]
    }
  }
}
```

### Gemini CLI

```bash
gemini mcp add craftdriver npx -y craftdriver mcp
```

### Goose

```bash
goose configure   # add craftdriver as a stdio server
```

## Tools

Compact set — 14 tools, one line each. Long help lives in the schema
description; clients render it in the model's context once per session.

| Tool                     | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `browser_navigate`       | Go to a URL (waits for load).                                          |
| `browser_click`          | Click an element. Auto-waits visible+enabled.                          |
| `browser_fill`           | Fill an input/textarea/select.                                         |
| `browser_press`          | Press a keyboard key (`Enter`, `Tab`, `Control+A`).                    |
| `browser_hover`          | Hover over an element.                                                 |
| `browser_find`           | Locate elements without acting (returns tag/text/visibility).          |
| `browser_exists`         | **0-wait probe.** Returns `{exists, count}` in one BiDi roundtrip.     |
| `browser_wait`           | Wait for selector state or load state.                                 |
| `browser_read`           | Read `text` / `attr` / `value` / `is(visible|enabled|checked)`.        |
| `browser_pages`          | List open pages (id, url, title).                                      |
| `browser_snapshot`       | **Sanitized DOM summary with refs.** Use `ref=eN` as the selector for subsequent calls. |
| `browser_screenshot`     | Capture PNG to a file (auto-allocated under the per-session artifact dir; never inlined). |
| `browser_status`         | Browser up? Which URL is active?                                       |
| `browser_advanced_eval`  | Evaluate JS in the page. Last resort.                                  |

`browser_trace` (start/stop/explain) and trace resources are slated
for a future release alongside richer trace introspection.

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

**Why this is a big deal for AI test generation**

- **No selector hallucination.** The agent picks a number, not a
  CSS/XPath/role expression. The element is already on the page —
  there is nothing to guess wrong.
- **Token efficient.** `ref=e7` is 5 characters; `role=button[name=Sign in]`
  is 26. Over a 50-step flow that adds up.
- **Auto-waiting still works.** Internally `ref=eN` resolves to a CSS
  attribute selector (`[data-craftdriver-ref="eN"]`); every action
  takes the normal visible+enabled wait path.

**Invalidation rules**

- Refs are re-allocated on **every** `browser_snapshot` call.
- The post-action a11y diff after a mutating tool also re-runs the
  snapshot, so refs renumber on every turn.
- Navigating to a new URL invalidates all refs.
- A stale ref just fails with `NO_MATCH` — take a fresh snapshot.

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

- **Screenshots** — always written to a file. If you pass `path`, that
  path is used; otherwise an artifact path is auto-allocated. The
  inline block carries the absolute path and byte count — **zero**
  image tokens.
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

The per-session directory (`<root>/craftdriver-mcp-<pid>-<stamp>/`) is
not deleted on shutdown — agents may still be reading past artifacts.
Use `$CRAFTDRIVER_MCP_ARTIFACTS_DIR` to point at a dir with your own
cleanup policy.

The `structuredContent` field is unaffected by spilling — small results
still round-trip in full there for programmatic consumers.

## Errors

Errors are returned as `isError: true` content (per MCP spec), **not**
as JSON-RPC errors. JSON-RPC errors are reserved for protocol-level
failures (unknown method, malformed request).

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
