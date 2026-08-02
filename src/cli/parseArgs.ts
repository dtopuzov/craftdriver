/**
 * Translate raw `argv` into a `(cmd, args)` pair that the dispatcher
 * understands. Hand-rolled because v1 has ~20 commands; pulling in
 * `commander`/`yargs` would dwarf the library footprint.
 *
 * Recognised global flags (anywhere on the command line):
 *   --timeout <ms>          per-call timeout override
 *   --json                  force JSON output even on a TTY
 *   --pretty                force pretty output even when piped
 *   --headless / --headed   launch option (only honoured for ephemeral / first daemon start)
 *   --browser <name>        chrome|chromium|firefox|safari
 *   --viewport <width>x<height>  layout viewport for `go`
 *   --ephemeral             run from stdin, don't talk to daemon
 *
 * Returns `null` when the user only asked for help / version.
 */
import { resolve } from 'node:path';
import type { LaunchOptions } from '../lib/browser.js';

export interface GlobalFlags {
  json?: boolean;
  pretty?: boolean;
  ephemeral?: boolean;
  help?: boolean;
  version?: boolean;
  launch: LaunchOptions;
  /** When set, `craftdriver` should set `process.env.HEADLESS` before launch. */
  headless?: boolean;
  timeout?: number;
  /**
   * Named daemon session. Raw and unvalidated here — `main` validates it
   * before opening a socket, so a bad name never starts a daemon.
   */
  session?: string;
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
  go|open <url> [--viewport WxH]    navigate the active page
  find <selector> [--all] [--limit N] [--offset M]
  click <selector> [--observe page|delta]
  dblclick <selector>
  fill <selector> <value> [--submit]  clear, enter the value, optionally submit
  type <text>                       type into the focused element
  clear <selector>
  check <selector> | uncheck <selector>
  select <selector> <value>         pick an <option> by its value attribute
  focus <selector>                  focus a field (caret to end), then type
  scroll <selector>
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
  page list                         open pages, marking the active one
  page open [url]                   open a tab and select it
  page select <index|id>            send later commands to that tab
  page close <index|id>             close a tab
  snapshot                          sanitized DOM summary with refs
                                    (use ref=eN as a selector)
  locators <selector>               durable selectors for an element,
                                    each re-checked against the live page
  a11y [selector] [--min-impact minor|moderate|serious|critical]
       [--rules id,id] [--disable-rules id,id] [--limit N] [--nodes N]
       [--fail-on impact]
                                    axe-core audit; each violation node
                                    carries a ref for "locators ref=eN"
  logs [list] [--kind console,error,request,response] [--level error]
       [--contains text] [--since N] [--limit N]
                                    what the page logged and requested
  logs wait --contains <text> [--kind k] [--timeout ms]
  logs clear
  mock add <url-pattern> [--status N] [--body S] [--content-type T]
                                    reply with a fixed response
  mock block <url-pattern>          fail matching requests
  mock list | mock remove <id> | mock clear
  trace start [name] [--no-screenshots]
                                    record actions, console and network
  trace stop [--zip]                stop and report where it landed
  trace status
  state save <name> [--session-storage]
                                    save cookies + local storage for reuse
  state load <name>                 restore saved login state (pre-navigation on BiDi)
  state list                        saved state names
  screenshot [-o file.png] [--full-page] [--selector S]
  eval <js> [--observe page|delta]  advanced; evaluate JS on active page
  back | forward | reload | status | quit

KEYBOARD / MOUSE / DIALOGS / UPLOAD
  key press|down|up <key> [--selector S]
  mouse move|click [selector] [--x N --y N] [--button left|middle|right]
  mouse down|up [--button left|middle|right]
  mouse wheel [selector] [--delta-x N] [--delta-y N]
  dialog inspect | dialog accept [text] | dialog dismiss
  upload <selector> <file> [file...]

REFS VS. DURABLE LOCATORS
  Refs (e1, e2, …) come from "snapshot" and are for exploration only. They
  bind to one element in one document: if it is removed, duplicated, or the
  page navigates, the ref fails with STALE_REF instead of quietly acting on
  a different element. Never put a ref in a committed test — run
  "locators <ref>" and use a candidate it reports as unique.

DAEMON
  daemon start                      launch background browser (Unix socket)
  daemon status                     PID, browser, active page URL
  daemon stop                       graceful shutdown
  Not available on Windows; use --ephemeral or MCP there.

NAMED SESSIONS
  --session <name>                  route a command to its own browser
  session list                      open sessions and the limit
  session close [name]              quit one session's browser, free the slot

