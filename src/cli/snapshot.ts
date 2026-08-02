/**
 * Compact a11y snapshot generation, stable refs, and per-session diffing.
 *
 * Why this exists: a11y snapshot is the default agent view, not a
 * screenshot. Screenshots cost 800–1500 image tokens; a flat list of
 * visible interactive elements (role + accessible name + selector hint)
 * is ~50–500 text tokens and far more useful for a text model writing
 * the next selector.
 *
 * ## Refs bind to identity, not to position
 *
 * Refs (`e1`, `e2`, …) used to be re-stamped in document order on every
 * snapshot. That made them actively dangerous: insert one node near the
 * top of the page and every ref below it silently slid onto a *different*
 * element, so an agent's next click landed on something it had never
 * inspected.
 *
 * Now the page owns a registry (`window.__craftdriverRefs`) mapping each
 * ref to the actual element node:
 *
 *   - a surviving node keeps its ref across snapshots;
 *   - a new node always gets a fresh, monotonically increasing ref;
 *   - refs are never recycled within a document.
 *
 * The registry lives on `window`, so a navigation or reload starts a new
 * document with a new `documentId` and an empty registry — which is what
 * makes every pre-navigation ref detectably stale instead of silently
 * rebound.
 *
 * The element marker attribute (`data-craftdriver-ref`) is diagnostic only.
 * Resolution goes directly through the registry, which works for elements
 * inside open shadow trees and cannot be confused by authored or cloned
 * marker attributes.
 */
import { INTERNAL_EVALUATE_CLASSIC, type Browser } from '../lib/browser.js';
import type { A11yTarget } from '../lib/a11y.js';
import { PAGE_SEMANTICS_JS } from './pageSemantics.js';

const MAX_NODES = 80;
/** Incidental leaf text is useful evidence, but must never hide controls. */
const MAX_EVIDENCE_TEXT_NODES = 10;
/** Keep ordinary prose independently bounded. */
const MAX_ORDINARY_TEXT_NODES = 7;
/** Long prose belongs to `text`, not to the action-oriented snapshot. */
const MAX_TEXT_LENGTH = 120;
const MAX_NAME = 80;
const MAX_HREF = 80;
/**
 * Upper bound on refs issued per document. Reaching it resets the registry
 * under a fresh `documentId`, which invalidates every outstanding ref
 * rather than letting numbers wrap onto live elements.
 */
const MAX_REFS = 2000;

export interface SnapshotShape {
  url: string;
  title: string;
  /** Visible semantic nodes plus indented open-shadow boundary lines. */
  lines: string[];
  /**
   * Identity of the document the refs belong to. Changes on navigation and
   * reload, including reload of the same URL, and on registry reset.
   */
  documentId: string;
  /** Session-monotonic snapshot counter, stamped by the session tracker. */
  revision: number;
  /** Refs present in this snapshot. */
  refs: string[];
  /** Next ref number the page would issue; seeds the session high-water mark. */
  nextRef: number;
}

/** Why a ref no longer identifies exactly one live element. */
export type RefStatus =
  | 'ok'
  | 'no-snapshot'
  | 'no-registry'
  | 'document-changed'
  | 'unknown-ref'
  | 'detached'
  | 'ambiguous';

export interface RefProbe {
  status: RefStatus;
  documentId: string | null;
  count?: number;
}

/**
 * Build a fresh snapshot of the active page. Errors swallowed so a
 * partial post-action payload never breaks the protocol.
 */
