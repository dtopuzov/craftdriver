/**
 * MCP tool registry.
 *
 * Each tool: a JSON Schema for the model + a thin handler that maps
 * the arguments onto the existing dispatcher. The dispatcher already
 * speaks `{ cmd, args }` and throws `CraftdriverError` with stable
 * codes — we reuse it untouched so library, CLI, and MCP all behave
 * identically when given the same selector.
 *
 * Compact set per §6 of the AI-productivity plan: ~12 tools, one-line
 * descriptions, merged variants behind options. `browser_trace` is
 * intentionally absent in v1 — it ships with Item 7 (trace summaries).
 */
import type { DispatchContext } from '../dispatcher.js';
import { dispatch } from '../dispatcher.js';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema, restricted to types MCP clients reliably support. */
  inputSchema: Record<string, unknown>;
  /** Map MCP args → dispatcher args. Defaults to identity. */
  toDispatch: (args: Record<string, unknown>) => { cmd: string; args: Record<string, unknown> };
  /** When true, this action mutates page state — caller should take a snapshot. */
  mutating: boolean;
  /** When true, the result includes binary content (image bytes). */
  returnsImage?: boolean;
}

const STRING_SELECTOR = {
  type: 'string',
  description:
    "CSS by default. Switch kind with a prefix: 'role=button[name=Submit]', " +
    "'text=Sign In', 'text*=Sign', 'label=Email', 'placeholder=...', " +
    "'testid=...', 'xpath=...', 'id=...', 'name=...'.",
} as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate the active page to a URL. Waits for load.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    mutating: true,
    toDispatch: (a) => ({ cmd: 'go', args: { url: a.url } }),
  },
  {
    name: 'browser_click',
    description:
      'Click an element. Auto-waits for visible+enabled. Returns NO_MATCH immediately ' +
      'when the selector matches zero elements at t=0.',
    inputSchema: {
      type: 'object',
      properties: { selector: STRING_SELECTOR, timeout_ms: { type: 'number' } },
      required: ['selector'],
    },
    mutating: true,
    toDispatch: (a) => ({ cmd: 'click', args: { selector: a.selector, timeout: a.timeout_ms } }),
  },
  {
    name: 'browser_fill',
    description:
      'Fill an input/textarea/select. The library auto-clears before typing. ' +
      'For checkboxes prefer browser_click with the matching label.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: STRING_SELECTOR,
        value: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['selector', 'value'],
    },
    mutating: true,
    toDispatch: (a) => ({
      cmd: 'fill',
      args: { selector: a.selector, value: a.value, timeout: a.timeout_ms },
    }),
  },
  {
    name: 'browser_press',
    description:
      'Press a keyboard key (e.g. "Enter", "Tab", "Control+A"). Optional selector ' +
      'focuses an element first.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, selector: STRING_SELECTOR },
      required: ['key'],
    },
    mutating: true,
    toDispatch: (a) => ({
      cmd: 'press',
      args: { key: a.key, ...(a.selector ? { selector: a.selector } : {}) },
    }),
  },
  {
    name: 'browser_hover',
    description: 'Hover over an element.',
    inputSchema: {
      type: 'object',
      properties: { selector: STRING_SELECTOR, timeout_ms: { type: 'number' } },
      required: ['selector'],
    },
    mutating: true,
    toDispatch: (a) => ({ cmd: 'hover', args: { selector: a.selector, timeout: a.timeout_ms } }),
  },
  {
    name: 'browser_find',
    description:
      'Locate elements without acting on them. Returns up to `limit` matches with ' +
      'tag, text snippet, and visibility. Use `all: true` to enumerate.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: STRING_SELECTOR,
        all: { type: 'boolean' },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
      required: ['selector'],
    },
    mutating: false,
    toDispatch: (a) => ({
      cmd: 'find',
      args: { selector: a.selector, all: a.all, limit: a.limit, offset: a.offset },
    }),
  },
  {
    name: 'browser_exists',
    description:
      'Zero-wait probe: returns { exists, count } immediately. Call this BEFORE ' +
      'browser_click/wait when you are guessing a selector — it costs one BiDi ' +
      "roundtrip instead of the full 5 s timeout.",
    inputSchema: {
      type: 'object',
      properties: { selector: STRING_SELECTOR },
      required: ['selector'],
    },
    mutating: false,
    toDispatch: (a) => ({ cmd: 'exists', args: { selector: a.selector } }),
  },
  {
    name: 'browser_wait',
    description:
      'Wait for a condition: selector to become visible/hidden/attached/detached, ' +
      'or a load state (load|domcontentloaded|networkidle).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        kind: { type: 'string', enum: ['selector', 'load'] },
        state: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['target'],
    },
    mutating: false,
    toDispatch: (a) => ({
      cmd: 'wait',
      args: { target: a.target, kind: a.kind ?? 'selector', state: a.state, timeout: a.timeout_ms },
    }),
  },
  {
    name: 'browser_read',
    description:
      'Read text/attr/value/is-state from an element, or page body text when no ' +
      'selector is given. `kind` defaults to "text".',
    inputSchema: {
      type: 'object',
      properties: {
        selector: STRING_SELECTOR,
        kind: { type: 'string', enum: ['text', 'attr', 'value', 'is'] },
        name: { type: 'string', description: 'attribute name when kind=attr' },
        what: {
          type: 'string',
          enum: ['visible', 'enabled', 'checked'],
          description: 'state when kind=is',
        },
      },
    },
    mutating: false,
    toDispatch: (a) => {
      const kind = (a.kind as string | undefined) ?? 'text';
      if (kind === 'attr') return { cmd: 'attr', args: { selector: a.selector, name: a.name } };
      if (kind === 'value') return { cmd: 'value', args: { selector: a.selector } };
      if (kind === 'is') return { cmd: 'is', args: { selector: a.selector, what: a.what } };
      return { cmd: 'text', args: { ...(a.selector ? { selector: a.selector } : {}) } };
    },
  },
  {
    name: 'browser_pages',
    description: 'List open pages with id/url/title. Use for tab/popup-aware flows.',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    toDispatch: () => ({ cmd: 'pages', args: {} }),
  },
  {
    name: 'browser_snapshot',
    description:
      'Sanitized accessibility-tree summary of the active page: one line ' +
      'per visible interactive element with role, accessible name, and a ' +
      'stable ref (`e1`, `e2`, …). Use `ref=eN` as the selector for ' +
      'subsequent tool calls — refs are auto-resolved without DOM hunting ' +
      'and invalidate on the next snapshot or navigation. Cheaper and ' +
      'more reliable than browser_screenshot for understanding the page.',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    toDispatch: () => ({ cmd: 'snapshot', args: {} }),
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture a PNG of the active page or a specific element. Always written ' +
      'to disk under the per-session artifact directory; the response carries ' +
      'the absolute path and byte count (zero image tokens). Pass `path` to ' +
      'choose your own destination.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: STRING_SELECTOR,
        full_page: { type: 'boolean' },
        path: {
          type: 'string',
          description:
            'Absolute path to write the PNG to. If omitted, an artifact ' +
            'path is auto-allocated.',
        },
      },
    },
    mutating: false,
    returnsImage: true,
    toDispatch: (a) => ({
      cmd: 'screenshot',
      args: {
        ...(a.selector ? { selector: a.selector } : {}),
        fullPage: a.full_page,
        ...(a.path ? { path: a.path } : {}),
      },
    }),
  },
  {
    name: 'browser_status',
    description: 'Report whether a browser is up and which URL is active.',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    toDispatch: () => ({ cmd: 'status', args: {} }),
  },
  {
    name: 'browser_advanced_eval',
    description:
      'Evaluate arbitrary JavaScript in the page. LAST RESORT — prefer ' +
      'browser_find/click/fill when possible. Costs tokens and bypasses auto-wait.',
    inputSchema: {
      type: 'object',
      properties: { js: { type: 'string' } },
      required: ['js'],
    },
    mutating: true,
    toDispatch: (a) => ({ cmd: 'eval', args: { js: a.js } }),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/** Run a tool against the dispatcher. Throws CraftdriverError on failure. */
export async function runTool(
  ctx: DispatchContext,
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<unknown> {
  const mapped = tool.toDispatch(args);
  return dispatch(ctx, mapped.cmd, mapped.args);
}
