# AI Agent Guide

CraftDriver's recommended agent surface is the CLI plus a project-local skill.
The agent explores the running application, learns its DOM and accessibility
structure, validates durable selectors, and then writes and runs ordinary
CraftDriver tests. MCP is optional.

## Install safely

From a project that already has a `package.json`:

```bash
npm install --save-dev craftdriver
npx craftdriver init codex
```

This installs `.agents/skills/craftdriver/` with an ownership manifest. It does
not read or change `AGENTS.md`, `CLAUDE.md`, Copilot instructions, Cursor rules,
`GEMINI.md`, or `.codex/config.toml`. It refuses user-edited, unowned, extra, or
symlinked destination content instead of overwriting it.

Preview without writes:

```bash
npx craftdriver init codex --dry-run
```

## Explore, then write the test

```bash
npx craftdriver daemon start
npx craftdriver go http://127.0.0.1:8080/login.html
npx craftdriver snapshot
npx craftdriver find 'label=Username' --all
npx craftdriver fill 'label=Username' alice
npx craftdriver fill 'label=Password' hunter2
npx craftdriver click 'role=button[name=Sign in]'
npx craftdriver text '#result'
npx craftdriver daemon stop
```

The daemon keeps the page and cookies between commands. Snapshot refs are
ephemeral exploration state in the current release: take a fresh snapshot
immediately before one ref action, and never copy `ref=eN` into a test. Validate
role/name, label, test ID, text, or stable CSS selectors against the live page,
then use those durable locators in test source.

The daemon uses a Unix socket and is not available on Windows. Windows agents
should use the optional MCP server for a persistent session, or run the whole
flow as one `craftdriver --ephemeral` script.

The installed `workflow.md` guides the full loop: inspect existing project test
conventions, explore, validate selectors, write the smallest test, run the
focused command, and debug from fresh browser evidence.

Read the [CLI reference](./cli.md) for all current commands.

## Optional MCP

CLI + Skill does not require MCP. For a host that prefers structured tool
calls, print the local project-pinned configuration:

```bash
npx craftdriver init codex --mcp
```

The command prints:

```toml
[mcp_servers.craftdriver]
command = "npx"
args = ["--no-install", "craftdriver", "mcp"]
```

Add it manually to the host configuration. CraftDriver never reads or writes
that configuration. See the [MCP reference](./mcp.md) for the current optional
tool surface and protocol bounds.

## Installed skill files

| File | Purpose |
| --- | --- |
| `SKILL.md` | Short browser-to-test rules and routing. |
| `workflow.md` | Exploration, selector validation, test authoring, and debugging loop. |
| `cli.md` | Current shell command reference for agent exploration. |
| `cheatsheet.md` | Public TypeScript API reference for writing tests. |
| `patterns.md` | Focused library recipes loaded on demand. |