export async function takeSnapshot(browser: Browser, minRef = 0): Promise<SnapshotShape | null> {
  try {
    // The snapshot is a synchronous, JSON-safe DOM probe. Running it through
    // Classic avoids paying for a fresh BiDi realm after every navigation
    // (measured in seconds on Chrome) without changing public evaluate().
    const raw = await browser[INTERNAL_EVALUATE_CLASSIC](jsSnapshot(minRef));
    if (!raw || typeof raw !== 'object') return null;
    const shaped = raw as {
      url?: unknown;
      title?: unknown;
      lines?: unknown;
      documentId?: unknown;
      refs?: unknown;
      nextRef?: unknown;
    };
    return {
      url: typeof shaped.url === 'string' ? shaped.url : '',
      title: typeof shaped.title === 'string' ? shaped.title : '',
      lines: Array.isArray(shaped.lines) ? (shaped.lines as string[]) : [],
      documentId: typeof shaped.documentId === 'string' ? shaped.documentId : '',
      revision: 0,
      refs: Array.isArray(shaped.refs) ? (shaped.refs as string[]) : [],
      nextRef: typeof shaped.nextRef === 'number' ? shaped.nextRef : minRef + 1,
    };
  } catch {
    return null;
  }
}

/** Outcome of minting refs for elements the snapshot never listed. */
export interface MintedRefs {
  /**
   * One entry per requested target, in order. `null` where the target did not
   * resolve — detached, behind a closed shadow root, or inside a frame.
   */
  refs: Array<string | null>;
  /** Document the refs belong to, for comparison against the session baseline. */
  documentId: string | null;
}

/**
 * Issue refs for arbitrary elements, addressed by axe-core target paths.
 *
 * Snapshots only ref *visible interactive* elements, but most accessibility
 * violations land somewhere else entirely: an `<img>` with no alt, low-contrast
 * body copy, a heading out of order. Without this, an audit could report a
 * problem and give the agent no way to act on it — axe's `div > p:nth-child(3)`
 * is a position, not a handle.
 *
 * Refs come from the same in-page registry `snapshot` uses, so an element the
 * agent already knows as `e7` is still `e7` here — never a second number for
 * the same node.
 *
 * A target that does not resolve reports `null` rather than throwing. A
 * partially reffed report is useful; a failed audit is not.
 */
export async function mintRefs(
  browser: Browser,
  targets: A11yTarget[][],
  minRef = 0
): Promise<MintedRefs> {
  const empty: MintedRefs = { refs: targets.map(() => null), documentId: null };
  if (targets.length === 0) return { refs: [], documentId: null };
  try {
    const raw = await browser[INTERNAL_EVALUATE_CLASSIC](jsMintRefs(targets, minRef));
    if (!raw || typeof raw !== 'object') return empty;
    const shaped = raw as { refs?: unknown; documentId?: unknown };
    const refs = Array.isArray(shaped.refs) ? shaped.refs : [];
    return {
      refs: targets.map((_, i) => (typeof refs[i] === 'string' ? (refs[i] as string) : null)),
      documentId: typeof shaped.documentId === 'string' ? shaped.documentId : null,
    };
  } catch {
    return empty;
  }
}

/**
 * Return the text of an open JavaScript dialog, or null if none is open.
 *
 * Cheap (~2ms) and, unlike almost every other command, safe to call while
 * a modal dialog is blocking the page. That matters: a modal blocks script
 * execution, so an unguarded post-action snapshot sits there until the
 * WebDriver script timeout — a measured 60 seconds — before failing.
 */
export async function peekDialog(browser: Browser): Promise<string | null> {
  try {
    return await browser.getDialogMessage();
  } catch {
    // The driver reports "no such alert" by throwing; that is the common case.
    return null;
  }
}

/**
 * Ask the page whether `ref` still identifies exactly one live element.
 *
 * `expectedDocumentId` is the document the ref was issued against; a
 * mismatch means the page navigated and every outstanding ref is stale.
 */
export async function probeRef(
  browser: Browser,
  ref: string,
  expectedDocumentId: string | null
): Promise<RefProbe> {
  if (!/^e\d+$/.test(ref)) return { status: 'unknown-ref', documentId: null };
  try {
    const js = jsProbeRef(ref, expectedDocumentId);
    const raw = await browser[INTERNAL_EVALUATE_CLASSIC](js);
    if (!raw || typeof raw !== 'object') return { status: 'no-registry', documentId: null };
    const shaped = raw as { status?: unknown; documentId?: unknown; count?: unknown };
    return {
      status: (typeof shaped.status === 'string' ? shaped.status : 'no-registry') as RefStatus,
      documentId: typeof shaped.documentId === 'string' ? shaped.documentId : null,
      ...(typeof shaped.count === 'number' ? { count: shaped.count } : {}),
    };
  } catch {
    return { status: 'no-registry', documentId: null };
  }
}

