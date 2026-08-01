/**
 * MCP tool registry.
 *
 * Each tool is a parameter descriptor plus a thin mapping onto an existing
 * dispatcher command. Three rules keep this an adapter rather than a second
 * implementation:
 *
 * - **No MCP-only browser semantics.** Every tool dispatches a command the CLI
 *   also has, with the same arguments. Where the CLI command takes an `action`,
 *   the tool does too — mirroring its shape rather than inventing a nicer one
 *   is what keeps the two from drifting.
 * - **One declaration per argument.** `params` produces both the advertised
 *   `inputSchema` and the runtime validation, so a tool cannot promise a
 *   constraint it does not enforce.
 * - **Whether an action mutates the page is not declared here.** The
 *   dispatcher's `MUTATING` set decides, and the presence of a post-action
 *   delta is the only signal. A per-tool flag was a second source of truth
 *   once already: it marked `browser_advanced_eval` mutating while the
 *   dispatcher did not, so the one tool that can rewrite a page never
 *   reported its changes.
 *
 * The set is kept deliberately smaller than the CLI's command list. Every tool
 * costs context in `tools/list` on every agent turn, so element actions that
 * share a signature are grouped behind one `action` argument instead of
 * becoming seven tools.
 */
import type { AgentDetailedResult, AgentSessionRunner } from '../agentSession.js';
import { toInputSchema, validateArgs, type ParamSpecs } from './params.js';

/**
 * MCP tool annotations.
 *
 * Accuracy matters more than completeness here: a client may use these to
 * decide what to auto-approve, so a wrong `readOnlyHint` is worse than an
 * absent one.
 */
export interface ToolAnnotations {
  title: string;
  /** Does not change the page or any persistent state. */
  readOnlyHint: boolean;
  /** May destroy state a user would not want destroyed. */
  destructiveHint: boolean;
  /** Repeating the call with the same arguments changes nothing further. */
  idempotentHint: boolean;
  /** Interacts with the outside world (the web, the filesystem). */
  openWorldHint: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  params: ParamSpecs;
  annotations: ToolAnnotations;
  /** Map validated MCP args → dispatcher args. */
  toDispatch: (args: Record<string, unknown>) => { cmd: string; args: Record<string, unknown> };
}

const SELECTOR = {
  type: 'string',
  required: true,
  description:
    "CSS by default. Switch kind with a prefix: 'role=button[name=Submit]', " +
    "'text=Sign In', 'text*=Sign', 'label=Email', 'placeholder=...', " +
    "'testid=...', 'xpath=...', 'id=...', 'name=...', or 'ref=eN' from a snapshot. " +
    'Bare eN is accepted only after this session issued it; use css=eN for a literal element.',
} as const;

const OPTIONAL_SELECTOR = { ...SELECTOR, required: false } as const;
const TIMEOUT = { type: 'number', min: 0, max: 300_000, description: 'Milliseconds.' } as const;

/** A page action that changes what the user sees. */
function mutating(title: string, openWorld = true): ToolAnnotations {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: openWorld,
  };
}

/** An inspection that changes nothing. */
function readOnly(title: string, openWorld = true): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: openWorld,
  };
}