  Each session owns a browser, page selection, snapshot baseline and refs.
  Sessions number their refs independently, so "e4" exists in more than one
  session and always acts on the session you addressed — never carry a ref
  between sessions. Sessions are created on first use and run independently,
  so a slow command in one does not block another. Not available with
  --ephemeral, which is a single browser that exits with the command.

INIT (safe project-local skill)
  init [--agent claude|codex|copilot|all] [--dry-run] [--mcp]
    installs the CraftDriver skill into the directories your agent reads:
      .claude/skills/craftdriver   Claude Code, Copilot
      .agents/skills/craftdriver   Codex, Copilot
    default --agent all writes both, which covers all three platforms
    --agent copilot writes .github/skills/craftdriver instead
    never reads or changes AGENTS.md, CLAUDE.md, repository instructions,
    or any host's MCP configuration
    --mcp prints project-pinned MCP snippets for manual installation

MCP SERVER (for hosted / sandboxed AI agents)
  mcp                                speak Model Context Protocol on stdio
    install snippet (Claude Code):
      claude mcp add --scope project craftdriver -- npx --no-install craftdriver mcp
    install snippet (Cursor / Windsurf / Zed):
      { "mcpServers": { "craftdriver": {
          "command": "npx", "args": ["--no-install", "craftdriver", "mcp"] } } }

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
  --browser <chrome|chromium|firefox|safari>
  --viewport <width>x<height>       override the 1280x800 agent viewport for go
  --session <name>                  named daemon session (default: default)
  --ephemeral                       no daemon; read commands from stdin

EXIT CODES
  0 success    1 assertion/timeout/no-match    2 usage error
`;

/**
 * Every flag the CLI accepts. The parser branches below are the real
 * definition; this list exists to turn a typo into a suggestion, so keep the
 * two in step — `parse-args` covers the drift.
 */
const KNOWN_FLAGS = [
  '--help',
  '--version',
  '--json',
  '--pretty',
  '--ephemeral',
  '--headless',
  '--headed',
  '--browser',
  '--session',
  '--timeout',
  '--limit',
  '--offset',
  '--all',
  '--nodes',
  '--min-impact',
  '--fail-on',
  '--rules',
  '--disable-rules',
  '--dry-run',
  '--mcp',
  '--force',
  '--full-page',
  '--session-storage',
  '--kind',
  '--level',
  '--contains',
  '--since',
  '--no-screenshots',
  '--zip',
  '--status',
  '--body',
  '--content-type',
  '--state',
  '--selector',
  '--output',
  '--name',
  '--text',
  '--button',
  '--files',
  '--delta-x',
  '--delta-y',
  '--x',
  '--y',
  '--observe',
  '--viewport',
  '--submit',
] as const;

interface CommandSyntax {
  min: number;
  max: number;
  usage: string;
  options?: readonly string[];
}

interface ActionCommandSyntax {
  defaultAction: string;
  actions: Record<string, CommandSyntax>;
}

/**
 * Positional and command-specific option contracts.
 *
 * The dispatcher still validates untrusted socket/MCP input, but the CLI must
 * reject its own mistakes before it starts a daemon or browser. Without this
 * table, `click #pay -s admin` ignored two extra arguments and `click #pay
 * --all` accepted a real-but-irrelevant flag, then reported success.
 */
const COMMAND_SYNTAX: Record<string, CommandSyntax> = {
  go: { min: 1, max: 1, usage: 'go <url> [--viewport WxH]', options: ['observe', 'viewport'] },
  click: { min: 1, max: 1, usage: 'click <selector>', options: ['observe'] },
  dblclick: { min: 1, max: 1, usage: 'dblclick <selector>', options: ['observe'] },
  fill: {
    min: 2,
    max: Infinity,
    usage: 'fill <selector> <value> [--submit]',
    options: ['observe', 'submit'],
  },
  type: { min: 1, max: Infinity, usage: 'type <text>', options: ['observe'] },
  press: { min: 1, max: 2, usage: 'press <key> [selector]', options: ['observe'] },
  hover: { min: 1, max: 1, usage: 'hover <selector>', options: ['observe'] },
  clear: { min: 1, max: 1, usage: 'clear <selector>', options: ['observe'] },
  check: { min: 1, max: 1, usage: 'check <selector>', options: ['observe'] },
  uncheck: { min: 1, max: 1, usage: 'uncheck <selector>', options: ['observe'] },
  select: { min: 2, max: Infinity, usage: 'select <selector> <value>', options: ['observe'] },
  focus: { min: 1, max: 1, usage: 'focus <selector>', options: ['observe'] },
  scroll: { min: 1, max: 1, usage: 'scroll <selector>', options: ['observe'] },
  locators: { min: 1, max: 1, usage: 'locators <selector>', options: ['limit'] },
  a11y: {
    min: 0,
    max: 1,
    usage: 'a11y [selector] [--min-impact serious] [--fail-on serious]',
    options: ['limit', 'nodes', 'minImpact', 'failOn', 'rules', 'disableRules'],
  },
  upload: {
    min: 1,
    max: Infinity,
    usage: 'upload <selector> <file> [file...]',
    options: ['files', 'observe'],
  },
  key: {
    min: 2,
    max: Infinity,
    usage: 'key press|down|up <key>',
    options: ['selector', 'observe'],
  },
  mouse: {
    min: 0,
    max: 2,
    usage: 'mouse move|click [selector] | mouse down|up | mouse wheel [selector]',
    options: ['selector', 'x', 'y', 'button', 'deltaX', 'deltaY', 'observe'],
  },
  dialog: {
    min: 0,
    max: Infinity,
    usage: 'dialog inspect | accept [text] | dismiss',
    options: ['text', 'observe'],
  },
  find: { min: 1, max: 1, usage: 'find <selector>', options: ['all', 'limit', 'offset'] },
  exists: { min: 1, max: 1, usage: 'exists <selector>' },
  text: { min: 0, max: 1, usage: 'text [selector]', options: ['limit'] },
  attr: { min: 2, max: 2, usage: 'attr <selector> <name>' },
  value: { min: 1, max: 1, usage: 'value <selector>' },
  is: { min: 2, max: 2, usage: 'is visible|enabled|checked <selector>' },
  wait: { min: 1, max: 1, usage: 'wait <selector>|load', options: ['state'] },
  pages: { min: 0, max: 0, usage: 'pages' },
  page: { min: 0, max: 2, usage: 'page list|open|select|close [target]' },
  logs: {
    min: 0,
    max: 1,
    usage: 'logs [list|wait|clear]',
    options: ['kind', 'level', 'contains', 'since', 'limit'],
  },
  mock: {
    min: 0,
    max: 2,
    usage: 'mock add|block|list|remove|clear [target]',
    options: ['status', 'body', 'contentType'],
  },
  trace: {
    min: 0,
    max: 2,
    usage: 'trace start|stop|status [name]',
    options: ['name', 'noScreenshots', 'zip'],
  },
  state: { min: 0, max: 2, usage: 'state save|load|list [name]', options: ['sessionStorage'] },
  screenshot: {
    min: 0,
    max: 0,
    usage: 'screenshot [-o file.png]',
    options: ['path', 'fullPage', 'selector'],
  },
  snapshot: { min: 0, max: 0, usage: 'snapshot' },
  eval: { min: 1, max: Infinity, usage: 'eval <javascript>', options: ['observe'] },
  back: { min: 0, max: 0, usage: 'back', options: ['observe'] },
  forward: { min: 0, max: 0, usage: 'forward', options: ['observe'] },
  reload: { min: 0, max: 0, usage: 'reload', options: ['observe'] },
  status: { min: 0, max: 0, usage: 'status' },
  quit: { min: 0, max: 0, usage: 'quit' },
  daemon: { min: 0, max: 1, usage: 'daemon start|status|stop' },
  session: { min: 0, max: 2, usage: 'session list|close [name]' },
  init: {
    min: 0,
    max: 1,
    usage: 'init [--agent claude|codex|copilot|all]',
    options: ['agent', 'dry-run', 'mcp', 'force'],
  },
  mcp: { min: 0, max: 0, usage: 'mcp' },
};

/**
 * Contracts for commands whose first positional selects an action.
 *
 * Keeping these beside the top-level table prevents a known-but-irrelevant
 * flag from disappearing: `trace start --zip` used to start a trace and
 * quietly ignore the requested archive, while `page list extra` listed pages
 * and reported success. Counts include the action token itself; the default
 * action covers the zero-token form.
 */
const ACTION_COMMAND_SYNTAX: Record<string, ActionCommandSyntax> = {
  key: {
    defaultAction: '',
    actions: {
      press: { min: 2, max: Infinity, usage: 'key press <key>', options: ['selector', 'observe'] },
      down: { min: 2, max: Infinity, usage: 'key down <key>', options: ['selector', 'observe'] },
      up: { min: 2, max: Infinity, usage: 'key up <key>', options: ['selector', 'observe'] },
      // Backward-compatible spelling; the dispatcher maps it to top-level type.
      type: { min: 2, max: Infinity, usage: 'key type <text>' },
    },
  },
  mouse: {
    defaultAction: 'move',
    actions: {
      move: {
        min: 0,
        max: 2,
        usage: 'mouse move [selector]',
        options: ['selector', 'x', 'y', 'observe'],
      },
      click: {
        min: 1,
        max: 2,
        usage: 'mouse click [selector]',
        options: ['selector', 'x', 'y', 'button', 'observe'],
      },
      down: { min: 1, max: 1, usage: 'mouse down', options: ['button', 'observe'] },
      up: { min: 1, max: 1, usage: 'mouse up', options: ['button', 'observe'] },
      wheel: {
        min: 1,
        max: 2,
        usage: 'mouse wheel [selector]',
        options: ['selector', 'deltaX', 'deltaY', 'observe'],
      },
    },
  },
  dialog: {
    defaultAction: 'inspect',
    actions: {
      inspect: { min: 0, max: 1, usage: 'dialog inspect' },
      accept: {
        min: 1,
        max: Infinity,
        usage: 'dialog accept [text]',
        options: ['text', 'observe'],
      },
      dismiss: { min: 1, max: 1, usage: 'dialog dismiss', options: ['observe'] },
    },
  },
  page: {
    defaultAction: 'list',
    actions: {
      list: { min: 0, max: 1, usage: 'page list' },
      open: { min: 1, max: 2, usage: 'page open [url]' },
      select: { min: 2, max: 2, usage: 'page select <index|id>' },
      close: { min: 2, max: 2, usage: 'page close <index|id>' },
    },
  },
  logs: {
    defaultAction: 'list',
    actions: {
      list: {
        min: 0,
        max: 1,
        usage: 'logs [list]',
        options: ['kind', 'level', 'contains', 'since', 'limit'],
      },
      wait: {
        min: 1,
        max: 1,
        usage: 'logs wait',
        options: ['kind', 'level', 'contains', 'since', 'limit'],
      },
      clear: { min: 1, max: 1, usage: 'logs clear' },
    },
  },
  mock: {
    defaultAction: 'list',
    actions: {
      list: { min: 0, max: 1, usage: 'mock list' },
      add: {
        min: 2,
        max: 2,
        usage: 'mock add <url-pattern>',
        options: ['status', 'body', 'contentType'],
      },
      block: { min: 2, max: 2, usage: 'mock block <url-pattern>' },
      remove: { min: 2, max: 2, usage: 'mock remove <id>' },
      clear: { min: 1, max: 1, usage: 'mock clear' },
    },
  },
  trace: {
    defaultAction: 'status',
    actions: {
      start: { min: 1, max: 2, usage: 'trace start [name]', options: ['name', 'noScreenshots'] },
      stop: { min: 1, max: 1, usage: 'trace stop', options: ['zip'] },
      status: { min: 0, max: 1, usage: 'trace status' },
    },
  },
  state: {
    defaultAction: 'list',
    actions: {
      save: { min: 2, max: 2, usage: 'state save <name>', options: ['sessionStorage'] },
      load: { min: 2, max: 2, usage: 'state load <name>' },
      list: { min: 0, max: 1, usage: 'state list' },
    },
  },
  daemon: {
    defaultAction: 'status',
    actions: {
      start: { min: 1, max: 1, usage: 'daemon start' },
      status: { min: 0, max: 1, usage: 'daemon status' },
      stop: { min: 1, max: 1, usage: 'daemon stop' },
      // Private child-process entry point used by autoStartDaemon.
      __run__: { min: 1, max: 1, usage: 'daemon __run__' },
    },
  },
  session: {
    defaultAction: 'list',
    actions: {
      list: { min: 0, max: 1, usage: 'session list' },
      close: { min: 1, max: 2, usage: 'session close [name]' },
    },
  },
};

/** axe-core's severity buckets, in ascending order. Mirrors `A11yImpact`. */
const A11Y_IMPACTS = ['minor', 'moderate', 'serious', 'critical'];

const COMMAND_ALIASES: Record<string, string> = {
  open: 'go',
  goto: 'go',
  navigate: 'go',
  doubleclick: 'dblclick',
  attribute: 'attr',
  shot: 'screenshot',
  log: 'logs',
};

const OPTION_FLAG: Record<string, string> = {
  'dry-run': '--dry-run',
  all: '--all',
  body: '--body',
  button: '--button',
  contains: '--contains',
  contentType: '--content-type',
  deltaX: '--delta-x',
  deltaY: '--delta-y',
  disableRules: '--disable-rules',
  failOn: '--fail-on',
  files: '--files',
  minImpact: '--min-impact',
  nodes: '--nodes',
  rules: '--rules',
  force: '--force',
  fullPage: '--full-page',
  kind: '--kind',
  level: '--level',
  limit: '--limit',
  mcp: '--mcp',
  name: '--name',
  noScreenshots: '--no-screenshots',
  offset: '--offset',
  observe: '--observe',
  viewport: '--viewport',
  path: '--output',
  selector: '--selector',
  sessionStorage: '--session-storage',
  since: '--since',
  state: '--state',
  status: '--status',
  submit: '--submit',
  text: '--text',
  x: '--x',
  y: '--y',
  zip: '--zip',
};

function usageError(flags: GlobalFlags, message: string, usage?: string): ParsedCommand {
  return {
    cmd: '__usage_error__',
    args: { message, ...(usage ? { usage: `craftdriver ${usage}` } : {}) },
    flags,
  };
}

function validateActionCommand(
  canonical: string,
  rest: string[],
  opts: Record<string, unknown>,
  flags: GlobalFlags
): ParsedCommand | null {
  const command = ACTION_COMMAND_SYNTAX[canonical];
  if (!command) return null;

  const action = (rest[0] ?? command.defaultAction).toLowerCase();
  const syntax = command.actions[action];
  if (!syntax) {
    return usageError(
      flags,
      `${canonical}: unknown action ${JSON.stringify(action)}`,
      COMMAND_SYNTAX[canonical].usage
    );
  }

  const allowed = new Set(['timeout', ...(syntax.options ?? [])]);
  const invalidOption = Object.keys(opts).find((key) => !allowed.has(key));
  if (invalidOption) {
    return usageError(
      flags,
      `${OPTION_FLAG[invalidOption] ?? `--${invalidOption}`} is not valid for ${canonical} ${action}`,
      syntax.usage
    );
  }
  if (rest.length < syntax.min) {
    return usageError(flags, `${canonical} ${action}: missing required argument`, syntax.usage);
  }
  if (rest.length > syntax.max) {
    return usageError(
      flags,
      `${canonical} ${action}: unexpected argument ${JSON.stringify(rest[syntax.max])}`,
      syntax.usage
    );
  }
  return null;
}

/** Levenshtein distance, capped by the shorter input — inputs are tiny. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length];
}

/** Nearest known flag, when one is close enough to be worth naming. */
function suggestFlag(flag: string): { suggestion?: string } {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const known of KNOWN_FLAGS) {
    const d = editDistance(flag, known);
    if (d < bestDistance) {
      bestDistance = d;
      best = known;
    }
  }
  // Beyond a couple of edits the "did you mean" is noise, not help.
  return best && bestDistance <= 3 ? { suggestion: best } : {};
}

export function parseArgv(argv: string[]): ParsedCommand | null {
  const flags: GlobalFlags = { launch: {} };
  const positional: string[] = [];
  const opts: Record<string, unknown> = {};

  const takeValue = (flag: string, index: number): string | ParsedCommand => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return usageError(flags, `${flag} requires a value`);
    }
    return value;
  };

  const takeNumber = (
    flag: string,
    index: number,
    limits: { integer?: boolean; min?: number; max?: number } = {}
  ): number | ParsedCommand => {
    const raw = takeValue(flag, index);
    if (typeof raw !== 'string') return raw;
    const value = Number(raw);
    const invalid =
      !Number.isFinite(value) ||
      (limits.integer === true && !Number.isInteger(value)) ||
      (limits.min !== undefined && value < limits.min) ||
      (limits.max !== undefined && value > limits.max);
    if (invalid) {
      const range =
        limits.min !== undefined || limits.max !== undefined
          ? ` (${limits.min ?? '-∞'}..${limits.max ?? '∞'})`
          : '';
      return usageError(
        flags,
        `${flag} requires ${limits.integer ? 'an integer' : 'a number'}${range}; got ${JSON.stringify(raw)}`
      );
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-V') flags.version = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--pretty') flags.pretty = true;
    else if (a === '--ephemeral') flags.ephemeral = true;
    else if (a === '--headless') flags.headless = true;
    else if (a === '--headed') flags.headless = false;
    else if (a === '--browser') {
      const value = takeValue(a, i);
      if (typeof value !== 'string') return value;
      if (!['chrome', 'chromium', 'firefox', 'safari'].includes(value)) {
        return usageError(flags, `--browser: unknown browser ${JSON.stringify(value)}`);
      }
      flags.launch.browserName = value as LaunchOptions['browserName'];
      i += 1;
    }
    // A global flag, not a command arg: it addresses a session rather than
    // parameterising a command, and the dispatcher never sees it.
    else if (a === '--session') {
      const value = takeValue(a, i);
      if (typeof value !== 'string') return value;
      flags.session = value;
      i += 1;
    } else if (a === '--timeout') {
      const value = takeNumber(a, i, { integer: true, min: 0, max: 300_000 });
      if (typeof value !== 'number') return value;
      flags.timeout = value;
      opts.timeout = value;
      i += 1;
    } else if (a === '--limit') {
      const value = takeNumber(a, i, { integer: true });
      if (typeof value !== 'number') return value;
      opts.limit = value;
      i += 1;
    } else if (a === '--offset') {
      const value = takeNumber(a, i, { integer: true, min: 0 });
      if (typeof value !== 'number') return value;
      opts.offset = value;
      i += 1;
    } else if (a === '--nodes') {
      const value = takeNumber(a, i, { integer: true });
      if (typeof value !== 'number') return value;
      opts.nodes = value;
      i += 1;
    }
    // Validated here as well as in the dispatcher: a typo'd impact should cost
    // a usage error, not a daemon start and a browser launch.
    else if (a === '--min-impact' || a === '--fail-on') {
      const value = takeValue(a, i);
      if (typeof value !== 'string') return value;
      if (!A11Y_IMPACTS.includes(value.toLowerCase())) {
        return usageError(
          flags,
          `${a}: expected one of ${A11Y_IMPACTS.join('|')}, got ${JSON.stringify(value)}`
        );
      }
      opts[a === '--fail-on' ? 'failOn' : 'minImpact'] = value.toLowerCase();
      i += 1;
    } else if (a === '--rules' || a === '--disable-rules') {
      const value = takeValue(a, i);
      if (typeof value !== 'string') return value;
      opts[a === '--rules' ? 'rules' : 'disableRules'] = value;
      i += 1;
    } else if (a === '--all') opts.all = true;
    else if (a === '--submit') opts.submit = true;
    else if (a === '--dry-run') opts['dry-run'] = true;
    else if (a === '--mcp') opts.mcp = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--full-page' || a === '--fullPage') opts.fullPage = true;
    else if (a === '--session-storage' || a === '--sessionStorage') opts.sessionStorage = true;
    else if (a === '--kind' || a === '--level' || a === '--contains') {
      const value = takeValue(a, i);
      if (typeof value !== 'string') return value;
      opts[a.slice(2)] = value;
      i += 1;
    } else if (a === '--agent') {
      const value = takeValue(a, i);
      if (typeof value !== 'string') return value;
      if (!['claude', 'codex', 'copilot', 'all'].includes(value.toLowerCase())) {
        return usageError(flags, `--agent: unknown agent ${JSON.stringify(value)}`);
      }
      opts.agent = value.toLowerCase();
      i += 1;
    } else if (a === '--since') {
      const value = takeNumber(a, i, { integer: true, min: 0 });
      if (typeof value !== 'number') return value;
      opts.since = value;
      i += 1;
    } else if (a === '--observe' || a.startsWith('--observe=')) {
      const inline = a.startsWith('--observe=');
      const value = inline ? a.slice('--observe='.length) : takeValue(a, i);
      if (typeof value !== 'string') return value;
      if (value !== 'page' && value !== 'delta') {
        return usageError(
          flags,
          `--observe: expected "page" or "delta", got ${JSON.stringify(value)}`
        );
      }
      opts.observe = value;
      if (!inline) i += 1;
    } else if (a === '--viewport') {
      const raw = takeValue(a, i);
      if (typeof raw !== 'string') return raw;
      const match = /^(\d{1,5})[xX](\d{1,5})$/.exec(raw);
      const width = match ? Number(match[1]) : 0;
      const height = match ? Number(match[2]) : 0;
      if (!match || width < 100 || width > 10_000 || height < 100 || height > 10_000) {
        return usageError(
          flags,
          `--viewport requires WIDTHxHEIGHT with each dimension in 100..10000; got ${JSON.stringify(raw)}`
        );
      }
      opts.viewport = { width, height };
      i += 1;
    } else if (a === '--no-screenshots' || a === '--noScreenshots') opts.noScreenshots = true;
    else if (a === '--zip') opts.zip = true;
    else if (a === '--status') {
      const value = takeNumber(a, i, { integer: true, min: 100, max: 599 });
      if (typeof value !== 'number') return value;
      opts.status = value;
      i += 1;
    } else if (
      a === '--body' ||
      a === '--content-type' ||
      a === '--contentType' ||
      a === '--state' ||
      a === '--selector' ||
      a === '--name' ||
      a === '--text' ||
      a === '--button'
    ) {
      const value = takeValue(a, i);
      if (typeof value !== 'string') return value;
      const key = a === '--content-type' || a === '--contentType' ? 'contentType' : a.slice(2);
      opts[key] = value;
      i += 1;
    } else if (a === '-o' || a === '--output') {
      const value = takeValue(a, i);
      if (typeof value !== 'string') return value;
      // Resolve in the short-lived caller process. The daemon has a different,
      // long-lived cwd, so sending a relative output path there writes to the
      // wrong directory.
      opts.path = resolve(value);
      i += 1;
    }
    // Resolved here, in the caller's process, for the same reason the
    // positional form is: the daemon has its own long-lived cwd.
    else if (a === '--files') {
      const value = takeValue(a, i);
      if (typeof value !== 'string') return value;
      opts.files = value
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f.length > 0)
        .map((f) => resolve(f));
      i += 1;
    } else if (
      a === '--delta-x' ||
      a === '--deltaX' ||
      a === '--delta-y' ||
      a === '--deltaY' ||
      a === '--x' ||
      a === '--y'
    ) {
      const value = takeNumber(a, i, { integer: true });
      if (typeof value !== 'number') return value;
      const key =
        a === '--delta-x' || a === '--deltaX'
          ? 'deltaX'
          : a === '--delta-y' || a === '--deltaY'
            ? 'deltaY'
            : a.slice(2);
      opts[key] = value;
      i += 1;
    }
    // Everything after a bare `--` is data, so text that looks like a flag
    // can still be typed: `type -- --draft`.
    else if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    // Unknown long flags are a usage error, never silently absorbed. Accepting
    // them meant `--sesion admin` ran against the default session: the typo
    // vanished and a destructive command hit the wrong browser and the wrong
    // login. Failing closed is the only safe reading of an unrecognised flag.
    //
    // Single-dash tokens are left alone: `type -bob` types the text "-bob",
    // and `--delta-y -100` passes a negative number. Only `-h`, `-V` and `-o`
    // are short flags, so there is little to typo and much to break.
    else if (a.startsWith('--')) {
      return { cmd: '__unknown_flag__', args: { flag: a, ...suggestFlag(a) }, flags };
    } else positional.push(a);
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
  const canonical = COMMAND_ALIASES[lower] ?? lower;
  const syntax = COMMAND_SYNTAX[canonical];
  if (syntax) {
    const allowed = new Set(['timeout', ...(syntax.options ?? [])]);
    const invalidOption = Object.keys(opts).find((key) => !allowed.has(key));
    if (invalidOption) {
      return usageError(
        flags,
        `${OPTION_FLAG[invalidOption] ?? `--${invalidOption}`} is not valid for ${cmd0}`,
        syntax.usage
      );
    }
    if (rest.length < syntax.min) {
      return usageError(flags, `${cmd0}: missing required argument`, syntax.usage);
    }
    if (rest.length > syntax.max) {
      return usageError(
        flags,
        `${cmd0}: unexpected argument ${JSON.stringify(rest[syntax.max])}`,
        syntax.usage
      );
    }
  }

  const actionError = validateActionCommand(canonical, rest, opts, flags);
  if (actionError) return actionError;

  if (canonical === 'upload') {
    const optionFiles = Array.isArray(opts.files) ? opts.files : [];
    if (rest.length < 2 && optionFiles.length === 0) {
      return usageError(
        flags,
        'upload: missing required argument "file"',
        COMMAND_SYNTAX.upload.usage
      );
    }
  }

  if (canonical === 'is' && !['visible', 'enabled', 'checked'].includes(rest[0].toLowerCase())) {
    return usageError(
      flags,
      `is: unknown state ${JSON.stringify(rest[0])}`,
      COMMAND_SYNTAX.is.usage
    );
  }

  if (canonical === 'wait' && typeof opts.state === 'string') {
    const states =
      rest[0] === 'load'
        ? ['load', 'domcontentloaded', 'networkidle']
        : ['visible', 'hidden', 'attached', 'detached'];
    if (!states.includes(opts.state)) {
      return usageError(
        flags,
        `wait: unknown state ${JSON.stringify(opts.state)}`,
        COMMAND_SYNTAX.wait.usage
      );
    }
  }

  // `init codex` is the pre-1.10 spelling of `init --agent codex`. It stays
  // working so existing setup scripts don't break; the command warns.
  if (canonical === 'init' && rest.length > 0) {
    if (rest[0].toLowerCase() !== 'codex') {
      return usageError(
        flags,
        `init: unknown target ${JSON.stringify(rest[0])}`,
        COMMAND_SYNTAX.init.usage
      );
    }
    // Two ways of naming the target in one command line. Even when they agree,
    // silently letting one win is worse than saying they conflict — the losing
    // spelling is what the caller believed they asked for.
    if (opts.agent !== undefined) {
      return usageError(
        flags,
        'init: `init codex` and `--agent` cannot be combined; use `--agent` alone',
        COMMAND_SYNTAX.init.usage
      );
    }
  }

  // Map surface command → dispatcher command + collect args.
  switch (lower) {
    case 'go':
    case 'open':
    case 'goto':
    case 'navigate':
      return { cmd: 'go', args: { url: rest[0], ...opts }, flags };

    case 'click':
      return { cmd: 'click', args: { selector: rest[0], ...opts }, flags };

    case 'fill':
      return {
        cmd: 'fill',
        args: { selector: rest[0], value: rest.slice(1).join(' '), ...opts },
        flags,
      };

    case 'type':
      // BREAKING (was an alias for `fill`): `type` now types into the
      // focused element and takes no selector, matching `playwright-cli
      // type <text>`. Use `fill <selector> <value>` to target a field.
      return { cmd: 'type', args: { text: rest.join(' '), ...opts }, flags };

