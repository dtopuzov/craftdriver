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
import type { Browser } from '../lib/browser.js';
import { PAGE_SEMANTICS_JS } from './pageSemantics.js';

const MAX_NODES = 80;
const MAX_NAME = 80;
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
export async function takeSnapshot(
  browser: Browser,
  minRef = 0,
): Promise<SnapshotShape | null> {
  try {
    const page = await browser.activePage();
    const [url, title] = await Promise.all([
      page.url().catch(() => ''),
      page.title().catch(() => ''),
    ]);
    const raw = await page.evaluate(jsSnapshot(minRef));
    if (!raw || typeof raw !== 'object') return null;
    const shaped = raw as {
      lines?: unknown; documentId?: unknown; refs?: unknown; nextRef?: unknown;
    };
    return {
      url,
      title,
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
  expectedDocumentId: string | null,
): Promise<RefProbe> {
  if (!/^e\d+$/.test(ref)) return { status: 'unknown-ref', documentId: null };
  try {
    const page = await browser.activePage();
    const js = jsProbeRef(ref, expectedDocumentId);
    const raw = await page.evaluate(js);
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
    case 'no-snapshot': return 'no snapshot has been taken in this session yet';
    case 'no-registry': return 'the page has no ref registry (it navigated or was replaced)';
    case 'document-changed': return 'the page navigated or reloaded after the ref was issued';
    case 'unknown-ref': return 'the ref was never issued for the current document';
    case 'detached': return 'the element was removed from the document';
    case 'ambiguous': return 'the ref no longer identifies exactly one element';
    default: return 'the ref is no longer valid';
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
export function renderDelta(
  prev: SnapshotShape | null,
  next: SnapshotShape | null,
): string {
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

  /** Stamp a session-monotonic revision and make this the new baseline. */
  record(snap: SnapshotShape | null): SnapshotShape | null {
    if (!snap) return null;
    const stamped: SnapshotShape = { ...snap, revision: ++this.revision };
    this.baseline = stamped;
    this.highWater = Math.max(this.highWater, stamped.nextRef - 1);
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
 * JS executed in-page. Keep it self-contained — no closure capture.
 *
 * Strategy:
 * 1. Get or create the per-document ref registry.
 * 2. Walk the composed tree, entering open shadow roots and flattened slots.
 * 3. Skip nodes outside the viewport-ish bounds and zero-sized nodes.
 * 4. Reuse each node's existing ref, or issue the next unused one.
 * 5. Cap output at MAX_NODES so the snapshot stays bounded regardless
 *    of page complexity.
 */
function jsSnapshot(minRef: number): string {
  const floor = Number.isSafeInteger(minRef) && minRef >= 0 ? minRef : 0;
  return `
const MAX_NODES = ${MAX_NODES};
const MAX_NAME = ${MAX_NAME};
const MAX_REFS = ${MAX_REFS};
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
function visible(el) {
  if (!el || !el.getClientRects) return false;
  if (el.hidden) return false;
  const rects = el.getClientRects();
  if (!rects.length) return false;
  const r = rects[0];
  if (r.width === 0 || r.height === 0) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
  return true;
}
${PAGE_SEMANTICS_JS}
function locatorHint(el) {
  if (el.id) return '#' + el.id;
  const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
  if (testid) return '[data-testid=' + JSON.stringify(testid) + ']';
  const name = el.getAttribute('name');
  if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
  return null;
}
const reg = registry();
const sel = 'a,button,input,select,textarea,h1,h2,h3,h4,h5,h6,[role],nav,main,header,footer,form,img,label';
const out = [];
const refs = [];
const seen = new WeakSet();
function emit(el, depth) {
  if (out.length >= MAX_NODES || !visible(el)) return;
  // A <header>/<footer> inside sectioning content is not a landmark, and
  // listing it as a bare tag would be pure noise. Everything else keeps a
  // line even without an ARIA role, so controls stay addressable by ref.
  const tag = el.tagName.toLowerCase();
  if (!ariaRole(el) && (tag === 'header' || tag === 'footer')) return;
  const role = displayRole(el);
  let name = accName(el);
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME - 1) + '…';
  const hint = locatorHint(el);
  const ref = refFor(reg, el);
  refs.push(ref);
  let line = '  '.repeat(depth) + ref + ': ' + role;
  if (name) line += ' "' + name + '"';
  if (hint) line += ' ' + hint;
  // Annotate disabled/checked state, agents need it.
  if (el.disabled) line += ' (disabled)';
  if (el.checked) line += ' (checked)';
  out.push(line);
}
function visitContainer(container, depth) {
  const children = container && container.children ? Array.from(container.children) : [];
  for (let i = 0; i < children.length && out.length < MAX_NODES; i++) {
    visitElement(children[i], depth);
  }
}
function visitElement(el, depth) {
  if (!el || seen.has(el) || out.length >= MAX_NODES) return;
  seen.add(el);
  const openRoot = el.shadowRoot || null;
  if (el.matches(sel) || openRoot) emit(el, depth);
  if (openRoot) {
    if (out.length < MAX_NODES) out.push('  '.repeat(depth + 1) + '#shadow-root (open)');
    visitContainer(openRoot, depth + 2);
    return;
  }
  if (el.tagName === 'SLOT') {
    const assigned = el.assignedElements ? el.assignedElements({ flatten: true }) : [];
    if (assigned.length) {
      for (let i = 0; i < assigned.length && out.length < MAX_NODES; i++) {
        visitElement(assigned[i], depth);
      }
      return;
    }
  }
  visitContainer(el, depth);
}
visitContainer(document, 0);
return { lines: out, refs: refs, documentId: reg.doc, nextRef: reg.next };
`;
}
