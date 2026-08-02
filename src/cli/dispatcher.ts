/**
 * Command dispatcher — single source of truth for "what each CLI
 * command does to a Browser instance".
 *
 * Pure logic: takes a `cmd` name + `args` object, returns either a
 * JSON-serializable result or throws `CraftdriverError`. AgentSession
 * serializes calls from daemon, ephemeral CLI, and MCP transports over
 * this shared dispatch table.
 *
 * Browser launch and shutdown live in AgentSession; command-specific
 * browser behavior lives here.
 */
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  Browser,
  INTERNAL_EVALUATE_CLASSIC,
  INTERNAL_FILL_AND_SUBMIT,
  type LaunchOptions,
} from '../lib/browser.js';
import type { By } from '../lib/by.js';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import { parseSelector, describeSelector } from './selector.js';
import {
  takeSnapshot,
  peekDialog,
  probeRef,
  describeRefStatus,
  mintRefs,
  SnapshotTracker,
} from './snapshot.js';
import type { A11yImpact, A11yOptions, A11yTarget, A11yViolation } from '../lib/a11y.js';
import { locatorCandidates } from './locatorCandidates.js';
import type { SessionJournal, JournalKind } from './journal.js';
import { artifactRoot, resolveArtifactPath } from './artifactPaths.js';
import {
  stateRoot,
  resolveStatePath,
  prepareTempStatePath,
  commitStateFile,
  discardTempStateFile,
  readStateFile,
  summarizeState,
  listStateNames,
} from './stateStore.js';
import { AGENT_DEFAULT_TIMEOUT_MS, AGENT_DEFAULT_LIMIT, type AgentViewport } from './defaults.js';
import { boundValue, boundString, clampLimit, MAX_TEXT_CHARS } from './bounds.js';

/** Lazy-initialized browser handle shared by all commands in a session. */
export interface BrowserHandle {
  /** Returns a connected browser, launching it on first call. */
  get(): Promise<Browser>;
  /** Returns the current instance without launching (null if not yet up). */
  peek(): Browser | null;
  /** Close the browser if it has been launched. */
  close(): Promise<void>;
}

export function createBrowserHandle(launch: () => Promise<Browser>): BrowserHandle {
  let inst: Browser | null = null;
  let pending: Promise<Browser> | null = null;
  return {
    async get() {
      if (inst) return inst;
      // Clear `pending` on failure as well as success. Leaving the rejected
      // promise cached meant one bad launch — a missing driver, a port in
      // use — poisoned the session: every later command replayed the same
      // stale error and the only recovery was closing the session.
      if (!pending) {
        pending = launch().then(
          (b) => {
            inst = b;
            pending = null;
            return b;
          },
          (err) => {
            pending = null;
            throw err;
          }
        );
      }
      return pending;
    },
    peek() {
      return inst;
    },
    async close() {
      const b = inst;
      inst = null;
      if (b) {
        try {
          await b.quit();
        } catch {
          /* ignore browser cleanup errors */
        }
      }
    },
  };
}

function ms(args: Record<string, unknown> | undefined, key = 'timeout'): number {
  // Validate-or-fallback to bound timer durations (defends against resource
  // exhaustion from hostile socket input). CodeQL does not treat Math.min
  // as a sanitizer, so we use explicit range checks.
  const MAX_TIMEOUT_MS = 300_000;
  const v = args?.[key];
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIMEOUT_MS) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 0 && n <= MAX_TIMEOUT_MS) return n;
  }
  return AGENT_DEFAULT_TIMEOUT_MS;
}

function str(args: Record<string, unknown> | undefined, key: string): string {
  const v = args?.[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `dispatcher: missing required argument "${key}"`
    );
  }
  return v;
}

function optStr(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = args?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function viewportOf(args: Record<string, unknown> | undefined): AgentViewport | undefined {
  const raw = args?.viewport;
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, 'viewport must be { width, height }');
  }
  const { width, height } = raw as Record<string, unknown>;
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 10_000;
  if (!valid(width) || !valid(height)) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      'viewport width and height must be integers in 100..10000',
      { detail: { width, height } }
    );
  }
  return { width, height };
}

/**
 * The selector the caller asked us to act on, for success output.
 *
 * `By` deliberately compiles several semantic selectors to a long XPath for
 * WebDriver. Returning that transport implementation after a successful
 * action consumes agent context without teaching it anything; the caller's
 * own selector is the useful, stable description.
 */
function publicSelectorOf(args: Record<string, unknown> | undefined, key = 'selector'): string {
  const raw = str(args, key);
  const ref = /^\s*(e\d+)\s*$/.exec(raw)?.[1];
  return ref ? `ref=${ref}` : raw;
}

function bool(args: Record<string, unknown> | undefined, key: string): boolean {
  return args?.[key] === true || args?.[key] === 'true';
}

/**
 * A caller-supplied list limit, pulled into range.
 *
 * `--limit -5` silently returned nothing and `--limit 1e9` defeated the paging
 * that keeps list output readable; neither was rejected. Clamping keeps the
 * command answerable, which is what the agent asked for.
 */
function limitOf(args: Record<string, unknown> | undefined, dflt: number): number {
  return clampLimit(int(args, 'limit', dflt), dflt);
}

function int(args: Record<string, unknown> | undefined, key: string, dflt: number): number {
  const v = args?.[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return dflt;
}

/** Best-effort short text snippet for `find` output. */
function snippet(s: string, max = 60): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

/** Dialog prompts are attacker-influenced page content — keep them bounded. */
const MAX_DIALOG_TEXT = 500;
const MAX_UPLOAD_FILES = 10;

/**
 * Read an explicit list of local paths to upload. Bounded in count, and
 * every path must exist — a silent no-op upload is worse than an error
 * because the agent then asserts against a form that never received a file.
 */
function fileList(args: Record<string, unknown> | undefined): string[] {
  const raw = args?.files ?? args?.file ?? args?.path;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw.length > 0
      ? raw.split(',')
      : [];
  const files = list
    .map((f) => (typeof f === 'string' ? f.trim() : ''))
    .filter((f) => f.length > 0);
  if (files.length === 0) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      'upload: missing required argument "files"',
      { hint: 'pass one or more local paths, e.g. --files ./a.png,./b.png' }
    );
  }
  if (files.length > MAX_UPLOAD_FILES) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `upload: too many files (${files.length}); the limit is ${MAX_UPLOAD_FILES}`
    );
  }
  for (const f of files) {
    const resolved = resolvePath(f);
    if (!existsSync(resolved)) {
      throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, `upload: file not found: ${f}`, {
        detail: { file: f },
      });
    }
  }
  return files.map((f) => resolvePath(f));
}

/**
 * Caps on the mocking surface. Bounded because a mock is installed from
 * untrusted socket input and lives until removed.
 */
const MAX_MOCKS = 20;
const MAX_MOCK_PATTERN = 500;
const MAX_MOCK_BODY = 64 * 1024;

/** Owned root for trace output, overridable like the state root. */
function traceRoot(): string {
  return artifactRoot('traces', 'CRAFTDRIVER_TRACE_DIR');
}

// ---------------------------------------------------------------------------
// Accessibility audits
// ---------------------------------------------------------------------------
/**
 * Bounds on one audit report.
 *
 * A raw axe report on a real page is thousands of tokens, and `--limit` and
 * `--nodes` multiply: 100 violations of 10 nodes is a 400 KB answer nobody can
 * read. `MAX_A11Y_REPORT_NODES` is the bound that actually holds, because it
 * caps the product rather than either factor.
 */
const MAX_A11Y_VIOLATIONS = 100;
const MAX_A11Y_NODES = 10;
const A11Y_DEFAULT_NODES = 3;
const MAX_A11Y_REPORT_NODES = 50;
/** axe's `html` is the element's opening tag — enough to recognise it. */
const MAX_A11Y_HTML = 160;
const MAX_A11Y_SUMMARY = 240;
const MAX_A11Y_TARGET = 120;
/** Rule filters come from untrusted input and go into axe's run options. */
const MAX_A11Y_RULES = 50;
const MAX_A11Y_RULE_ID = 64;