    case 'press':
      // craftdriver press <key> [selector]
      return {
        cmd: 'press',
        args: { key: rest[0], ...(rest[1] ? { selector: rest[1] } : {}), ...opts },
        flags,
      };

    case 'hover':
      return { cmd: 'hover', args: { selector: rest[0], ...opts }, flags };

    case 'dblclick':
    case 'doubleclick':
      return { cmd: 'dblclick', args: { selector: rest[0], ...opts }, flags };

    case 'clear':
      return { cmd: 'clear', args: { selector: rest[0], ...opts }, flags };

    case 'check':
    case 'uncheck':
      return { cmd: lower, args: { selector: rest[0], ...opts }, flags };

    case 'select':
      // craftdriver select <selector> <value>
      return {
        cmd: 'select',
        args: { selector: rest[0], value: rest.slice(1).join(' '), ...opts },
        flags,
      };

    case 'focus':
    case 'scroll':
      return { cmd: lower, args: { selector: rest[0], ...opts }, flags };

    case 'locators':
      // craftdriver locators <selector> — durable selectors for a ref
      return { cmd: 'locators', args: { selector: rest[0], ...opts }, flags };

    case 'a11y':
      // craftdriver a11y [selector] — optional positional scopes the audit,
      // mirroring `text [selector]` and the library's `locator(sel).a11y`.
      return { cmd: 'a11y', args: { ...(rest[0] ? { selector: rest[0] } : {}), ...opts }, flags };

