# AI Agent Guide

CraftDriver ships agent-facing tooling in the npm package. You can use the library directly, drive the browser from the shell, expose tools through MCP, or drop assistant rules into a project.

## Which Surface Should I Use?

| Agent environment          | Best surface       | Why                                                                              |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| Shell-capable coding agent | CLI                | Simple commands, persistent daemon, JSON output when piped.                      |
| MCP-aware host             | MCP server         | Typed tools, compact accessibility snapshots, artifact spilling for screenshots. |
| Code-writing assistant     | `craftdriver init` | Project rules teach selector preference, auto-waiting, and error-code handling.  |
| Custom orchestrator        | Skill pack         | Small always-on `SKILL.md` with deeper references loaded on demand.              |

## CLI

The CLI is good for agents that can run shell commands.

```bash
npx craftdriver daemon start
npx craftdriver go http://127.0.0.1:8080/login.html
npx craftdriver snapshot
npx craftdriver fill 'label=Username' alice
npx craftdriver fill 'label=Password' hunter2
npx craftdriver click 'role=button[name=Sign in]'
npx craftdriver text '#result'
npx craftdriver daemon stop
```

State survives between calls while the daemon is running, so an agent can explore, act, inspect, and refine.

Read the full [CLI reference](./cli.md).

## MCP Server

MCP-aware hosts can use `craftdriver mcp`.

```bash
claude mcp add craftdriver -- npx -y craftdriver mcp
```

```jsonc
{
  "mcpServers": {
    "craftdriver": {
      "command": "npx",
      "args": ["-y", "craftdriver", "mcp"],
    },
  },
}
```

Mutating tools return compact accessibility snapshot diffs, so the agent can see what changed without a separate read. Large artifacts such as screenshots are written to disk instead of inlined into model context.

Read the full [MCP reference](./mcp.md).

## Assistant Bootstrap Files

Use `craftdriver init` inside a project that uses CraftDriver:

```bash
npx craftdriver init agents
npx craftdriver init copilot
npx craftdriver init claude
npx craftdriver init cursor
npx craftdriver init gemini
npx craftdriver init all
```

The generated files tell assistants to:

- prefer semantic selectors before brittle CSS
- rely on auto-waiting instead of sleeps
- inspect stable `CraftdriverError.code` values
- use the CLI or MCP server for live browser work
- keep test code aligned with the public TypeScript API

## Skill Pack

The npm tarball includes a tiered skill pack under `skills/craftdriver/`:

| File            | Purpose                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| `SKILL.md`      | Always-on rules and routing, kept small for model context.                             |
| `cheatsheet.md` | Fast command and API reference for tests.                                              |
| `patterns.md`   | Worked recipes such as login, uploads, network waits, a11y, tracing, and virtual time. |
| `cli.md`        | Agent-facing CLI reference.                                                            |

Point compatible agents at:

```text
node_modules/craftdriver/skills/craftdriver/SKILL.md
```