/** Human-readable reason attached to a STALE_REF failure. */
export function describeRefStatus(status: RefStatus): string {
  switch (status) {
    case 'no-snapshot':
      return 'no snapshot has been taken in this session yet';
    case 'no-registry':
      return 'the page has no ref registry (it navigated or was replaced)';
    case 'document-changed':
      return 'the page navigated or reloaded after the ref was issued';
    case 'unknown-ref':
      return 'the ref was never issued for the current document';
    case 'detached':
      return 'the element was removed from the document';
    case 'ambiguous':
      return 'the ref no longer identifies exactly one element';
    default:
      return 'the ref is no longer valid';
  }
}

/**
 * Render a snapshot as a compact, agent-friendly string. Either the
 * full snapshot (first call in a session) or a `+/-` diff vs. the
 * previous snapshot in the same session.
 *
 * Diff format intentionally mirrors `diff -u` lines so agents
 * already familiar with unified diffs read it without instruction.
 *
 * Refs are stripped before the set-difference and re-attached when
 * rendering, so a diff reports semantic change rather than renumbering.
 */
export function renderDelta(prev: SnapshotShape | null, next: SnapshotShape | null): string {
  if (!next) return '';
  const header = `page: ${next.title || '(untitled)'} — ${next.url || '(no url)'}`;
  if (!prev) {
    // First snapshot — print full.
    if (next.lines.length === 0) return `${header}\n(no interactive elements detected)`;
    return `${header}\n${next.lines.join('\n')}`;
  }
  // A new document means the old lines describe a page that no longer
  // exists; a diff against them would be noise. Same-URL reloads count.
  if (prev.documentId !== next.documentId || prev.url !== next.url) {
    return `${header}\n${next.lines.join('\n')}`;
  }
  const strip = (l: string): string => l.replace(/^(\s*)e\d+:\s*/, '$1');
  // Count occurrences rather than testing membership: a page with three
  // identical "Remove" buttons must still report a change when one of them
  // goes, and a set-difference silently calls that "no changes".
  const tally = (lines: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const line of lines) {
      const body = strip(line);
      counts.set(body, (counts.get(body) ?? 0) + 1);
    }
    return counts;
  };
  const prevCounts = tally(prev.lines);
  const nextCounts = tally(next.lines);
  const take = (lines: string[], budget: Map<string, number>): string[] => {
    const out: string[] = [];
    const seen = new Map<string, number>();
    for (const line of lines) {
      const body = strip(line);
      const used = seen.get(body) ?? 0;
      // Report the surplus copies only — the first N matching lines are
      // accounted for by the other side.
      if (used >= (budget.get(body) ?? 0)) out.push(line);
      seen.set(body, used + 1);
    }
    return out;
  };
  const removed = take(prev.lines, nextCounts).map((l) => `- ${l}`);
  const added = take(next.lines, prevCounts).map((l) => `+ ${l}`);
  if (removed.length === 0 && added.length === 0) {
    return `${header}\n(no a11y changes)`;
  }
  return `${header}\n${removed.concat(added).join('\n')}`;
}

/**
 * Render a fresh, full snapshot (no diff). Used by the on-demand
 * `snapshot` command + `browser_snapshot` tool when the agent wants
 * the current sanitized DOM regardless of session history.
 */
export function renderFull(next: SnapshotShape | null): string {
  if (!next) return '(no snapshot available)';
  const header = `page: ${next.title || '(untitled)'} — ${next.url || '(no url)'}`;
  if (next.lines.length === 0) {
    return `${header}\n(no interactive elements detected)`;
  }
  return `${header}\n${next.lines.join('\n')}`;
}

