/**
 * Translate raw `argv` into a `(cmd, args)` pair that the dispatcher
 * understands. Hand-rolled because v1 has ~20 commands; pulling in
 * `commander`/`yargs` would dwarf the library footprint.
 *
 * Recognised global flags (anywhere on the command line):
 *   --timeout <ms>          per-call timeout override
 *   --json                  force JSON output even on a TTY
 *   --pretty                force pretty output even when piped
 *   --explain               include one-line BiDi step log (placeholder)
 *   --headless / --headed   launch option (only honoured for ephemeral / first daemon start)
 *   --browser <name>        chrome|chromium|firefox
 *   --ephemeral             run from stdin, don't talk to daemon
 *
 * Returns `null` when the user only asked for help / version.
 */
import type { LaunchOptions } from '../lib/browser.js';

export interface GlobalFlags {
  json?: boolean;
  pretty?: boolean;
  explain?: boolean;
  ephemeral?: boolean;
  help?: boolean;
  version?: boolean;
  launch: LaunchOptions;
  /** When set, `craftdriver` should set `process.env.HEADLESS` before launch. */
  headless?: boolean;
  timeout?: number;
}

export interface ParsedCommand {
  cmd: string;
  args: Record<string, unknown>;
  flags: GlobalFlags;
}

export const HELP_TEXT = `craftdriver — agent-first WebDriver CLI

USAGE
  craftdriver <command> [args...] [flags]

COMMON COMMANDS
  go <url>                          navigate the active page
  find <selector> [--all] [--limit N] [--offset M]
  click <selector>
  fill <selector> <value>
  press <key> [selector]
  hover <selector>
  text [selector] [--limit N]
  attr <selector> <name>
  value <selector>
  is visible|enabled|checked <selector>
  wait <selector> [--state visible|hidden|attached|detached] [--timeout ms]
  wait load [--state load|domcontentloaded|networkidle]
  exists <selector>                 0-wait probe; exit 0 if any match
  pages                             list open pages
  snapshot                          sanitized DOM summary with refs
                                    (use ref=eN as a selector)
  screenshot [-o file.png] [--full-page] [--selector S]
  eval <js>                         advanced; evaluate JS on active page
  back | forward | reload | status | quit

DAEMON
  daemon start                      launch background browser (Unix socket)
  daemon status                     PID, browser, active page URL
  daemon stop                       graceful shutdown

INIT (agent guide files for the current project)
  init <flavor> [--force] [--dry-run]
    flavors: agents | copilot | claude | cursor | gemini | all
    writes a short rules file under the path each tool expects:
      agents  → AGENTS.md
      copilot → .github/copilot-instructions.md
      claude  → CLAUDE.md
      cursor  → .cursor/rules/craftdriver.mdc
      gemini  → GEMINI.md
      all     → every file above

MCP SERVER (for hosted / sandboxed AI agents)
  mcp                                speak Model Context Protocol on stdio
    install snippet (Claude Code):
      claude mcp add craftdriver -- npx -y craftdriver mcp
    install snippet (Cursor / Windsurf / Zed):
      { "mcpServers": { "craftdriver": {
          "command": "npx", "args": ["-y", "craftdriver", "mcp"] } } }

EPHEMERAL MODE (sandboxed agents)
  craftdriver --ephemeral < script.txt
  (one command per line; same syntax as on the CLI)

SELECTOR SYNTAX
  CSS by default. Prefix to switch kind:
    role=button[name=Submit]   text=Sign In       label=Email
    placeholder=Search…        testid=login-btn   xpath=//div[1]

FLAGS
  --timeout <ms>                    per-call timeout (default ${5000}ms)
  --json | --pretty                 force output format
  --headless / --headed             override headless mode (first launch only)
  --browser <chrome|chromium|firefox>
  --ephemeral                       no daemon; read commands from stdin

EXIT CODES
  0 success    1 assertion/timeout/no-match    2 usage error
`;