    case 'upload': {
      // craftdriver upload <selector> <file> [file...]
      //
      // Resolve paths here, in the caller's process. The daemon is a
      // long-lived process with its own cwd, so a relative path sent over
      // the socket would resolve against wherever the daemon was started.
      const files = rest.slice(1).map((f) => resolve(f));
      return {
        cmd: 'upload',
        args: {
          selector: rest[0],
          ...(files.length > 0 ? { files } : {}),
          ...opts,
        },
        flags,
      };
    }

    case 'key': {
      // craftdriver key press|down|up <key> [--selector S]
      const action = (rest[0] ?? 'press').toLowerCase();
      const value = rest.slice(1).join(' ');
      // `key type` was folded into the top-level `type` command. Route it
      // there rather than emitting args the dispatcher cannot service.
      if (action === 'type') {
        return { cmd: 'type', args: { text: value, ...opts }, flags };
      }
      return { cmd: 'key', args: { action, key: value, ...opts }, flags };
    }

    case 'mouse': {
      // craftdriver mouse move|click|wheel [selector] | down|up
      const action = (rest[0] ?? 'move').toLowerCase();
      return {
        cmd: 'mouse',
        args: { action, ...(rest[1] ? { selector: rest[1] } : {}), ...opts },
        flags,
      };
    }