/**
 * Owns the one snapshot baseline and ref-issuing document for a session.
 *
 * Both explicit `snapshot` and the automatic post-action snapshot record
 * through here, so an explicit snapshot the agent has already been shown
 * is never re-reported as a change caused by the next action.
 */
export class SnapshotTracker {
  private baseline: SnapshotShape | null = null;
  private revision = 0;
  private highWater = 0;
  private readonly issuedRefs = new Set<string>();

  /** The document outstanding refs were issued against, if any. */
  get documentId(): string | null {
    return this.baseline ? this.baseline.documentId : null;
  }

  get current(): SnapshotShape | null {
    return this.baseline;
  }

  /**
   * Highest ref number issued anywhere in this session.
   *
   * Seeding each new document above this is what stops a reload from
   * reissuing `e2` to a different element: a ref the agent still holds
   * would otherwise silently resolve against the new page.
   */
  get minRef(): number {
    return this.highWater;
  }

  /** Whether this session has ever shown the ref to the agent. */
  hasIssuedRef(ref: string): boolean {
    return this.issuedRefs.has(ref);
  }

  /**
   * Adopt refs issued outside a snapshot — {@link mintRefs} hands them to an
   * audit for elements a snapshot never lists.
   *
   * Both halves of what `record()` does for a ref matter here. Without the
   * issued set, a minted `e12` used bare fails the BARE_REF guard: the agent
   * would be refused a ref this session had just given it. Without the
   * high-water mark, the next document could reissue `e12` to a different
   * element, which is exactly what refs exist to prevent.
   */
  noteIssued(refs: Array<string | null>): void {
    for (const ref of refs) {
      if (!ref) continue;
      this.issuedRefs.add(ref);
      const n = Number(ref.slice(1));
      if (Number.isSafeInteger(n)) this.highWater = Math.max(this.highWater, n);
    }
  }

  /** Stamp a session-monotonic revision and make this the new baseline. */
  record(snap: SnapshotShape | null): SnapshotShape | null {
    if (!snap) return null;
    const stamped: SnapshotShape = { ...snap, revision: ++this.revision };
    this.baseline = stamped;
    this.highWater = Math.max(this.highWater, stamped.nextRef - 1);
    for (const ref of stamped.refs) this.issuedRefs.add(ref);
    return stamped;
  }

  /** Diff against the baseline and advance it in one step. */
  advance(snap: SnapshotShape | null): string {
    if (!snap) return '';
    const delta = renderDelta(this.baseline, { ...snap, revision: this.revision + 1 });
    this.record(snap);
    return delta;
  }

  reset(): void {
    this.baseline = null;
  }
}

/**
 * Resolve axe-core target paths to elements and ref them.
 *
 * `targets` is JSON-encoded into the source, so a selector the page authored
 * cannot break out of the string it arrives in.
 *
 * Target shape, straight from axe: the outer array is one entry per frame, and
 * an entry is either a CSS selector or — for an element inside open shadow
 * roots — the selector path that walks into them. Anything with more than one
 * frame entry addresses a document this script is not running in, so it is
 * reported unresolved rather than matched against the wrong document: a ref
 * that silently points at a same-selector element in the *top* frame is worse
 * than no ref at all.
 */
function jsMintRefs(targets: A11yTarget[][], minRef: number): string {
  return `
${refRegistryJs(minRef)}const targets = ${JSON.stringify(targets)};
function resolveTarget(path) {
  if (!Array.isArray(path) || path.length !== 1) return null;
  const steps = Array.isArray(path[0]) ? path[0] : [path[0]];
  let root = document;
  let el = null;
  for (let i = 0; i < steps.length; i++) {
    if (!root || typeof steps[i] !== 'string') return null;
    try {
      el = root.querySelector(steps[i]);
    } catch (e) {
      return null;
    }
    if (!el) return null;
    // Only an open root is walkable; a closed one leaves root null and the
    // next step reports the target unresolved.
    root = el.shadowRoot;
  }
  return el;
}
const reg = registry();
const refs = targets.map(function (path) {
  const el = resolveTarget(path);
  return el && el.isConnected ? refFor(reg, el) : null;
});
return { refs: refs, documentId: reg.doc };
`;
}