export function parseArgv(argv: string[]): ParsedCommand | null {
  const flags: GlobalFlags = { launch: {} };
  const positional: string[] = [];
  const opts: Record<string, unknown> = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-V') flags.version = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--pretty') flags.pretty = true;
    else if (a === '--explain') flags.explain = true;
    else if (a === '--ephemeral') flags.ephemeral = true;
    else if (a === '--headless') flags.headless = true;
    else if (a === '--headed') flags.headless = false;
    else if (a === '--browser') flags.launch.browserName = argv[++i] as LaunchOptions['browserName'];
    else if (a === '--timeout') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) { flags.timeout = n; opts.timeout = n; }
    }
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--offset') opts.offset = Number(argv[++i]);
    else if (a === '--all') opts.all = true;
    else if (a === '--full-page' || a === '--fullPage') opts.fullPage = true;
    else if (a === '--state') opts.state = argv[++i];
    else if (a === '--selector') opts.selector = argv[++i];
    else if (a === '-o' || a === '--output') opts.path = argv[++i];
    else if (a === '--name') opts.name = argv[++i];
    else if (a.startsWith('--')) {
      // Unknown long flag: take a value if next token is not another flag.
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i++; }
      else opts[key] = true;
    }
    else positional.push(a);
  }

  if (flags.version) return { cmd: '__version__', args: {}, flags };
  if (flags.help && positional.length === 0) return null;
  if (positional.length === 0) {
    if (flags.help) return null;
    // No command — special-case: --ephemeral with no command means "read
    // commands from stdin". Otherwise fall through to help.
    if (flags.ephemeral) return { cmd: '__stdin__', args: {}, flags };
    flags.help = true;
    return { cmd: '__help__', args: {}, flags };
  }

  const [cmd0, ...rest] = positional;
  const lower = cmd0.toLowerCase();

  // Map surface command → dispatcher command + collect args.
  switch (lower) {
    case 'go':
    case 'goto':
    case 'navigate':
      return { cmd: 'go', args: { url: rest[0], ...opts }, flags };

    case 'click':
      return { cmd: 'click', args: { selector: rest[0], ...opts }, flags };

    case 'fill':
    case 'type':
      return { cmd: 'fill', args: { selector: rest[0], value: rest.slice(1).join(' '), ...opts }, flags };

    case 'press':
      // craftdriver press <key> [selector]
      return { cmd: 'press', args: { key: rest[0], ...(rest[1] ? { selector: rest[1] } : {}), ...opts }, flags };

    case 'hover':
      return { cmd: 'hover', args: { selector: rest[0], ...opts }, flags };

    case 'find':
      return { cmd: 'find', args: { selector: rest[0], ...opts }, flags };

    case 'exists':
      return { cmd: 'exists', args: { selector: rest[0], ...opts }, flags };

    case 'text':
      return { cmd: 'text', args: { ...(rest[0] ? { selector: rest[0] } : {}), ...opts }, flags };

    case 'attr':
    case 'attribute':
      return { cmd: 'attr', args: { selector: rest[0], name: rest[1], ...opts }, flags };

    case 'value':
      return { cmd: 'value', args: { selector: rest[0], ...opts }, flags };

    case 'is':
      // craftdriver is visible|enabled|checked <selector>
      return { cmd: 'is', args: { what: rest[0], selector: rest[1], ...opts }, flags };

    case 'wait': {
      // craftdriver wait <selector> [--state X]   OR   craftdriver wait load
      if (rest[0] === 'load') {
        return { cmd: 'wait', args: { target: 'load', kind: 'load', ...opts }, flags };
      }
      return { cmd: 'wait', args: { target: rest[0], kind: 'selector', ...opts }, flags };
    }

    case 'pages':
      return { cmd: 'pages', args: { ...opts }, flags };

    case 'screenshot':
    case 'shot':
      return { cmd: 'screenshot', args: { ...opts }, flags };

    case 'snapshot':
      // craftdriver snapshot — sanitized DOM summary for locator building
      return { cmd: 'snapshot', args: { ...opts }, flags };

    case 'eval':
      return { cmd: 'eval', args: { js: rest.join(' '), ...opts }, flags };

    case 'back':
    case 'forward':
    case 'reload':
    case 'status':
    case 'quit':
      return { cmd: lower, args: { ...opts }, flags };

    case 'daemon': {
      const sub = (rest[0] ?? 'status').toLowerCase();
      return { cmd: `daemon:${sub}`, args: { ...opts }, flags };
    }

    case 'init': {
      // craftdriver init <flavor> [--force] [--dry-run]
      const flavor = (rest[0] ?? '').toLowerCase();
      return { cmd: 'init', args: { flavor, ...opts }, flags };
    }

    case 'mcp':
      return { cmd: 'mcp', args: { ...opts }, flags };

    default:
      return { cmd: '__unknown__', args: { cmd: cmd0 }, flags };
  }
}