const A11Y_IMPACTS: readonly A11yImpact[] = ['minor', 'moderate', 'serious', 'critical'];

function a11yImpactOf(
  args: Record<string, unknown> | undefined,
  key: 'minImpact'
): A11yImpact | undefined {
  const raw = optStr(args, key);
  if (!raw) return undefined;
  const value = raw.toLowerCase();
  if (!(A11Y_IMPACTS as readonly string[]).includes(value)) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `a11y: unknown impact ${JSON.stringify(raw)}`,
      {
        detail: { known: A11Y_IMPACTS },
        hint: `expected one of: ${A11Y_IMPACTS.join(', ')}`,
      }
    );
  }
  return value as A11yImpact;
}

/** A comma-separated or array-valued list of axe rule IDs. */
function a11yRulesOf(
  args: Record<string, unknown> | undefined,
  key: 'rules' | 'disableRules',
  flag: string
): string[] | undefined {
  const raw = args?.[key];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const ids = list
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter((id) => id.length > 0);
  if (ids.length === 0) return undefined;
  if (ids.length > MAX_A11Y_RULES) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `a11y: too many rule IDs in ${flag} (${ids.length}; max ${MAX_A11Y_RULES})`
    );
  }
  const oversized = ids.find((id) => id.length > MAX_A11Y_RULE_ID);
  if (oversized !== undefined) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `a11y: rule ID is too long (${oversized.length} chars; max ${MAX_A11Y_RULE_ID})`
    );
  }
  return ids;
}

/**
 * Audit options, validated before anything launches a browser.
 *
 * The library throws for `rules` + `disableRules` too, but only once the audit
 * is already running — which costs a launch to learn about a typo, and reports
 * a usage mistake as a driver error.
 */
function a11yOptionsOf(
  args: Record<string, unknown> | undefined
): A11yOptions & { minImpact: A11yImpact } {
  const rules = a11yRulesOf(args, 'rules', '--rules');
  const disableRules = a11yRulesOf(args, 'disableRules', '--disable-rules');
  if (rules && disableRules) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      'a11y: --rules and --disable-rules are mutually exclusive',
      { hint: 'run only a rule set with --rules, or waive known rules with --disable-rules' }
    );
  }
  // Deliberately lower than the library's `serious` default, and always sent
  // explicitly so the two cannot drift. The library gates a build, where
  // widening the net turns a green CI red; this command finds problems to fix,
  // where a hidden finding is the failure. Measured on a documentation page:
  // `serious` reported 1 violation, `minor` reported 3 — the extra two were
  // `landmark-one-main` and `region`, both worth acting on.
  const minImpact = a11yImpactOf(args, 'minImpact') ?? 'minor';
  return {
    ...(rules ? { rules } : {}),
    ...(disableRules ? { disableRules } : {}),
    minImpact,
  };
}

/**
 * axe's target path as one readable label.
 *
 * `>>>` separates open shadow boundaries, matching how the shadow-piercing
 * combinator is conventionally written. It is a label for a human reading the
 * report, not a selector to paste — that is what the `ref` is for.
 */
function a11yTargetLabel(target: A11yTarget[]): string {
  return snippet(
    target.map((part) => (Array.isArray(part) ? part.join(' >>> ') : String(part))).join(' >>> '),
    MAX_A11Y_TARGET
  );
}

/**
 * The violating element's markup, as the *page* author wrote it.
 *
 * `data-craftdriver-ref` is our own diagnostic marker, stamped by whichever
 * snapshot happened to run first. Leaving it in means handing an agent an
 * attribute that is not in the source it is about to edit — and inviting it to
 * "fix" one. The ref is reported beside the snippet, where it belongs.
 */
function a11yHtml(html: string): string {
  return snippet(html.replace(/\s*data-craftdriver-ref="e\d+"/g, ''), MAX_A11Y_HTML);
}

/**
 * axe writes a failure summary as a heading plus one indented line per way to
 * fix it. Collapsing that to single spaces — which is what every other snippet
 * in this file wants — runs the alternatives together into one sentence, so
 * the line breaks become separators instead of disappearing.
 */
function a11ySummary(summary: string): string {
  const lines = summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const joined = lines.slice(1).reduce(
    // axe's heading line already ends in a colon, and a separator straight
    // after it reads as punctuation noise ("Fix any of the following:;").
    (acc, line) => acc + (acc.endsWith(':') ? ' ' : '; ') + line,
    lines[0] ?? ''
  );
  return snippet(joined, MAX_A11Y_SUMMARY);
}

/** WCAG conformance and success-criterion tags, in axe's own spelling. */
function wcagTags(violation: A11yViolation): string[] {
  return (violation.tags ?? []).filter((tag) => tag.startsWith('wcag'));
}

const JOURNAL_KINDS: JournalKind[] = ['console', 'error', 'request', 'response'];

/**
 * Read a `--kind` filter, rejecting unknown values rather than silently
 * matching nothing — a typo'd kind that returns an empty list reads exactly
 * like a page that logged nothing.
 */
function parseKinds(args: Record<string, unknown> | undefined): JournalKind[] | undefined {
  const raw = optStr(args, 'kind');
  if (!raw) return undefined;
  const kinds = raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
  const unknown = kinds.filter((k) => !JOURNAL_KINDS.includes(k as JournalKind));
  if (unknown.length > 0) {
    throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, `logs: unknown kind "${unknown[0]}"`, {
      detail: { known: JOURNAL_KINDS },
      hint: `expected one or more of: ${JOURNAL_KINDS.join(', ')}`,
    });
  }
  return kinds as JournalKind[];
}

export interface DispatchContext {
  handle: BrowserHandle;
  launchOptions: LaunchOptions;
  /** Safe session identifier used for bounded, tool-owned artifact names. */
  artifactName?: string;
  /** Owns the one snapshot baseline and the ref-issuing document. */
  tracker: SnapshotTracker;
  /** Effective layout viewport requested by this agent session. */
  viewport?: AgentViewport;
  /**
   * Bounded console/network history. Attached when the browser is launched,
   * so an event during the first navigation is still answerable afterwards.
   * Optional so a fake dispatch context in a test need not build one.
   */
  journal?: SessionJournal;
  /**
   * The trace this session started, if any.
   *
   * The library owns whether a trace is running; this only remembers where it
   * was told to write, which `Tracer` does not expose. Cleared on stop so the
   * two cannot disagree about liveness — `browser.quit()` already aborts a
   * running trace, so a dropped session leaves no dangling writer.
   */
  activeTrace?: { name: string; outDir: string; startedAt: string } | null;
  /**
   * Network mocks this session installed.
   *
   * Tracked here because `NetworkInterceptor` keeps its intercept map private,
   * so there is no public way to enumerate or cap what is active.
   */
  mocks?: Array<{ id: string; pattern: string; kind: 'mock' | 'block'; status?: number }>;
}

/**
 * Drop everything that described the browser that just went away.
 *
 * All of this state is browser-owned: the ref registry lives in the page, the
 * trace writer and the network intercepts die with the process, and the
 * journal's listeners are bound to the old session. Keeping any of it across
 * a `quit` made the session describe a browser that no longer existed —
 * `trace status` reporting an aborted trace as running, `mock list` reporting
 * intercepts that were gone, and the previous browser's console output
 * appearing in the replacement's logs.
 *
 * Ref history deliberately survives, for the same reason: the high-water mark
 * stops numbers being reissued, the issued-ref set recognises an old bare ref
 * as stale rather than CSS, and the journal sequence stops an old cursor from
 * matching new entries.
 */
export function resetBrowserOwnedState(ctx: DispatchContext): void {
  ctx.tracker.reset();
  ctx.activeTrace = null;
  ctx.mocks = [];
  ctx.journal?.detach();
  ctx.journal?.clear();
}