/**
 * Ref-validation probe. `ref` is `^e\d+$`-validated before it gets here and
 * both values are JSON-encoded into the source, so neither can break out.
 */
function jsProbeRef(ref: string, expectedDocumentId: string | null): string {
  return `
const reg = window.__craftdriverRefs;
const ref = ${JSON.stringify(ref)};
const expected = ${JSON.stringify(expectedDocumentId)};
if (!reg || !reg.map) return { status: 'no-registry', documentId: null };
if (expected !== null && reg.doc !== expected) {
  return { status: 'document-changed', documentId: reg.doc };
}
const el = reg.map.get(ref);
if (!el) return { status: 'unknown-ref', documentId: reg.doc };
if (!el.isConnected || el.ownerDocument !== document) {
  return { status: 'detached', documentId: reg.doc };
}
// The reverse map is the exact identity index. A mismatch is only possible for a
// corrupt/legacy registry; marker attributes deliberately do not participate.
if (reg.reverse && reg.reverse.get(el) !== ref) {
  return { status: 'ambiguous', documentId: reg.doc };
}
return { status: 'ok', documentId: reg.doc };
`;
}

/**
 * The in-page ref registry, as source both `snapshot` and on-demand minting
 * embed.
 *
 * It lives here rather than inside one command's template because refs are
 * session state, not snapshot state: an audit refs elements a snapshot never
 * lists (an `<img>` with no alt, low-contrast prose), and those refs have to
 * come from the *same* registry or the two would hand out the same number for
 * different elements. One counter, one reverse index, one re-key rule.
 *
 * `minRef` is the session high-water mark: the floor a fresh document's
 * counter starts above so a ref captured before a navigation can never match
 * a new element.
 */
function refRegistryJs(minRef: number): string {
  const floor = Number.isSafeInteger(minRef) && minRef >= 0 ? minRef : 0;
  return `const MAX_REFS = ${MAX_REFS};
const MIN_REF = ${floor};
function newDocId(epoch) {
  return 'd' + epoch + '-' + Math.random().toString(36).slice(2, 10);
}
function registry() {
  let reg = window.__craftdriverRefs;
  if (!reg || !reg.map) {
    reg = {
      doc: newDocId(1), epoch: 1, next: 1, issued: 0,
      map: new Map(), reverse: new WeakMap()
    };
    window.__craftdriverRefs = reg;
  }
  if (!reg.reverse) {
    reg.reverse = new WeakMap();
    reg.map.forEach(function (el, ref) {
      if (el) reg.reverse.set(el, ref);
    });
  }
  // Never reissue a number the session has already handed out. A fresh
  // document starts its counter above the session high-water mark, so a
  // ref captured before a navigation can never match a new element.
  if (reg.next <= MIN_REF) reg.next = MIN_REF + 1;
  // Bounded: at the cap, drop every marker and re-key the document so all
  // outstanding refs fail as stale instead of wrapping onto live elements.
  //
  // The cap counts refs issued *by this registry*, not the counter value.
  // Counting the counter would compare against the session-wide high-water
  // mark, which passes the cap after enough navigations and would then
  // re-key on every single snapshot — invalidating refs the instant they
  // were handed out.
  if (reg.issued >= MAX_REFS) {
    reg.map.forEach(function (el) {
      if (el && el.removeAttribute) el.removeAttribute('data-craftdriver-ref');
    });
    reg.epoch += 1;
    reg.doc = newDocId(reg.epoch);
    reg.issued = 0;
    reg.map = new Map();
    reg.reverse = new WeakMap();
  }
  return reg;
}
function refFor(reg, el) {
  const existing = reg.reverse.get(el);
  if (existing && reg.map.get(existing) === el) return existing;
  const ref = 'e' + reg.next;
  reg.next += 1;
  reg.issued += 1;
  reg.map.set(ref, el);
  reg.reverse.set(el, ref);
  // Diagnostic only. Exact ref resolution never queries this attribute.
  el.setAttribute('data-craftdriver-ref', ref);
  return ref;
}
`;
}

