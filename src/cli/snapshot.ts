/**
 * Compact a11y snapshot generation + per-session diffing.
 *
 * Why this exists: the MCP spec (§6 of the AI-productivity plan) says
 * "a11y snapshot is the default, not a screenshot." Screenshots cost
 * 800–1500 image tokens; a flat list of visible interactive elements
 * (role + accessible name + selector hint) is ~50–500 text tokens and
 * far more useful for a text model writing the next selector.
 *
 * Snapshot algorithm runs entirely in the page via `page.evaluate`:
 * pick interactive elements + headings + landmarks, compute an
 * accessible name, skip the invisible, cap at `MAX_NODES`. The
 * output is a single string with one node per line. Diffing is just
 * a flat line-by-line compare.
 */
import type { Browser } from '../lib/browser.js';

const MAX_NODES = 80;
const MAX_NAME = 80;

export interface SnapshotShape {
  url: string;
  title: string;
  /** One line per visible interactive node, prefixed with `eN: `. */
  lines: string[];
}

/**
 * Build a fresh snapshot of the active page. Errors swallowed so a
 * partial post-action payload never breaks the protocol.
 */
export async function takeSnapshot(browser: Browser): Promise<SnapshotShape | null> {
  try {
    const page = await browser.activePage();
    const [url, title] = await Promise.all([
      page.url().catch(() => ''),
      page.title().catch(() => ''),
    ]);
    const lines = await page.evaluate(JS_SNAPSHOT);
    return { url, title, lines: Array.isArray(lines) ? (lines as string[]) : [] };
  } catch {
    return null;
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
 * Ref numbers (`e1`, `e2`, …) re-allocate on every snapshot so they
 * can't be used to drive the diff directly — we strip them before
 * the set-difference and re-attach them when rendering, so the diff
 * stays semantically stable across renumberings.
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
  if (prev.url !== next.url) {
    // Page changed — full snapshot.
    return `${header}\n${next.lines.join('\n')}`;
  }
  const strip = (l: string): string => l.replace(/^e\d+:\s*/, '');
  const prevBodies = new Set(prev.lines.map(strip));
  const nextBodies = new Set(next.lines.map(strip));
  const removed = prev.lines.filter((l) => !nextBodies.has(strip(l))).map((l) => `- ${l}`);
  const added = next.lines.filter((l) => !prevBodies.has(strip(l))).map((l) => `+ ${l}`);
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
 * JS executed in-page. Keep it self-contained — no closure capture.
 *
 * Strategy:
 * 1. Walk a curated set of selectors (interactive + structural).
 * 2. Skip nodes outside the viewport-ish bounds and zero-sized nodes.
 * 3. For each, compute role + accessible name + a stable selector hint
 *    (prefer #id, then [data-testid], then [name], then tag+text).
 * 4. Cap output at MAX_NODES so the snapshot stays bounded regardless
 *    of page complexity.
 */
const JS_SNAPSHOT = `
const MAX_NODES = ${MAX_NODES};
const MAX_NAME = ${MAX_NAME};
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
function impliedRole(el) {
  const t = el.tagName.toLowerCase();
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  if (t === 'a' && el.hasAttribute('href')) return 'link';
  if (t === 'button') return 'button';
  if (t === 'input') {
    const it = (el.getAttribute('type') || 'text').toLowerCase();
    if (it === 'submit' || it === 'button' || it === 'reset') return 'button';
    if (it === 'checkbox') return 'checkbox';
    if (it === 'radio') return 'radio';
    return 'textbox';
  }
  if (t === 'textarea') return 'textbox';
  if (t === 'select') return 'combobox';
  if (/^h[1-6]$/.test(t)) return 'heading';
  if (t === 'nav') return 'navigation';
  if (t === 'main') return 'main';
  if (t === 'header') return 'banner';
  if (t === 'footer') return 'contentinfo';
  if (t === 'form') return 'form';
  if (t === 'img') return 'img';
  return t;
}
function accName(el) {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const ref = document.getElementById(labelledby);
    if (ref) return (ref.textContent || '').trim();
  }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    if (el.id) {
      const lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']');
      if (lbl) return (lbl.textContent || '').trim();
    }
    const parentLabel = el.closest('label');
    if (parentLabel) return (parentLabel.textContent || '').trim();
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
  }
  if (el.tagName === 'IMG') {
    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();
  }
  const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
  return text;
}
function locatorHint(el) {
  if (el.id) return '#' + el.id;
  const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
  if (testid) return '[data-testid=' + JSON.stringify(testid) + ']';
  const name = el.getAttribute('name');
  if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
  return null;
}
const sel = 'a,button,input,select,textarea,h1,h2,h3,h4,h5,h6,[role],nav,main,header,footer,form,img,label';
// Wipe stale refs from a previous snapshot so numbering is deterministic.
const stale = document.querySelectorAll('[data-craftdriver-ref]');
for (let i = 0; i < stale.length; i++) stale[i].removeAttribute('data-craftdriver-ref');
const out = [];
const nodes = document.querySelectorAll(sel);
for (let i = 0; i < nodes.length && out.length < MAX_NODES; i++) {
  const el = nodes[i];
  if (!visible(el)) continue;
  const role = impliedRole(el);
  let name = accName(el);
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME - 1) + '…';
  const hint = locatorHint(el);
  const ref = 'e' + (out.length + 1);
  el.setAttribute('data-craftdriver-ref', ref);
  let line = ref + ': ' + role;
  if (name) line += ' "' + name + '"';
  if (hint) line += ' ' + hint;
  // Annotate disabled/checked state, agents need it.
  if (el.disabled) line += ' (disabled)';
  if (el.checked) line += ' (checked)';
  out.push(line);
}
return out;
`;