    case 'dialog': {
      // craftdriver dialog inspect | accept [text] | dismiss
      const action = (rest[0] ?? 'inspect').toLowerCase();
      return {
        cmd: 'dialog',
        args: { action, ...(rest[1] ? { text: rest.slice(1).join(' ') } : {}), ...opts },
        flags,
      };
    }

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

    case 'page': {
      // craftdriver page list|open [url]|select <index|id>|close <index|id>
      const action = (rest[0] ?? 'list').toLowerCase();
      const target = rest[1];
      return {
        cmd: 'page',
        args: {
          action,
          ...(action === 'open' && target ? { url: target } : {}),
          ...(action !== 'open' && target ? { target } : {}),
          ...opts,
        },
        flags,
      };
    }

    case 'logs':
    case 'log': {
      // craftdriver logs [list|wait|clear] [--kind k] [--level l]
      //                  [--contains s] [--since N] [--limit N]
      const action = (rest[0] ?? 'list').toLowerCase();
      return { cmd: 'logs', args: { action, ...opts }, flags };
    }

    case 'mock': {
      // craftdriver mock add <pattern> [--status N] [--body S] [--content-type T]
      //                 | block <pattern> | list | remove <id> | clear
      const action = (rest[0] ?? 'list').toLowerCase();
      const target = rest[1];
      return {
        cmd: 'mock',
        args: {
          action,
          ...(action === 'remove' && target ? { id: target } : {}),
          ...((action === 'add' || action === 'block') && target ? { pattern: target } : {}),
          ...opts,
        },
        flags,
      };
    }