/**
 * JS executed in-page. Keep it self-contained — no closure capture.
 *
 * Strategy:
 * 1. Get or create the per-document ref registry.
 * 2. Walk the composed tree, entering open shadow roots and flattened slots.
 * 3. Skip nodes outside the viewport-ish bounds and zero-sized nodes.
 * 4. Reuse each node's existing ref, or issue the next unused one.
 * 5. Bound semantic and short-text evidence independently so prose cannot
 *    hide controls and output stays bounded regardless of page complexity.
 */
function jsSnapshot(minRef: number): string {
  return `
const MAX_NODES = ${MAX_NODES};
const MAX_EVIDENCE_TEXT_NODES = ${MAX_EVIDENCE_TEXT_NODES};
const MAX_ORDINARY_TEXT_NODES = ${MAX_ORDINARY_TEXT_NODES};
const MAX_TEXT_LENGTH = ${MAX_TEXT_LENGTH};
const MAX_NAME = ${MAX_NAME};
const MAX_HREF = ${MAX_HREF};
${refRegistryJs(minRef)}function visible(el) {
  if (!el || !el.getClientRects) return false;
  // Layout APIs already account for display:none ancestors, but aria-hidden
  // and inert content can still have boxes. Never tell an agent that content
  // hidden from the accessibility tree is available to act on or verify.
  for (let p = el; p && p.nodeType === 1;) {
    if (p.hidden || p.hasAttribute('inert') || p.getAttribute('aria-hidden') === 'true') return false;
    const root = p.getRootNode ? p.getRootNode() : null;
    p = p.parentElement || (root && root.host) || null;
  }
  const rects = el.getClientRects();
  if (!rects.length) return false;
  const r = rects[0];
  if (r.width === 0 || r.height === 0) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
  return true;
}
${PAGE_SEMANTICS_JS}
function visibleText(el) {
  const chunks = [];
  function collect(node) {
    if (node.nodeType === 3) {
      chunks.push(node.nodeValue || '');
      return;
    }
    if (node.nodeType !== 1 || (node !== el && !visible(node))) return;
    const children = node.childNodes || [];
    for (let i = 0; i < children.length; i++) collect(children[i]);
  }
  collect(el);
  return chunks.join(' ').trim().replace(/\\s+/g, ' ');
}
function explicitName(el) {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const labelledby = el.getAttribute('aria-labelledby');
  if (!labelledby) return '';
  const ref = elementByIdInRoot(semanticRoot(el), labelledby);
  return ref && visible(ref) ? visibleText(ref) : '';
}
function snapshotName(el, role, contentOnly) {
  if (contentOnly) return visibleText(el);
  // Structural containers must not inherit every descendant's text as their
  // name. Besides being noisy, raw textContent can include hidden results and
  // make an agent believe content is already visible.
  if (isStructuralRole(role)) return explicitName(el);
  return accName(el);
}
function isStructuralRole(role) {
  return role === 'main' || role === 'navigation' || role === 'form' ||
    role === 'article' || role === 'banner' || role === 'contentinfo' ||
    role === 'list' || role === 'table' || role === 'row' ||
    role === 'search' || role === 'region' || role === 'group' ||
    role === 'dialog' || role === 'alertdialog' || role === 'complementary' ||
    role === 'feed' || role === 'section';
}
function locatorHint(el) {
  if (el.id) return '#' + el.id;
  const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
  if (testid) return '[data-testid=' + JSON.stringify(testid) + ']';
  const name = el.getAttribute('name');
  if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
  return null;
}
const reg = registry();
// Short leaf content is decision evidence (validation, result summaries,
// save confirmations), not merely decoration. Keep the allow-list narrow and
// the global MAX_NODES/MAX_NAME bounds intact so this cannot become a DOM dump.
const contentSel = 'p,output,dt,dd,figcaption,caption';
const semanticSel = 'a,button,input,select,textarea,h1,h2,h3,h4,h5,h6,[role],nav,main,header,footer,form,img,label';
const sel = semanticSel + ',[aria-live],' + contentSel;
const out = [];
const refs = [];
const seen = new WeakSet();
let semanticCount = 0;
let evidenceTextCount = 0;
let ordinaryTextCount = 0;
function emit(el, depth) {
  if (!visible(el)) return;
  // A <header>/<footer> inside sectioning content is not a landmark, and
  // listing it as a bare tag would be pure noise. Everything else keeps a
  // line even without an ARIA role, so controls stay addressable by ref.
  const tag = el.tagName.toLowerCase();
  if (!ariaRole(el) && (tag === 'header' || tag === 'footer')) return;
  const contentOnly = el.matches(contentSel) && !ariaRole(el);
  if (!contentOnly && semanticCount >= MAX_NODES) return;
  const role = contentOnly ? 'text' : displayRole(el);
  let name = snapshotName(el, role, contentOnly);
  const fieldValueSensitive =
    (tag === 'input' || tag === 'textarea') && fieldValueIsSensitive(el, name);
  // Some DOM fallbacks treat a textarea's text content as its accessible
  // name. If that content is also the sensitive value, omitting value= alone
  // would still leak it through the quoted name.
  if (fieldValueSensitive) {
    const value = String(el.value || '');
    if (value && name.includes(value)) name = explicitName(el);
  }
  // A bare empty announcement target carries no evidence. If it later gains
  // content it will appear as an added line in the next delta.
  if (el.hasAttribute('aria-live') && !el.matches(semanticSel) && !name) return;
  // Empty leaf content carries no evidence and should not consume a ref. It
  // will appear as an added line if an action later populates it.
  if (contentOnly && !name) return;
  // Bare paragraphs and definition text are often article prose. Preserve
  // short status/result evidence while sending long-form reading through the
  // explicit text command. Purpose-built evidence elements have a separate
  // bounded budget so article prose cannot hide multiple validation results.
  const evidenceText =
    tag === 'output' || tag === 'caption' || tag === 'figcaption' ||
    el.hasAttribute('aria-live') || hasEvidenceIdentity(el);
  if (contentOnly && evidenceText && evidenceTextCount >= MAX_EVIDENCE_TEXT_NODES) return;
  if (contentOnly && !evidenceText && ordinaryTextCount >= MAX_ORDINARY_TEXT_NODES) return;
  if (contentOnly && !evidenceText && name.length > MAX_TEXT_LENGTH) return;
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME - 1) + '…';
  const hint = locatorHint(el);
  const ref = refFor(reg, el);
  refs.push(ref);
  let line = '  '.repeat(depth) + ref + ': ' + role;
  if (isStructuralRole(role)) line += ' (container)';
  if (name) line += ' "' + name + '"';
  if (role === 'heading') {
    const nativeLevel = /^h[1-6]$/.test(tag) ? tag.slice(1) : null;
    const level = el.getAttribute('aria-level') || nativeLevel;
    if (level) line += ' [level=' + level + ']';
  }
  if (tag === 'a' && el.hasAttribute('href')) {
    try {
      const href = new URL(el.href, location.href);
      let destination = href.origin === location.origin
        ? href.pathname + href.search + href.hash
        : href.href;
      if (destination.length > MAX_HREF) {
        destination = destination.slice(0, MAX_HREF - 1) + '…';
      }
      line += ' href=' + JSON.stringify(destination);
    } catch {}
  }
  if (
    ((tag === 'input' || tag === 'textarea') &&
      fieldValueIsSafeToShow(el, fieldValueSensitive)) ||
    tag === 'select'
  ) {
    let value = String(el.value || '');
    if (value.length > MAX_NAME) value = value.slice(0, MAX_NAME - 1) + '…';
    if (value) line += ' value=' + JSON.stringify(value);
  }
  if (hint) line += ' ' + hint;
  // Annotate state agents need for their next decision.
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' (disabled)';
  if (el.checked || el.getAttribute('aria-checked') === 'true') line += ' (checked)';
  if (el.selected || el.getAttribute('aria-selected') === 'true') line += ' (selected)';
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true' || expanded === 'false') line += ' (expanded=' + expanded + ')';
  const pressed = el.getAttribute('aria-pressed');
  if (pressed === 'true' || pressed === 'false' || pressed === 'mixed') line += ' (pressed=' + pressed + ')';
  const current = el.getAttribute('aria-current');
  if (current && current !== 'false') line += ' (current=' + current + ')';
  out.push(line);
  if (contentOnly) {
    if (evidenceText) evidenceTextCount += 1;
    else ordinaryTextCount += 1;
  } else semanticCount += 1;
}
function hasEvidenceIdentity(el) {
  const identity = [
    el.id,
    el.getAttribute('data-testid'),
    el.getAttribute('data-test-id'),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return /(^|[^a-z0-9])(status|result|message|error|success|log|notice|alert|feedback|confirmation)([^a-z0-9]|$)/.test(identity);
}
function fieldValueIsSafeToShow(el, sensitive) {
  const type = (el.type || '').toLowerCase();
  if (
    ['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image']
      .includes(type)
  ) return false;
  return !sensitive;
}
function fieldValueIsSensitive(el, accessibleName) {
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
  if (
    autocomplete.some((token) =>
      token === 'one-time-code' || token === 'current-password' ||
      token === 'new-password' || token.startsWith('cc-')
    )
  ) return true;
  const identity = [
    el.id,
    el.getAttribute('name'),
    el.getAttribute('placeholder'),
    el.getAttribute('aria-label'),
    accessibleName,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  // Best-effort only: reduce incidental capture of conventionally named
  // secret fields without claiming arbitrary page values can be classified.
  return /(^|[^a-z0-9])(password|passcode|otp|one[ _-]?time|token|secret|api[ _-]?key|access[ _-]?key|credit[ _-]?card|cc[ _-]?(number|no)|card[ _-]?(number|no)|cvv|cvc|security[ _-]?code)([^a-z0-9]|$)/.test(identity);
}
function visitContainer(container, depth) {
  const children = container && container.children ? Array.from(container.children) : [];
  for (let i = 0; i < children.length; i++) {
    if (
      semanticCount >= MAX_NODES &&
      evidenceTextCount >= MAX_EVIDENCE_TEXT_NODES &&
      ordinaryTextCount >= MAX_ORDINARY_TEXT_NODES
    ) break;
    visitElement(children[i], depth);
  }
}
function visitElement(el, depth) {
  if (!el || seen.has(el)) return;
  seen.add(el);
  const openRoot = el.shadowRoot || null;
  const listed = el.matches(sel) || openRoot;
  const role = listed ? displayRole(el) : '';
  const nestsChildren = listed && isStructuralRole(role);
  if (listed) emit(el, depth);
  if (openRoot) {
    if (semanticCount < MAX_NODES) {
      out.push('  '.repeat(depth + 1) + '#shadow-root (open)');
      semanticCount += 1;
    } else return;
    visitContainer(openRoot, depth + 2);
    return;
  }
  if (el.tagName === 'SLOT') {
    const assigned = el.assignedElements ? el.assignedElements({ flatten: true }) : [];
    if (assigned.length) {
      for (let i = 0; i < assigned.length; i++) {
        if (
          semanticCount >= MAX_NODES &&
          evidenceTextCount >= MAX_EVIDENCE_TEXT_NODES &&
          ordinaryTextCount >= MAX_ORDINARY_TEXT_NODES
        ) break;
        visitElement(assigned[i], depth);
      }
      return;
    }
  }
  // Preserve only useful semantic hierarchy. Arbitrary wrapper divs stay
  // flat, while controls under a form/search/navigation container are visibly
  // related to it and cannot be mistaken for the container itself.
  visitContainer(el, depth + (nestsChildren ? 1 : 0));
}
visitContainer(document, 0);
return {
  url: location.href,
  title: document.title,
  lines: out,
  refs: refs,
  documentId: reg.doc,
  nextRef: reg.next
};
`;
}