/**
 * Commands that can change the page, and therefore earn one bounded
 * post-action snapshot. Kept here rather than in a transport so CLI and
 * MCP cannot disagree about what "mutating" means.
 */
const MUTATING = new Set([
  'go',
  'back',
  'forward',
  'reload',
  'click',
  'dblclick',
  'fill',
  'clear',
  'type',
  'press',
  'hover',
  'check',
  'uncheck',
  'select',
  'focus',
  'scroll',
  'key',
  'mouse',
  'dialog',
  'upload',
  // `eval` runs arbitrary page script, so it is the *most* likely thing to
  // change the page. Leaving it out meant its changes went unreported and
  // were then blamed on whatever ran next.
  'eval',
]);

export function isMutating(cmd: string): boolean {
  return MUTATING.has(cmd);
}

/**
 * Origin of the active page, or null when it has none (`about:blank`, a
 * `data:` URL, or a driver that cannot report one).
 *
 * Read from the page URL rather than by evaluating `location.origin`: this is
 * used on the storage path, where a modal dialog would block script execution
 * and turn a cheap check into a script-timeout wait.
 */
async function activeOrigin(browser: Browser): Promise<string | null> {
  const url = await browser
    .activePage()
    .then((p) => p.url())
    .catch(() => '');
  try {
    const { origin } = new URL(url);
    // `about:` and `data:` URLs parse but have the opaque origin "null".
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

function staleRef(ref: string, reason: string): CraftdriverError {
  return new CraftdriverError(
    ErrorCode.STALE_REF,
    `ref=${ref} is stale: ${describeRefStatus(reason as never)}`,
    {
      detail: { ref, reason },
      hint: 'take a fresh `snapshot` and use the new ref; refs are never reassigned',
    }
  );
}

/**
 * Parse a selector argument, validating snapshot refs against the live
 * page first.
 *
 * A ref must still identify exactly one element in the document that
 * issued it. Anything else fails STALE_REF here, before the selector
 * reaches a browser action — that is the whole point: a ref must never
 * resolve to a node the agent has not inspected.
 */
async function selectorOf(
  ctx: DispatchContext,
  args: Record<string, unknown> | undefined,
  key = 'selector'
): Promise<By> {
  return resolveSelector(ctx, str(args, key));
}

interface RefSelectorToken {
  ref: string;
  bare: boolean;
}

/** Recognise explicit refs and the CLI's copy-paste-friendly bare alias. */
function refSelectorToken(raw: string): RefSelectorToken | null {
  const explicit = /^\s*ref\s*=\s*(e\d+)\s*$/i.exec(raw);
  if (explicit) return { ref: explicit[1], bare: false };
  const bare = /^\s*(e\d+)\s*$/.exec(raw);
  return bare ? { ref: bare[1], bare: true } : null;
}

async function resolveSelector(ctx: DispatchContext, raw: string): Promise<By> {
  const token = refSelectorToken(raw);
  if (!token) return parseSelector(raw);
  const { ref } = token;

  // Bare eN is a convenience alias only for a ref this session actually
  // showed the agent. Unknown tokens must not fall through to CSS and pay an
  // action timeout; callers that genuinely mean an <e9> element use css=e9.
  if (token.bare && !ctx.tracker.hasIssuedRef(ref)) {
    throw new CraftdriverError(
      ErrorCode.BARE_REF,
      `${ref} looks like a snapshot reference but was not issued by this session`,
      {
        detail: { ref },
        hint: `use ref=${ref} from the latest snapshot, or css=${ref} for a literal CSS selector`,
      }
    );
  }
  const by = parseSelector(`ref=${ref}`);

  const expected = ctx.tracker.documentId;
  if (expected === null) throw staleRef(ref, 'no-snapshot');

  const browser = await ctx.handle.get();
  // A modal blocks script execution, and probeRef runs script — without
  // this it would sit on the driver's script timeout before failing.
  const blocking = await peekDialog(browser);
  if (blocking !== null) {
    throw new CraftdriverError(
      ErrorCode.STATE_INVALID,
      `cannot resolve ref=${ref} while a dialog is open: ${snippet(blocking, MAX_DIALOG_TEXT)}`,
      { hint: 'accept or dismiss it first with `dialog accept` / `dialog dismiss`' }
    );
  }
  const probe = await probeRef(browser, ref, expected);
  if (probe.status !== 'ok') throw staleRef(ref, probe.status);
  return by;
}

interface SnapshotLineInfo {
  ref: string;
  role: string;
  name?: string;
  depth: number;
  container: boolean;
}

function snapshotLineInfo(line: string): SnapshotLineInfo | null {
  const match = /^(\s*)(e\d+):\s+(\S+)(\s+\(container\))?(?:\s+"([^"]*)")?/.exec(line);
  if (!match) return null;
  return {
    ref: match[2],
    role: match[3],
    ...(match[5] ? { name: match[5] } : {}),
    depth: Math.floor(match[1].length / 2),
    container: Boolean(match[4]),
  };
}

/** Fail from the current snapshot instead of waiting on an impossible action. */
function assertEditableRef(
  ctx: DispatchContext,
  args: Record<string, unknown>,
  cmd: 'fill' | 'clear'
): void {
  const raw = str(args, 'selector');
  const refToken = refSelectorToken(raw);
  if (!refToken) return;
  const lines = ctx.tracker.current?.lines ?? [];
  const index = lines.findIndex((line) => snapshotLineInfo(line)?.ref === refToken.ref);
  if (index < 0) return;
  const target = snapshotLineInfo(lines[index]);
  if (!target?.container) return;

  const descendants: SnapshotLineInfo[] = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const candidate = snapshotLineInfo(lines[i]);
    if (!candidate) continue;
    if (candidate.depth <= target.depth) break;
    descendants.push(candidate);
  }
  const editable = descendants.find((candidate) =>
    ['textbox', 'searchbox', 'combobox', 'spinbutton', 'input'].includes(candidate.role)
  );
  const reveal = descendants.find(
    (candidate) => candidate.role === 'button' || candidate.role === 'link'
  );
  const alternative = editable ?? reveal;
  const targetSelector = `ref=${target.ref}`;
  const alternativeSelector = alternative ? `ref=${alternative.ref}` : undefined;
  const quotedName = alternative?.name ? ` (${JSON.stringify(alternative.name)})` : '';
  const hint = editable
    ? `${cmd} ${alternativeSelector}${quotedName}`
    : reveal
      ? `click ${alternativeSelector}${quotedName} to reveal an editable field`
      : 'choose an editable field inside this container from a fresh snapshot';
  throw new CraftdriverError(
    ErrorCode.NOT_EDITABLE,
    `${cmd}: ${targetSelector} is a ${target.role} container, not an editable field`,
    {
      detail: {
        target: targetSelector,
        role: target.role,
        ...(alternativeSelector ? { alternative: alternativeSelector } : {}),
      },
      hint,
    }
  );
}

interface Evaluable {
  evaluate: (
    fn: (node: unknown, ...args: unknown[]) => void,
    ...args: unknown[]
  ) => Promise<unknown>;
}

/**
 * Give an element keyboard focus without clicking it.
 *
 * Typing into a field should not fire that field's click handler, and a
 * click also drops the caret wherever the pointer happened to land. Focus
 * is both quieter and more predictable for keyboard commands.
 *
 * `focus()` alone leaves the caret at offset 0 in a pre-filled field, so
 * typing would silently *prepend*. `caretToEnd` puts it after the existing
 * text, which is what "append" has to mean to be useful.
 */
async function focusElement(el: Evaluable, caretToEnd = false): Promise<void> {
  await el.evaluate((node: unknown, toEnd: unknown) => {
    const n = node as {
      focus(): void;
      value?: unknown;
      setSelectionRange?: (start: number, end: number) => void;
    };
    n.focus();
    if (!toEnd) return;
    if (typeof n.value !== 'string' || typeof n.setSelectionRange !== 'function') return;
    try {
      n.setSelectionRange(n.value.length, n.value.length);
    } catch {
      /* input types like email/number forbid selection; focus is enough */
    }
  }, caretToEnd);
}