    case 'trace': {
      // craftdriver trace start [name] [--no-screenshots] | stop [--zip] | status
      const action = (rest[0] ?? 'status').toLowerCase();
      return {
        cmd: 'trace',
        args: {
          action,
          ...(action === 'start' && rest[1] ? { name: rest[1] } : {}),
          ...opts,
        },
        flags,
      };
    }

    case 'state': {
      // craftdriver state save <name> [--session-storage] | load <name> | list
      const action = (rest[0] ?? 'list').toLowerCase();
      return {
        cmd: 'state',
        args: {
          action,
          ...(rest[1] ? { name: rest[1] } : {}),
          ...opts,
        },
        flags,
      };
    }

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

    case 'session': {
      // craftdriver session list | close [name]
      //
      // `close` takes the name positionally or from `--session`, so both
      // `session close checkout` and `session close --session checkout` work.
      const sub = (rest[0] ?? 'list').toLowerCase();
      return {
        cmd: `session:${sub}`,
        args: { ...(rest[1] ? { target: rest[1] } : {}), ...opts },
        flags,
      };
    }

    case 'init': {
      // craftdriver init [--agent claude|codex|copilot|all] [--dry-run] [--mcp]
      const deprecatedFlavor = rest[0]?.toLowerCase() === 'codex';
      return {
        cmd: 'init',
        args: {
          ...(deprecatedFlavor ? { agent: 'codex', deprecatedFlavor: true } : {}),
          ...opts,
        },
        flags,
      };
    }

    case 'mcp':
      return { cmd: 'mcp', args: { ...opts }, flags };

    default:
      return { cmd: '__unknown__', args: { cmd: cmd0 }, flags };
  }
}