export const TOOLS: ToolDef[] = [
  // ---- navigation and core actions ---------------------------------------
  {
    name: 'browser_navigate',
    description: 'Navigate the active page to a URL. Waits for load.',
    params: { url: { type: 'string', required: true, maxLength: 2048 } },
    annotations: mutating('Navigate'),
    toDispatch: (a) => ({ cmd: 'go', args: { url: a.url } }),
  },
  {
    name: 'browser_click',
    description:
      'Click an element. Auto-waits for visible+enabled. Returns NO_MATCH immediately ' +
      'when the selector matches zero elements at t=0. Set double for a double-click.',
    params: {
      selector: SELECTOR,
      double: { type: 'boolean', description: 'Double-click instead of single.' },
      timeout_ms: TIMEOUT,
    },
    annotations: mutating('Click'),
    toDispatch: (a) => ({
      cmd: a.double === true ? 'dblclick' : 'click',
      args: { selector: a.selector, timeout: a.timeout_ms },
    }),
  },
  {
    name: 'browser_fill',
    description:
      'Fill an input/textarea. Clears first, then enters the value with real key events. ' +
      'Set submit to press Enter through the focused field in the same action. ' +
      'For checkboxes use browser_element with action=check.',
    params: {
      selector: SELECTOR,
      value: { type: 'string', required: true },
      submit: {
        type: 'boolean',
        description: 'Press Enter after filling, without resolving the selector again.',
      },
      timeout_ms: TIMEOUT,
    },
    annotations: mutating('Fill field'),
    toDispatch: (a) => ({
      cmd: 'fill',
      args: { selector: a.selector, value: a.value, submit: a.submit, timeout: a.timeout_ms },
    }),
  },
  {
    name: 'browser_type',
    description:
      'Type text into whatever currently holds focus. No selector — use browser_fill to ' +
      'target a field, or browser_element with action=focus first to append.',
    params: { text: { type: 'string', required: true } },
    annotations: mutating('Type into focus'),
    toDispatch: (a) => ({ cmd: 'type', args: { text: a.text } }),
  },
  {
    name: 'browser_element',
    description:
      'Act on one element: dblclick, focus, scroll, clear, check, uncheck, or select. ' +
      'check/uncheck are idempotent and read the state back. select matches an <option> ' +
      'by its value attribute, not its label.',
    params: {
      action: {
        type: 'string',
        required: true,
        enum: ['dblclick', 'focus', 'scroll', 'clear', 'check', 'uncheck', 'select'],
      },
      selector: SELECTOR,
      value: { type: 'string', description: 'Option value; required for action=select.' },
      timeout_ms: TIMEOUT,
    },
    annotations: mutating('Element action'),
    toDispatch: (a) => ({
      cmd: a.action as string,
      args: {
        selector: a.selector,
        ...(a.value !== undefined ? { value: a.value } : {}),
        timeout: a.timeout_ms,
      },
    }),
  },
  {
    name: 'browser_press',
    description: 'Press a key (e.g. "Enter", "Tab", "Control+A"). Optional selector focuses first.',
    params: { key: { type: 'string', required: true, maxLength: 64 }, selector: OPTIONAL_SELECTOR },
    annotations: mutating('Press key'),
    toDispatch: (a) => ({
      cmd: 'press',
      args: { key: a.key, ...(a.selector ? { selector: a.selector } : {}) },
    }),
  },
  {
    name: 'browser_key',
    description:
      'Low-level keyboard control: hold a key down, release it, or press it. Use for ' +
      'modifier combinations that browser_press cannot express.',
    params: {
      action: { type: 'string', required: true, enum: ['press', 'down', 'up'] },
      key: { type: 'string', required: true, maxLength: 64 },
      selector: OPTIONAL_SELECTOR,
    },
    annotations: mutating('Keyboard'),
    toDispatch: (a) => ({
      cmd: 'key',
      args: { action: a.action, key: a.key, ...(a.selector ? { selector: a.selector } : {}) },
    }),
  },
  {
    name: 'browser_mouse',
    description:
      'Move, click, press, release, or wheel the mouse, by element or by coordinate. ' +
      'Use for drag, hover-reveal, and canvas interactions.',
    params: {
      action: { type: 'string', required: true, enum: ['move', 'click', 'down', 'up', 'wheel'] },
      selector: OPTIONAL_SELECTOR,
      x: { type: 'number' },
      y: { type: 'number' },
      button: { type: 'string', enum: ['left', 'middle', 'right'] },
      delta_x: { type: 'number' },
      delta_y: { type: 'number' },
    },
    annotations: mutating('Mouse'),
    toDispatch: (a) => ({
      cmd: 'mouse',
      args: {
        action: a.action,
        ...(a.selector ? { selector: a.selector } : {}),
        x: a.x,
        y: a.y,
        button: a.button,
        deltaX: a.delta_x,
        deltaY: a.delta_y,
      },
    }),
  },
  {
    name: 'browser_hover',
    description: 'Hover over an element.',
    params: { selector: SELECTOR, timeout_ms: TIMEOUT },
    annotations: mutating('Hover'),
    toDispatch: (a) => ({ cmd: 'hover', args: { selector: a.selector, timeout: a.timeout_ms } }),
  },
  {
    name: 'browser_upload',
    description:
      'Set files on a file input. Paths must already exist and are never echoed back. ' +
      'Bounded in count.',
    params: {
      selector: SELECTOR,
      files: { type: 'string[]', required: true, maxItems: 10, maxLength: 4096 },
    },
    annotations: { ...mutating('Upload files'), openWorldHint: true },
    toDispatch: (a) => ({ cmd: 'upload', args: { selector: a.selector, files: a.files } }),
  },
  {
    name: 'browser_dialog',
    description:
      'Inspect, accept, or dismiss a native dialog (alert/confirm/prompt). An open dialog ' +
      'blocks page script, so handle it before anything else.',
    params: {
      action: { type: 'string', required: true, enum: ['inspect', 'accept', 'dismiss'] },
      text: { type: 'string', description: 'Prompt answer; used with accept.' },
    },
    annotations: mutating('Dialog'),
    toDispatch: (a) => ({
      cmd: 'dialog',
      args: { action: a.action, ...(a.text !== undefined ? { text: a.text } : {}) },
    }),
  },

  // ---- inspection ---------------------------------------------------------
  {
    name: 'browser_find',
    description:
      'Locate elements without acting on them. Returns up to `limit` matches with tag, ' +
      'text snippet, and visibility. Use `all` to enumerate.',
    params: {
      selector: SELECTOR,
      all: { type: 'boolean' },
      limit: { type: 'number', min: 1, max: 500, integer: true },
      offset: { type: 'number', min: 0, integer: true },
    },
    annotations: readOnly('Find elements'),
    toDispatch: (a) => ({
      cmd: 'find',
      args: { selector: a.selector, all: a.all, limit: a.limit, offset: a.offset },
    }),
  },
  {
    name: 'browser_exists',
    description:
      'Zero-wait probe: returns { exists, count } immediately. Call this BEFORE clicking or ' +
      'waiting when guessing a selector — one roundtrip instead of the full timeout.',
    params: { selector: SELECTOR },
    annotations: readOnly('Probe selector'),
    toDispatch: (a) => ({ cmd: 'exists', args: { selector: a.selector } }),
  },
  {
    name: 'browser_read',
    description:
      'Read text/attr/value/is-state from an element, or page body text when no selector ' +
      'is given. `kind` defaults to "text".',
    params: {
      selector: OPTIONAL_SELECTOR,
      kind: { type: 'string', enum: ['text', 'attr', 'value', 'is'] },
      name: { type: 'string', description: 'Attribute name when kind=attr.' },
      what: {
        type: 'string',
        enum: ['visible', 'enabled', 'checked'],
        description: 'State when kind=is.',
      },
    },
    annotations: readOnly('Read element'),
    toDispatch: (a) => {
      const kind = (a.kind as string | undefined) ?? 'text';
      if (kind === 'attr') return { cmd: 'attr', args: { selector: a.selector, name: a.name } };
      if (kind === 'value') return { cmd: 'value', args: { selector: a.selector } };
      if (kind === 'is') return { cmd: 'is', args: { selector: a.selector, what: a.what } };
      return { cmd: 'text', args: { ...(a.selector ? { selector: a.selector } : {}) } };
    },
  },
  {
    name: 'browser_wait',
    description:
      'Wait for a selector to become visible/hidden/attached/detached, or for a load state ' +
      '(load|domcontentloaded|networkidle).',
    params: {
      target: { type: 'string', required: true },
      kind: { type: 'string', enum: ['selector', 'load'] },
      state: { type: 'string', maxLength: 32 },
      timeout_ms: TIMEOUT,
    },
    annotations: readOnly('Wait for condition'),
    toDispatch: (a) => ({
      cmd: 'wait',
      args: { target: a.target, kind: a.kind ?? 'selector', state: a.state, timeout: a.timeout_ms },
    }),
  },
  {
    name: 'browser_snapshot',
    description:
      'Sanitized accessibility-tree summary of the active page: one line per visible ' +
      'interactive element with role, accessible name, and a stable ref (e1, e2, …). Use ' +
      '`ref=eN` as a selector for later calls. A ref binds to one element and fails ' +
      'STALE_REF rather than drifting; it is exploration state and never belongs in a test.',
    params: {},
    annotations: readOnly('Page snapshot'),
    toDispatch: () => ({ cmd: 'snapshot', args: {} }),
  },
  {
    name: 'browser_locators',
    description:
      'Turn an element into durable selectors for a committed test, ordered by resilience ' +
      '(role+name, label, test id, unique text, minimal CSS) and each re-checked against ' +
      'the live page. Use this to convert a snapshot ref into something a test can keep. ' +
      'No candidate ever contains a ref.',
    params: {
      selector: SELECTOR,
      limit: { type: 'number', min: 1, max: 20, integer: true },
    },
    annotations: readOnly('Durable selectors'),
    toDispatch: (a) => ({ cmd: 'locators', args: { selector: a.selector, limit: a.limit } }),
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture a PNG of the active page or one element. Written to disk under the ' +
      'per-session artifact directory; the response carries the path and byte count, not ' +
      'image tokens.',
    // No destination parameter: the description promises the per-session
    // artifact directory, and a caller-supplied path made that promise false
    // — it could write a PNG anywhere the process could reach. The server
    // allocates the path instead.
    params: {
      selector: OPTIONAL_SELECTOR,
      full_page: { type: 'boolean' },
    },
    annotations: { ...readOnly('Screenshot'), idempotentHint: false },
    toDispatch: (a) => ({
      cmd: 'screenshot',
      args: {
        ...(a.selector ? { selector: a.selector } : {}),
        fullPage: a.full_page,
      },
    }),
  },
  {
    name: 'browser_status',
    description: 'Report whether a browser is up and which URL is active.',
    params: {},
    annotations: readOnly('Status', false),
    toDispatch: () => ({ cmd: 'status', args: {} }),
  },

  // ---- pages, evidence, and artifacts -------------------------------------
  {
    name: 'browser_page',
    description:
      'List, open, select, or close a tab. A tab the application opens is listed but never ' +
      'selected implicitly. Switching or closing clears refs, so snapshot again afterwards.',
    params: {
      action: { type: 'string', required: true, enum: ['list', 'open', 'select', 'close'] },
      target: { type: 'string', maxLength: 128, description: 'Index or page id.' },
      url: { type: 'string', maxLength: 2048, description: 'Used with action=open.' },
    },
    annotations: mutating('Tabs'),
    toDispatch: (a) => ({
      cmd: 'page',
      args: {
        action: a.action,
        ...(a.target !== undefined ? { target: a.target } : {}),
        ...(a.url !== undefined ? { url: a.url } : {}),
      },
    }),
  },
  {
    name: 'browser_logs',
    description:
      'Console and network history for this session, captured from launch — so an error ' +
      'thrown during the first navigation is still answerable. Every result carries a ' +
      'cursor; pass it back as `since` for only what is new. kind=error covers both ' +
      'uncaught exceptions and console.error. Network rows are summaries: no bodies, ' +
      'cookies or headers.',
    params: {
      action: { type: 'string', enum: ['list', 'wait', 'clear'] },
      kind: {
        type: 'string',
        maxLength: 64,
        description: 'Comma-separated: console, error, request, response.',
      },
      level: { type: 'string', maxLength: 32 },
      contains: { type: 'string', maxLength: 512 },
      since: { type: 'number', min: 0, integer: true },
      limit: { type: 'number', min: 1, max: 500, integer: true },
      timeout_ms: TIMEOUT,
    },
    annotations: readOnly('Console and network'),
    toDispatch: (a) => ({
      cmd: 'logs',
      args: {
        action: a.action ?? 'list',
        kind: a.kind,
        level: a.level,
        contains: a.contains,
        since: a.since,
        limit: a.limit,
        timeout: a.timeout_ms,
      },
    }),
  },
  {
    name: 'browser_mock',
    description:
      'Serve a fixed response for matching requests, or block them, so an error path can be ' +
      'driven without changing the application. Validated before installation and bounded ' +
      'in count. Clear them when done — they outlive the call that added them.',
    params: {
      action: { type: 'string', enum: ['add', 'block', 'list', 'remove', 'clear'] },
      pattern: { type: 'string', maxLength: 500, description: 'URL pattern, e.g. **/api/*.' },
      status: { type: 'number', min: 100, max: 599, integer: true },
      body: { type: 'string', maxLength: 64 * 1024 },
      content_type: { type: 'string', maxLength: 128 },
      id: { type: 'string', maxLength: 128, description: 'Used with action=remove.' },
    },
    annotations: mutating('Network mocks'),
    toDispatch: (a) => ({
      cmd: 'mock',
      args: {
        action: a.action ?? 'list',
        pattern: a.pattern,
        status: a.status,
        body: a.body,
        contentType: a.content_type,
        id: a.id,
      },
    }),
  },
  {
    name: 'browser_state',
    description:
      'Save or restore cookies and local storage, so a login is captured once instead of ' +
      'replayed. Navigate to the site BEFORE loading: local storage only restores onto its ' +
      'own origin, and loading onto a blank page would silently drop it. Names are bare ' +
      '(no paths); values are never printed.',
    params: {
      action: { type: 'string', enum: ['save', 'load', 'list'] },
      name: { type: 'string', maxLength: 64 },
      session_storage: { type: 'boolean', description: 'Include sessionStorage on save.' },
    },
    annotations: { ...mutating('Login state'), destructiveHint: true },
    toDispatch: (a) => ({
      cmd: 'state',
      args: {
        action: a.action ?? 'list',
        ...(a.name !== undefined ? { name: a.name } : {}),
        sessionStorage: a.session_storage,
      },
    }),
  },
  {
    name: 'browser_trace',
    description:
      'Record actions, console, network and screenshots to a file for a failure a snapshot ' +
      'cannot explain. One trace at a time; output lands in an owned directory. Stop with ' +
      'zip for an archive playable at player.vibium.dev.',
    params: {
      action: { type: 'string', enum: ['start', 'stop', 'status'] },
      name: { type: 'string', maxLength: 64, description: 'Bare name; used with start.' },
      zip: { type: 'boolean', description: 'Also write an archive; used with stop.' },
      no_screenshots: { type: 'boolean', description: 'Skip screenshots; used with start.' },
    },
    annotations: mutating('Tracing'),
    toDispatch: (a) => ({
      cmd: 'trace',
      args: {
        action: a.action ?? 'status',
        ...(a.name !== undefined ? { name: a.name } : {}),
        zip: a.zip,
        noScreenshots: a.no_screenshots,
      },
    }),
  },

  // ---- escape hatch -------------------------------------------------------
  {
    name: 'browser_advanced_eval',
    description:
      'Evaluate arbitrary JavaScript in the page. LAST RESORT — prefer the targeted tools. ' +
      'Costs tokens and bypasses auto-wait.',
    params: { js: { type: 'string', required: true, maxLength: 32 * 1024 } },
    annotations: { ...mutating('Evaluate JavaScript'), destructiveHint: true },
    toDispatch: (a) => ({ cmd: 'eval', args: { js: a.js } }),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/** The advertised schema for a tool, derived from its parameter descriptor. */
export function inputSchemaFor(tool: ToolDef): Record<string, unknown> {
  return toInputSchema(tool.params);
}

/**
 * Validate arguments against the tool's descriptor.
 *
 * Separate from dispatch so the server can reject before touching the session
 * queue: an invalid call should not wait behind a slow browser action to be
 * told it was malformed.
 */
export function validateToolArgs(tool: ToolDef, args: unknown): Record<string, unknown> {
  return validateArgs(tool.name, tool.params, args);
}

/** Map a tool to a dispatcher command and run it through the shared session. */
export async function runTool(
  session: AgentSessionRunner,
  tool: ToolDef,
  args: Record<string, unknown>
): Promise<unknown> {
  return session.run(tool.toDispatch(args));
}

/**
 * As {@link runTool}, but keeps the post-action snapshot the session captured
 * in the same operation. The MCP adapter renders that as the second content
 * block; it does not compute or own it.
 */
export async function runToolDetailed(
  session: AgentSessionRunner,
  tool: ToolDef,
  args: Record<string, unknown>
): Promise<AgentDetailedResult> {
  return session.runDetailed(tool.toDispatch(args));
}