/**
 * Pick the page a `page select`/`page close` refers to.
 *
 * Accepts an index or an id, and fails closed: acting on the wrong tab is
 * exactly the confusion this command exists to remove, so an out-of-range
 * index or unknown id is an error rather than a fallback to the active page.
 */
function selectPage<T extends { id(): string }>(
  pages: T[],
  args: Record<string, unknown> | undefined,
  action: string
): T {
  const raw = args?.target ?? args?.index ?? args?.id;
  if (raw === undefined || raw === null || raw === '') {
    throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, `page ${action}: missing target`, {
      hint: 'pass an index from `page list`, or a page id',
    });
  }
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) {
    const index = Number(value);
    if (index >= pages.length) {
      throw new CraftdriverError(
        ErrorCode.NO_MATCH,
        `page ${action}: no page at index ${index} (${pages.length} open)`,
        { detail: { index, count: pages.length } }
      );
    }
    return pages[index];
  }
  const byId = pages.find((p) => p.id() === value);
  if (!byId) {
    throw new CraftdriverError(ErrorCode.NO_MATCH, `page ${action}: no page with id ${value}`, {
      detail: { id: value },
    });
  }
  return byId;
}

/** Resolve a selector to its first matching element, or throw NO_MATCH. */
async function firstElement(
  ctx: DispatchContext,
  browser: Browser,
  args: Record<string, unknown> | undefined,
  cmd: string,
  key = 'selector'
) {
  const by = await selectorOf(ctx, args, key);
  const els = await browser.findAll(by);
  if (els.length === 0) {
    throw new CraftdriverError(
      ErrorCode.NO_MATCH,
      `${cmd}: no element matches ${describeSelector(by)}`,
      { detail: { selector: describeSelector(by) } }
    );
  }
  return { by, el: els[0] };
}

export async function dispatch(
  ctx: DispatchContext,
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  switch (cmd) {
    // ---- session ---------------------------------------------------------
    case 'status': {
      const b = ctx.handle.peek();
      if (!b) {
        return {
          browser: null,
          pid: process.pid,
          ready: false,
          ...(ctx.viewport ? { viewport: ctx.viewport } : {}),
        };
      }
      const page = await b.activePage().catch(() => null);
      const url = page ? await page.url().catch(() => '') : '';
      return {
        browser: ctx.launchOptions.electron
          ? 'electron'
          : (ctx.launchOptions.browserName ?? 'chrome'),
        pid: process.pid,
        ready: true,
        activeUrl: url,
        ...(ctx.viewport ? { viewport: ctx.viewport } : {}),
      };
    }

    case 'quit': {
      await ctx.handle.close();
      resetBrowserOwnedState(ctx);
      return { ok: true };
    }

    // ---- navigation ------------------------------------------------------
    case 'go': {
      const url = str(args, 'url');
      const viewport = viewportOf(args);
      const b = await ctx.handle.get();
      if (viewport) {
        await b.setViewportSize(viewport);
        ctx.viewport = { ...viewport };
      }
      await b.navigateTo(url);
      try {
        return await b[INTERNAL_EVALUATE_CLASSIC]<{ url: string; title: string }>(
          'return { url: location.href, title: document.title };'
        );
      } catch {
        // A meta refresh or immediate redirect can replace the Classic script
        // realm after navigateTo() returns. Preserve the one-probe fast path,
        // but recover through Page's context-aware URL/title reads.
        const page = await b.activePage();
        return { url: await page.url(), title: await page.title() };
      }
    }

    case 'back': {
      const b = await ctx.handle.get();
      const page = await b.activePage();
      await page.goBack();
      return { url: await page.url() };
    }

    case 'forward': {
      const b = await ctx.handle.get();
      const page = await b.activePage();
      await page.goForward();
      return { url: await page.url() };
    }

    case 'reload': {
      const b = await ctx.handle.get();
      const page = await b.activePage();
      await page.reload();
      return { url: await page.url() };
    }

    // ---- find ------------------------------------------------------------
    case 'find': {
      const by = await selectorOf(ctx, args);
      const all = bool(args, 'all');
      const limit = limitOf(args, AGENT_DEFAULT_LIMIT);
      const offset = int(args, 'offset', 0);
      const b = await ctx.handle.get();
      const els = await b.findAll(by);
      const total = els.length;
      if (!all) {
        if (total === 0) {
          throw new CraftdriverError(
            ErrorCode.NO_MATCH,
            `find: no element matches ${describeSelector(by)}`,
            { detail: { selector: describeSelector(by) } }
          );
        }
        const first = els[0];
        return {
          count: total,
          truncated: total > 1,
          matches: [
            {
              tag: await first.tagName().catch(() => ''),
              text: snippet(await first.text().catch(() => '')),
              visible: await first.isVisible().catch(() => false),
            },
          ],
        };
      }
      const slice = els.slice(offset, offset + limit);
      const matches = await Promise.all(
        slice.map(async (el, i) => ({
          index: offset + i,
          tag: await el.tagName().catch(() => ''),
          text: snippet(await el.text().catch(() => '')),
          visible: await el.isVisible().catch(() => false),
        }))
      );
      return {
        count: total,
        offset,
        limit,
        truncated: offset + slice.length < total,
        total,
        next_offset: offset + slice.length < total ? offset + slice.length : null,
        matches,
      };
    }

    case 'exists': {
      const by = await selectorOf(ctx, args);
      const b = await ctx.handle.get();
      const els = await b.findAll(by);
      return { exists: els.length > 0, count: els.length };
    }

    // ---- locator candidates ----------------------------------------------
    // Durable selectors for an element the agent found by ref. Every
    // candidate is re-resolved against the live document before it is
    // offered, so a test written from one starts out actually matching.
    case 'locators': {
      const by = await selectorOf(ctx, args);
      const b = await ctx.handle.get();
      return locatorCandidates(b, by, limitOf(args, 5));
    }

    // ---- actions ---------------------------------------------------------
    case 'click': {
      const by = await selectorOf(ctx, args);
      const b = await ctx.handle.get();
      await b.click(by, { timeout: ms(args) });
      return { ok: true, selector: publicSelectorOf(args) };
    }

    case 'dblclick': {
      const by = await selectorOf(ctx, args);
      const b = await ctx.handle.get();
      await b.mouse.dblclick(by);
      return { ok: true, selector: publicSelectorOf(args) };
    }

    case 'fill': {
      const by = await selectorOf(ctx, args);
      // Validate identity/document freshness first; an old container ref must
      // still report STALE_REF rather than being classified from stale text.
      assertEditableRef(ctx, args, 'fill');
      const value = str(args, 'value');
      const b = await ctx.handle.get();
      const submit = bool(args, 'submit');
      if (submit) await b[INTERNAL_FILL_AND_SUBMIT](by, value, { timeout: ms(args) });
      else await b.fill(by, value, { timeout: ms(args) });
      return { ok: true, selector: publicSelectorOf(args), ...(submit ? { submitted: true } : {}) };
    }

    case 'clear': {
      const by = await selectorOf(ctx, args);
      assertEditableRef(ctx, args, 'clear');
      const b = await ctx.handle.get();
      await b.clear(by, { timeout: ms(args) });
      return { ok: true, selector: publicSelectorOf(args) };
    }

    case 'type': {
      // Types into whatever currently holds focus — no selector, matching
      // `playwright-cli type <text>` and mapping 1:1 onto the library's
      // `browser.keyboard.type()`.
      //
      // Use `fill` to put a value in a specific field. Reach for `focus`
      // (or `click`) + `type` only when you need to append to existing
      // text or drive a field's key handlers directly.
      const text = str(args, 'text');
      const b = await ctx.handle.get();
      await b.keyboard.type(text);
      return { ok: true, length: text.length };
    }

    case 'press': {
      const key = str(args, 'key');
      const b = await ctx.handle.get();
      const sel = optStr(args, 'selector');
      if (sel) {
        // Focus, don't click: `press Enter #submit` must not also fire the
        // button's click handler and submit twice.
        const { el } = await firstElement(ctx, b, args, 'press');
        await focusElement(el);
      }
      await b.keyboard.press(key);
      return { ok: true, key };
    }

    case 'hover': {
      const b = await ctx.handle.get();
      const { by, el } = await firstElement(ctx, b, args, 'hover');
      await el.hover({ timeout: ms(args) });
      return { ok: true, selector: publicSelectorOf(args) };
    }

    case 'check':
    case 'uncheck': {
      const want = cmd === 'check';
      const b = await ctx.handle.get();
      const { by, el } = await firstElement(ctx, b, args, cmd);
      // Idempotent by design: agents retry, and a blind click would toggle
      // the box back off. But the read must not be swallowed — treating an
      // unreadable element as "unchecked" made `uncheck` skip the click and
      // then report success for an element it never touched.
      const already = await el.isChecked();
      if (already !== want) await el.click();
      // Report what the page says, not what was asked for: a click eaten by
      // an overlay or a disabled control must not come back as success.
      const checked = await el.isChecked();
      if (checked !== want) {
        throw new CraftdriverError(
          ErrorCode.EXPECT_MISMATCH,
          `${cmd}: ${describeSelector(by)} is still ${checked ? 'checked' : 'unchecked'}`,
          {
            detail: { selector: describeSelector(by), expected: want, actual: checked },
            hint: 'the click may have been intercepted, or the control is disabled',
          }
        );
      }
      return { ok: true, selector: publicSelectorOf(args), checked };
    }

    case 'select': {
      const value = str(args, 'value');
      const b = await ctx.handle.get();
      const { by, el } = await firstElement(ctx, b, args, 'select');
      await el.select(value);
      return { ok: true, selector: publicSelectorOf(args), value };
    }

    case 'focus': {
      const b = await ctx.handle.get();
      const { by, el } = await firstElement(ctx, b, args, cmd);
      // Caret to the end of any existing text. `focus` exists so you can
      // then `type`, and a bare focus() leaves the caret at offset 0 —
      // which would silently prepend. Use `clear` to overwrite instead.
      await focusElement(el, true);
      return { ok: true, selector: publicSelectorOf(args) };
    }

    case 'scroll': {
      const b = await ctx.handle.get();
      const { by, el } = await firstElement(ctx, b, args, cmd);
      // One-line DOM call with no public primitive; run it against the
      // resolved handle rather than re-querying in the page.
      await el.evaluate((node: unknown) => {
        (node as { scrollIntoView(o: object): void }).scrollIntoView({
          block: 'center',
          inline: 'center',
        });
      });
      return { ok: true, selector: publicSelectorOf(args) };
    }

    case 'upload': {
      const files = fileList(args);
      const b = await ctx.handle.get();
      const { by, el } = await firstElement(ctx, b, args, 'upload');
      await el.setInputFiles(files);
      // Count, not paths. File contents never enter agent-visible output, and
      // neither do absolute local paths — the MCP tool promises exactly that,
      // and echoing them back leaked the caller's directory layout into a
      // transcript for no benefit: the caller already knows what it sent.
      return { ok: true, selector: publicSelectorOf(args), count: files.length };
    }

    // ---- keyboard / mouse -------------------------------------------------
    case 'key': {
      const action = optStr(args, 'action') ?? 'press';
      const b = await ctx.handle.get();
      // An optional selector focuses a field first. Prefer the `type`
      // command for text; this exists for keys aimed at a specific element.
      if (optStr(args, 'selector')) {
        const { el } = await firstElement(ctx, b, args, 'key');
        await focusElement(el);
      }
      // Validate the action before reading `key`, so an unusable action
      // reports itself rather than a missing argument the caller never
      // knew about.
      if (action !== 'press' && action !== 'down' && action !== 'up') {
        throw new CraftdriverError(
          ErrorCode.INVALID_ARGUMENT,
          `key: unknown action "${action}". Expected: press | down | up`,
          { hint: 'to type text, use `type <text>` (types into the focused element)' }
        );
      }
      const key = str(args, 'key');
      if (action === 'press') await b.keyboard.press(key);
      else if (action === 'down') await b.keyboard.down(key);
      else await b.keyboard.up(key);
      return { ok: true, action, key };
    }

    case 'mouse': {
      const action = optStr(args, 'action') ?? 'move';
      const b = await ctx.handle.get();
      const button = (optStr(args, 'button') ?? 'left') as 'left' | 'middle' | 'right';
      if (button !== 'left' && button !== 'middle' && button !== 'right') {
        throw new CraftdriverError(
          ErrorCode.INVALID_ARGUMENT,
          `mouse: unknown button "${button}". Expected: left | middle | right`
        );
      }
      // A target is either a selector or an x/y point.
      const sel = optStr(args, 'selector');
      const target = sel
        ? await resolveSelector(ctx, sel)
        : { x: int(args, 'x', 0), y: int(args, 'y', 0) };

      switch (action) {
        case 'move':
          await b.mouse.move(target);
          return { ok: true, action };
        case 'down':
          await b.mouse.down(button);
          return { ok: true, action, button };
        case 'up':
          await b.mouse.up(button);
          return { ok: true, action, button };
        case 'click':
          await b.mouse.click(target, { button });
          return { ok: true, action, button };
        case 'wheel':
          await b.mouse.wheel(
            int(args, 'deltaX', 0),
            int(args, 'deltaY', 0),
            sel ? target : undefined
          );
          return { ok: true, action };
        default:
          throw new CraftdriverError(
            ErrorCode.INVALID_ARGUMENT,
            `mouse: unknown action "${action}". Expected: move | down | up | click | wheel`
          );
      }
    }

    // ---- dialogs ---------------------------------------------------------
    case 'dialog': {
      const action = optStr(args, 'action') ?? 'inspect';
      const b = await ctx.handle.get();
      if (action === 'inspect') {
        // The driver throws "no such alert" rather than returning empty,
        // so inspecting a page with no dialog must not surface an error.
        const message = await peekDialog(b);
        return {
          open: message !== null,
          message: message === null ? '' : snippet(message, MAX_DIALOG_TEXT),
        };
      }
      if (action === 'accept') {
        await b.acceptDialog(optStr(args, 'text'));
        return { ok: true, action };
      }
      if (action === 'dismiss') {
        await b.dismissDialog();
        return { ok: true, action };
      }
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `dialog: unknown action "${action}". Expected: inspect | accept | dismiss`
      );
    }

    // ---- read ------------------------------------------------------------
    case 'text': {
      const sel = optStr(args, 'selector');
      const b = await ctx.handle.get();
      if (!sel) {
        const page = await b.activePage();
        const body = await page.evaluate('return document.body ? document.body.innerText : "";');
        // A character budget, not a row count — clamping it to the list cap
        // silently halved the documented 2000-character default.
        const limit = clampLimit(int(args, 'limit', 2000), 2000, MAX_TEXT_CHARS);
        const text = String(body);
        // The requested character budget does not supersede the global byte
        // ceiling. Without the second bound, `text --limit 100000` produced a
        // response too large for the daemon and the useful result was dropped.
        const bounded = boundString(text, { maxChars: limit });
        return { text: bounded.value, truncated: bounded.truncated, total: bounded.total };
      }
      const { el } = await firstElement(ctx, b, args, 'text');
      // The selector-less branch above pages via `--limit`; a single element's
      // text has no such bound and can be the whole document body. Same shape
      // as that branch, so `.text` is a string either way.
      const bounded = boundString(await el.text());
      return { text: bounded.value, truncated: bounded.truncated, total: bounded.total };
    }

    case 'attr': {
      const by = await selectorOf(ctx, args);
      const name = str(args, 'name');
      const b = await ctx.handle.get();
      const value = await b.getAttribute(by, name, { timeout: ms(args) });
      // A `src` data URI or a serialized state blob in a data- attribute is
      // routinely larger than everything else the agent has read all session.
      // An absent attribute stays null rather than becoming an empty string.
      const bounded = boundString(value);
      return { name, value: bounded.value, truncated: bounded.truncated, total: bounded.total };
    }

    case 'value': {
      const by = await selectorOf(ctx, args);
      const b = await ctx.handle.get();
      const bounded = boundString(await b.getValue(by, { timeout: ms(args) }));
      return { value: bounded.value, truncated: bounded.truncated, total: bounded.total };
    }

    case 'is': {
      const what = str(args, 'what');
      const by = await selectorOf(ctx, args);
      const b = await ctx.handle.get();
      const els = await b.findAll(by);
      if (els.length === 0) {
        if (what === 'visible') return { result: false };
        throw new CraftdriverError(
          ErrorCode.NO_MATCH,
          `is ${what}: no element matches ${describeSelector(by)}`,
          { detail: { selector: describeSelector(by) } }
        );
      }
      const el = els[0];
      switch (what) {
        case 'visible':
          return { result: await el.isVisible() };
        case 'enabled':
          return { result: await el.isEnabled() };
        case 'checked':
          return { result: await el.isChecked() };
        default:
          throw new CraftdriverError(
            ErrorCode.INVALID_ARGUMENT,
            `is: unknown state "${what}". Expected: visible | enabled | checked`
          );
      }
    }

    // ---- wait ------------------------------------------------------------
    case 'wait': {
      const target = str(args, 'target');
      const kind = optStr(args, 'kind') ?? 'selector';
      const b = await ctx.handle.get();
      if (kind === 'selector') {
        const state = (optStr(args, 'state') ?? 'visible') as
          'visible' | 'hidden' | 'attached' | 'detached';
        await b.waitFor(await resolveSelector(ctx, target), { state, timeout: ms(args) });
        return { ok: true, state };
      }
      if (kind === 'load') {
        await b.waitForLoadState(
          (optStr(args, 'state') as 'load' | 'domcontentloaded' | 'networkidle' | undefined) ??
            'load',
          { timeout: ms(args) }
        );
        return { ok: true };
      }
      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `wait: unknown kind "${kind}". Expected: selector | load`
      );
    }

    // ---- pages / screenshot ---------------------------------------------
    case 'pages': {
      const b = await ctx.handle.get();
      const pages = await b.pages();
      const out = await Promise.all(
        pages.map(async (p, i) => ({
          index: i,
          id: p.id(),
          url: await p.url().catch(() => ''),
          title: await p.title().catch(() => ''),
        }))
      );
      return { pages: out, count: out.length };
    }

    // ---- pages / tabs ----------------------------------------------------
    // Selecting or closing a page changes which document later commands act
    // on, so the ref registry and snapshot baseline must not survive it —
    // otherwise a ref issued against the old tab could still resolve.
    case 'page': {
      const action = optStr(args, 'action') ?? 'list';
      const b = await ctx.handle.get();
      const pages = await b.pages();

      if (action === 'list') {
        const out = await Promise.all(
          pages.map(async (p, i) => ({
            index: i,
            id: p.id(),
            url: await p.url().catch(() => ''),
            title: await p.title().catch(() => ''),
          }))
        );
        const activeId = await b
          .activePage()
          .then((p) => p.id())
          .catch(() => null);
        return { pages: out, count: out.length, active: activeId };
      }

      if (action === 'open') {
        const url = optStr(args, 'url');
        const page = await b.openPage(url ? { url } : undefined);
        await page.activate();
        ctx.tracker.reset();
        return { ok: true, action, id: page.id(), url: await page.url().catch(() => '') };
      }

      if (action === 'select' || action === 'close') {
        const target = selectPage(pages, args, action);
        if (action === 'select') {
          await target.activate();
          ctx.tracker.reset();
          return { ok: true, action, id: target.id(), url: await target.url().catch(() => '') };
        }
        const id = target.id();
        const wasLast = pages.length === 1;
        await target.close();
        ctx.tracker.reset();
        // Closing the final top-level window ends the WebDriver session, so
        // asking it for pages afterwards fails with an opaque driver error.
        if (wasLast) {
          await ctx.handle.close();
          return { ok: true, action, id, remaining: 0 };
        }
        const left = await b.pages();
        return { ok: true, action, id, remaining: left.length };
      }

      throw new CraftdriverError(
        ErrorCode.INVALID_ARGUMENT,
        `page: unknown action "${action}". Expected: list | open | select | close`
      );
    }

    // ---- console / network journal ---------------------------------------
    // Query what the page reported, rather than re-running the flow with a
    // listener attached. Capture is already live by the time any command
    // runs, so "what did that click log?" is answerable after the fact.
    case 'logs': {
      const journal = ctx.journal;
      if (!journal) {
        throw new CraftdriverError(ErrorCode.STATE_INVALID, 'logs: no journal on this session');
      }
      const action = optStr(args, 'action') ?? 'list';
      // Validate before any effect: a typo'd --kind must not cost a browser
      // launch before it is rejected.
      const kinds = parseKinds(args);
      if (action !== 'list' && action !== 'wait' && action !== 'clear') {
        throw new CraftdriverError(
          ErrorCode.INVALID_ARGUMENT,
          `logs: unknown action "${action}". Expected: list | wait | clear`
        );
      }

      // Emptying an in-memory buffer needs no browser.
      if (action === 'clear') {
        journal.clear();
        return { ok: true, action, capturing: journal.isCapturing };
      }

      // Launch on demand: asking for logs before anything else should start
      // the browser and begin capture, not report an empty history.
      await ctx.handle.get();

      const query = {
        since: int(args, 'since', 0),
        ...(kinds ? { kinds } : {}),
        ...(optStr(args, 'level') ? { level: optStr(args, 'level') } : {}),
        ...(optStr(args, 'contains') ? { contains: optStr(args, 'contains') } : {}),
        limit: limitOf(args, AGENT_DEFAULT_LIMIT),
      };

      if (action === 'wait') {
        const found = await journal.waitFor(query, ms(args));
        if (!found) {
          throw new CraftdriverError(
            ErrorCode.TIMEOUT,
            `logs wait: nothing matched within ${ms(args)}ms`,
            {
              detail: { query },
              hint: 'widen --contains or --kind, or check `logs list` for what was captured',
            }
          );
        }
        return { ok: true, action, entry: found, cursor: journal.query().cursor };
      }

      const page = journal.query(query);
      // Report capture being off rather than letting an empty list read as
      // "the page logged nothing" — those are very different answers.
      const note = journal.isCapturing
        ? undefined
        : 'capture is off: console and network history require BiDi';
      return { ...page, capturing: journal.isCapturing, ...(note ? { note } : {}) };
    }

    // ---- network mocking -------------------------------------------------
    // Only what the public library already supports as a *flat* rule: a fixed
    // response, or a block. `network.intercept()` takes a handler function,
    // which a command line cannot express — building a rule language to close
    // that gap is explicitly out of scope, so it is simply not offered.
    //
    // Active mocks are tracked here because the library keeps its intercept
    // map private; without that, `mock list` and `mock clear` could not exist
    // and the cap would be unenforceable.
    case 'mock': {
      const action = optStr(args, 'action') ?? 'list';
      const mocks = (ctx.mocks ??= []);

      if (action === 'list') {
        return {
          mocks: mocks.map(({ id, pattern, kind, status }) => ({ id, pattern, kind, status })),
          count: mocks.length,
        };
      }

      // Everything below is validated before the browser is touched. A mock
      // installed with a bad status is worse than one refused — the failure
      // then shows up as an unexplained page error much later — and rejecting
      // it should not cost a launch either.
      if (action !== 'add' && action !== 'block' && action !== 'remove' && action !== 'clear') {
        throw new CraftdriverError(
          ErrorCode.INVALID_ARGUMENT,
          `mock: unknown action "${action}". Expected: add | block | list | remove | clear`
        );
      }

      if (action === 'remove' && mocks.findIndex((m) => m.id === str(args, 'id')) === -1) {
        throw new CraftdriverError(
          ErrorCode.INVALID_ARGUMENT,
          `mock: unknown id ${JSON.stringify(str(args, 'id'))}`,
          {
            detail: { open: mocks.map((m) => m.id) },
            hint: 'run `mock list` to see active mocks',
          }
        );
      }

      // Nothing was installed, so there is nothing to remove and no reason to
      // start a browser to discover that.
      if (action === 'clear' && mocks.length === 0) {
        return { ok: true, action, cleared: 0 };
      }

      let pattern = '';
      let status = 200;
      let body = '';
      if (action === 'add' || action === 'block') {
        if (mocks.length >= MAX_MOCKS) {
          throw new CraftdriverError(
            ErrorCode.STATE_INVALID,
            `mock: limit reached (${MAX_MOCKS} active)`,
            { hint: 'remove one with `mock remove <id>`, or `mock clear`' }
          );
        }
        pattern = str(args, 'pattern');
        if (pattern.length > MAX_MOCK_PATTERN) {
          throw new CraftdriverError(
            ErrorCode.INVALID_ARGUMENT,
            `mock: pattern is too long (${pattern.length} chars; max ${MAX_MOCK_PATTERN})`
          );
        }
      }
      if (action === 'add') {
        status = int(args, 'status', 200);
        if (!Number.isInteger(status) || status < 100 || status > 599) {
          throw new CraftdriverError(
            ErrorCode.INVALID_ARGUMENT,
            `mock: status ${status} is not a valid HTTP status (100-599)`
          );
        }
        body = optStr(args, 'body') ?? '';
        if (body.length > MAX_MOCK_BODY) {
          throw new CraftdriverError(
            ErrorCode.INVALID_ARGUMENT,
            `mock: body is too large (${body.length} bytes; max ${MAX_MOCK_BODY})`,
            { hint: 'mock a small fixture; craftdriver is not a fixture server' }
          );
        }
      }

      const b = await ctx.handle.get();
      let network;
      try {
        network = b.network;
      } catch {
        throw new CraftdriverError(
          ErrorCode.UNSUPPORTED,
          'mock: network interception requires BiDi',
          { hint: 'BiDi negotiation failed at launch; Chrome and Firefox negotiate it by default' }
        );
      }

      if (action === 'clear') {
        await network.removeAllIntercepts();
        const cleared = mocks.length;
        ctx.mocks = [];
        return { ok: true, action, cleared };
      }

      if (action === 'remove') {
        const id = str(args, 'id');
        const index = mocks.findIndex((m) => m.id === id);
        await network.removeIntercept(id);
        mocks.splice(index, 1);
        return { ok: true, action, id, remaining: mocks.length };
      }

      if (action === 'block') {
        const id = await network.block(pattern);
        mocks.push({ id, pattern, kind: 'block' });
        return { ok: true, action, id, pattern };
      }

      const contentType = optStr(args, 'contentType');

      const id = await network.mock(pattern, {
        status,
        body,
        ...(contentType ? { headers: { 'content-type': contentType } } : {}),
      });
      mocks.push({ id, pattern, kind: 'mock', status });
      return { ok: true, action, id, pattern, status };
    }

    // ---- traces ----------------------------------------------------------
    // Thin wrapper over the existing tracer: this owns where a trace lands and
    // what is reported, never how one is recorded. `browser.quit()` already
    // aborts a running trace, so no cleanup is duplicated here.
    case 'trace': {
      const action = optStr(args, 'action') ?? 'status';

      if (action === 'status') {
        const active = ctx.activeTrace ?? null;
        return active ? { running: true, ...active } : { running: false, root: traceRoot() };
      }

      // Answered without a browser: whether this session started a trace is
      // bookkeeping, and launching one just to report "nothing is recording"
      // both wastes a launch and reports the failure as a driver error.
      if (action === 'stop' && !ctx.activeTrace) {
        throw new CraftdriverError(ErrorCode.STATE_INVALID, 'trace: nothing is recording', {
          hint: 'start one first with `trace start [name]`',
        });
      }

      if (action !== 'start' && action !== 'stop') {
        throw new CraftdriverError(
          ErrorCode.INVALID_ARGUMENT,
          `trace: unknown action "${action}". Expected: start | stop | status`
        );
      }

      // Resolve and validate the destination before launching: a name that
      // cannot be used should cost a usage error, not a browser.
      let name = '';
      let outDir = '';
      if (action === 'start') {
        if (ctx.activeTrace) {
          throw new CraftdriverError(
            ErrorCode.STATE_INVALID,
            `trace: "${ctx.activeTrace.name}" is already recording`,
            {
              detail: { ...ctx.activeTrace },
              hint: 'stop it first with `trace stop`',
            }
          );
        }
        name = optStr(args, 'name') ?? 'trace';
        outDir = await resolveArtifactPath({ root: traceRoot(), name, kind: 'trace' });
      }

      const b = await ctx.handle.get();

      if (action === 'start') {
        // Screenshots are on by default in the library. They are the bulk of a
        // trace's size, so allow turning them off without inventing options
        // the tracer does not already have.
        await b.startTrace({
          outDir,
          ...(bool(args, 'noScreenshots') ? { screenshots: false as const } : {}),
        });
        ctx.activeTrace = { name, outDir, startedAt: new Date().toISOString() };
        return { ok: true, action, ...ctx.activeTrace };
      }

      if (action === 'stop') {
        // Non-null: the no-trace case is rejected above, before any launch.
        const active = ctx.activeTrace!;
        // Export a shareable archive only when asked: writing one doubles the
        // artifact for a caller who just wants to look at the NDJSON.
        const zip = bool(args, 'zip')
          ? await resolveArtifactPath({
              root: traceRoot(),
              name: active.name,
              suffix: '.zip',
              kind: 'trace',
            })
          : undefined;
        try {
          await b.stopTrace(zip ? { path: zip } : undefined);
        } finally {
          // Clear regardless: a failed export must not leave the session
          // believing a trace is still recording when the tracer has stopped.
          ctx.activeTrace = null;
        }
        return {
          ok: true,
          action,
          name: active.name,
          outDir: active.outDir,
          trace: `${active.outDir}/trace.ndjson`,
          ...(zip ? { zip } : {}),
        };
      }

      // Unreachable: the action was validated before the launch.
      throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, `trace: unhandled action "${action}"`);
    }

    // ---- authentication / storage state ----------------------------------
    // `stateStore` owns where a state file may live and who may read it; this
    // case owns *when* saving or restoring one is meaningful.
    //
    // Restoration policy lives in the library so CLI, launch, and direct API
    // calls cannot drift. BiDi can restore cookies + localStorage before the
    // first public navigation; Classic and sessionStorage use the strict
    // active-origin path and fail before mutation when the page is unsuitable.
    case 'state': {
      const action = optStr(args, 'action') ?? 'list';

      if (action === 'list') {
        return { states: await listStateNames(), root: stateRoot() };
      }

      if (action !== 'save' && action !== 'load') {
        throw new CraftdriverError(
          ErrorCode.INVALID_ARGUMENT,
          `state: unknown action "${action}". Expected: save | load | list`
        );
      }

      const name = optStr(args, 'name');
      const target = await resolveStatePath(name as string);
      const b = await ctx.handle.get();

      // Both directions run page script to reach localStorage, so both sit on
      // the driver's script timeout behind a modal. A login flow is a likely
      // place to have left one open.
      const blocking = await peekDialog(b);
      if (blocking !== null) {
        throw new CraftdriverError(
          ErrorCode.STATE_INVALID,
          `cannot ${action} state while a dialog is open: ${snippet(blocking, MAX_DIALOG_TEXT)}`,
          { hint: 'accept or dismiss it first with `dialog accept` / `dialog dismiss`' }
        );
      }

      const origin = await activeOrigin(b);

      if (action === 'save') {
        const includeSessionStorage = bool(args, 'sessionStorage');
        const tmp = await prepareTempStatePath(target);
        let state;
        try {
          state = await b.saveState(tmp, { includeSessionStorage });
          await commitStateFile(tmp, target);
        } catch (err) {
          await discardTempStateFile(tmp);
          throw err;
        }
        const summary = summarizeState(state);
        // Saving from a page with no real origin captures cookies only. That
        // is legitimate, but it is also how an agent ends up with a state file
        // that silently restores less than it expected, so say it here.
        const note =
          origin === null && summary.storageKeys === 0
            ? 'no page origin: cookies were saved, local/session storage was not'
            : undefined;
        return {
          ok: true,
          action,
          name,
          root: stateRoot(),
          origin,
          ...summary,
          ...(note ? { note } : {}),
        };
      }

      const state = await readStateFile(target, name as string);
      await b.loadState(target);
      // Cookies and storage just changed underneath the page: anything the
      // agent holds a ref to was resolved against the pre-restore document.
      ctx.tracker.reset();
      return { ok: true, action, name, root: stateRoot(), origin, ...summarizeState(state) };
    }

    case 'screenshot': {
      const b = await ctx.handle.get();
      const fullPage = bool(args, 'fullPage');
      const sel = optStr(args, 'selector');
      // Keep one implicit screenshot per named session. Timestamped defaults
      // made an exploratory loop grow `.craftdriver/screenshots` forever;
      // overwriting this tool-owned "latest" file is bounded and still leaves
      // explicit `-o` available when the caller wants history.
      const path =
        optStr(args, 'path') ??
        (await resolveArtifactPath({
          root: artifactRoot('screenshots', 'CRAFTDRIVER_SCREENSHOT_DIR'),
          name: `screenshot-${ctx.artifactName ?? 'default'}`,
          suffix: '.png',
          kind: 'screenshot',
        }));
      const buf = await b.screenshot({
        path,
        ...(sel ? { selector: await resolveSelector(ctx, sel) } : {}),
        ...(fullPage ? { fullPage: true } : {}),
        timeout: ms(args),
      });
      return { ok: true, path, bytes: buf.length };
    }

    // ---- snapshot --------------------------------------------------------
    // Sanitized accessibility-tree summary of the active page. Each
    // visible interactive node gets a stable ref (`eN`) which can be
    // used as a selector via `ref=eN` for the next command. Refs
    // invalidate on the next snapshot or on navigation.
    case 'snapshot': {
      const b = await ctx.handle.get();
      // Same modal hazard as the automatic snapshot: report the dialog
      // rather than blocking on the script timeout and returning nothing.
      const blocking = await peekDialog(b);
      if (blocking !== null) {
        return {
          url: '',
          title: '',
          lines: [],
          note: `dialog open: ${snippet(blocking, MAX_DIALOG_TEXT)} — accept or dismiss it first`,
        };
      }
      // Recording here is what keeps explicit and automatic snapshots on
      // one baseline: whatever the agent is shown becomes what the next
      // post-action diff is measured against.
      const snap = ctx.tracker.record(await takeSnapshot(b, ctx.tracker.minRef));
      if (!snap) {
        return { url: '', title: '', lines: [], note: 'no snapshot available' };
      }
      return {
        url: snap.url,
        title: snap.title,
        lines: snap.lines,
        documentId: snap.documentId,
        revision: snap.revision,
      };
    }

    // ---- accessibility ---------------------------------------------------
    // axe-core at page or element scope, with every reported node carrying a
    // snapshot ref. That ref is the whole point: axe hands back a CSS *path*
    // (`div > p:nth-child(3)`), which is a position rather than a handle. A
    // ref goes straight into `locators` and comes back as a durable selector
    // for the fix, so the loop closes without the agent guessing.
    case 'a11y': {
      const options = a11yOptionsOf(args);
      const check = bool(args, 'check');
      const limit = clampLimit(
        int(args, 'limit', AGENT_DEFAULT_LIMIT),
        AGENT_DEFAULT_LIMIT,
        MAX_A11Y_VIOLATIONS
      );
      const perViolation = clampLimit(
        int(args, 'nodes', A11Y_DEFAULT_NODES),
        A11Y_DEFAULT_NODES,
        MAX_A11Y_NODES
      );
      const sel = optStr(args, 'selector');

      const b = await ctx.handle.get();
      // Injecting and running axe is page script, so a modal would park the
      // command on the driver's script timeout before failing.
      const blocking = await peekDialog(b);
      if (blocking !== null) {
        throw new CraftdriverError(
          ErrorCode.STATE_INVALID,
          `cannot audit while a dialog is open: ${snippet(blocking, MAX_DIALOG_TEXT)}`,
          { hint: 'accept or dismiss it first with `dialog accept` / `dialog dismiss`' }
        );
      }
      const scope = sel ? (await firstElement(ctx, b, args, 'a11y')).el.a11y : b.a11y;
      const report = await scope.audit(options);

      // Order matters. The audit reads each node's `html`, and taking a
      // snapshot stamps `data-craftdriver-ref` markers — so snapshotting first
      // would put craftdriver's own diagnostic attribute into the evidence the
      // agent is about to read. The baseline still has to be recorded before
      // minting, because a ref only resolves against the document the tracker
      // names, and it seeds the floor that keeps audit refs above the session
      // high-water mark.
      ctx.tracker.record(await takeSnapshot(b, ctx.tracker.minRef));

      const shown = report.violations.slice(0, limit);
      let truncated = report.violations.length > shown.length;
      let budget = MAX_A11Y_REPORT_NODES;
      const picked = shown.map((violation) => {
        const nodes = violation.nodes.slice(0, Math.min(perViolation, budget));
        if (nodes.length < violation.nodes.length) truncated = true;
        budget -= nodes.length;
        return { violation, nodes };
      });

      const minted = await mintRefs(
        b,
        picked.flatMap((entry) => entry.nodes.map((node) => node.target)),
        ctx.tracker.minRef
      );
      // A ref the session cannot resolve is worse than none: the agent would
      // spend a command discovering it is stale. Only hand out refs minted in
      // the document the tracker's baseline actually names.
      const usable =
        minted.documentId !== null && minted.documentId === ctx.tracker.documentId
          ? minted.refs
          : minted.refs.map(() => null);
      ctx.tracker.noteIssued(usable);

      let cursor = 0;
      const violations = picked.map(({ violation, nodes }) => ({
        id: violation.id,
        impact: violation.impact,
        wcag: wcagTags(violation),
        help: violation.help,
        description: violation.description,
        helpUrl: violation.helpUrl,
        nodes: nodes.map((node) => {
          const ref = usable[cursor++];
          return {
            ...(ref ? { ref } : {}),
            target: a11yTargetLabel(node.target),
            html: a11yHtml(node.html),
            failureSummary: a11ySummary(node.failureSummary),
          };
        }),
      }));

      return {
        ...(sel ? { scope: publicSelectorOf(args) } : {}),
        minImpact: options.minImpact,
        violations,
        counts: {
          violations: report.violations.length,
          passes: report.passes,
          incomplete: report.incomplete,
        },
        truncated,
        // Check the whole filtered audit, never the bounded display slice: a
        // small --limit must not turn a failed verification green.
        ...(check ? { checked: true, passed: report.violations.length === 0 } : {}),
      };
    }

    // ---- eval (advanced) -------------------------------------------------
    case 'eval': {
      const code = str(args, 'js');
      const b = await ctx.handle.get();
      const page = await b.activePage();
      // Wrap as function body so callers can pass either an expression
      // ("document.title") or a statement list ("return foo + 1;").
      const body = /\breturn\b/.test(code) ? code : `return (${code});`;
      const result = await page.evaluate(body);
      // `eval` returns whatever the page hands back — an unbounded innerHTML
      // is one keystroke away — so the bound lands here, where the value is
      // produced, rather than in one transport's envelope.
      return { result: boundValue(result) };
    }

    default:
      throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, `unknown command "${cmd}"`, {
        hint: 'run `craftdriver --help` for the command list',
      });
  }
}
