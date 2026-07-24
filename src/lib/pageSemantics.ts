/**
 * Page-side role and accessible-name extraction, shared by the snapshot and
 * the locator-candidate builder.
 *
 * These two surfaces must agree, and both must agree with `By.role` — that is
 * the whole point of the module. The snapshot tells an agent an element is a
 * `listbox`; the candidate builder proposes `role=listbox[name=Colors]`; and
 * `By.role('listbox', { name: 'Colors' })` has to actually resolve it in the
 * committed test. When those three drifted apart, the recommended locator for
 * a multi-select was a brittle `text=RedBlue`.
 *
 * So the mapping lives here once, `src/lib/by.ts` stays the resolution
 * authority, and `tests/cli/role-conformance.test.ts` pins the agreement
 * against a real browser.
 *
 * Emitted as JS **source text**: both callers assemble a body for
 * `page.evaluate`, and the build has no DOM lib. Keep it dependency-free and
 * side-effect-free — it is concatenated into larger scripts.
 *
 * ## The ARIA role / display token split
 *
 * `ariaRole` returns a real ARIA role or `null`. `null` is not a failure: an
 * `<input type="password">` genuinely has no ARIA role, and pretending it is a
 * `textbox` produces a `role=textbox[name=Password]` that resolves to nothing.
 * The snapshot falls back to `displayRole` (the tag name) so the element still
 * appears, while the candidate builder proposes a role locator only when
 * `ariaRole` is non-null. Honest over convenient.
 */

/**
 * Function declarations injected into a page-side script.
 *
 * Provides `firstRoleToken`, `hasSectioningAncestor`, `ariaRole`,
 * `displayRole`, `associatedLabel` and `accName`.
 */
export const PAGE_SEMANTICS_JS = `
function firstRoleToken(el) {
  const role = (el.getAttribute('role') || '').trim();
  return role ? role.split(/\\s+/)[0] : null;
}
// Mirrors HAS_SECTIONING_ANCESTOR in src/lib/by.ts: header/footer are only
// banner/contentinfo when not nested in sectioning content.
function hasSectioningAncestor(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const t = p.tagName.toLowerCase();
    if (t === 'article' || t === 'aside' || t === 'main' || t === 'nav' || t === 'section') {
      return true;
    }
    const role = firstRoleToken(p);
    if (
      role === 'article' ||
      role === 'complementary' ||
      role === 'main' ||
      role === 'navigation' ||
      role === 'region'
    ) {
      return true;
    }
  }
  return false;
}
// The ARIA role, or null when the element has none that By.role can resolve.
// Every branch here must have a counterpart in IMPLICIT_ROLE_XPATH.
function ariaRole(el) {
  const explicit = firstRoleToken(el);
  if (explicit) return explicit;
  const t = el.tagName.toLowerCase();
  if (t === 'a' || t === 'area') return el.hasAttribute('href') ? 'link' : null;
  if (t === 'button' || t === 'summary') return 'button';
  if (t === 'input') {
    const it = (el.getAttribute('type') || 'text').toLowerCase();
    if (it === 'submit' || it === 'button' || it === 'reset' || it === 'image') return 'button';
    if (it === 'checkbox') return 'checkbox';
    if (it === 'radio') return 'radio';
    if (it === 'search') return 'searchbox';
    if (it === 'number') return 'spinbutton';
    if (it === 'range') return 'slider';
    if (it === 'text' || it === 'email' || it === 'tel' || it === 'url') return 'textbox';
    // password, date, file, color, hidden… have no corresponding ARIA role.
    return el.hasAttribute('type') ? null : 'textbox';
  }
  if (t === 'textarea') return 'textbox';
  // multiple/size are reflected IDL attributes, so reading the properties
  // stays equivalent to the attribute test By.role compiles to XPath.
  if (t === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
  if (/^h[1-6]$/.test(t)) return 'heading';
  if (t === 'img') return 'img';
  if (t === 'ul' || t === 'ol') return 'list';
  if (t === 'li') return 'listitem';
  if (t === 'table') return 'table';
  if (t === 'tr') return 'row';
  if (t === 'td') return 'cell';
  if (t === 'th') return 'columnheader';
  if (t === 'nav') return 'navigation';
  if (t === 'main') return 'main';
  if (t === 'article') return 'article';
  if (t === 'form') return 'form';
  if (t === 'header') return hasSectioningAncestor(el) ? null : 'banner';
  if (t === 'footer') return hasSectioningAncestor(el) ? null : 'contentinfo';
  return null;
}
// What the snapshot prints. Falls back to the tag name so an element with no
// ARIA role is still listed and still addressable by ref.
function displayRole(el) {
  return ariaRole(el) || el.tagName.toLowerCase();
}
function semanticRoot(el) {
  const root = el && el.getRootNode ? el.getRootNode() : null;
  return root && typeof root.querySelectorAll === 'function' ? root : document;
}
function elementByIdInRoot(root, id) {
  if (!id) return null;
  if (typeof root.getElementById === 'function') return root.getElementById(id);
  const nodes = root.querySelectorAll('[id]');
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) return nodes[i];
  }
  return null;
}
// The <label> a user reads for a form control, independent of accName —
// By.labelText resolves against exactly this.
function associatedLabel(el) {
  const t = el.tagName;
  if (t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') return null;
  if (el.labels && el.labels.length) {
    const nativeLabel = el.labels[0];
    return (nativeLabel.textContent || '').trim() || null;
  }
  if (el.id) {
    const root = semanticRoot(el);
    const labels = root.querySelectorAll('label[for]');
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].getAttribute('for') === el.id) {
        return (labels[i].textContent || '').trim() || null;
      }
    }
  }
  const parentLabel = el.closest('label');
  if (parentLabel) return (parentLabel.textContent || '').trim() || null;
  return null;
}
// Approximates the accessible name, in the same source order By.role's name
// predicate checks. Sources By.role cannot match must not appear here.
function accName(el) {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    // Single id only — By.role's @aria-labelledby test is an equality match.
    const ref = elementByIdInRoot(semanticRoot(el), labelledby);
    if (ref) {
      const t = (ref.textContent || '').trim();
      if (t) return t;
    }
  }
  const label = associatedLabel(el);
  if (label) return label;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const it = (el.getAttribute('type') || 'text').toLowerCase();
    // Native buttons carry their name in value=, not in text content.
    if (it === 'submit' || it === 'button' || it === 'reset') {
      const v = el.getAttribute('value');
      if (v && v.trim()) return v.trim();
    }
    if (it === 'image') {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) return alt.trim();
    }
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
  }
  if (tag === 'IMG') {
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
  }
  const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
  if (text) return text;
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim();
  return '';
}
`;

/**
 * Every role `ariaRole` can emit for a native element. The conformance test
 * walks this list, so a new branch above without a `By.role` counterpart
 * fails CI rather than shipping an unresolvable recommendation.
 */
export const EMITTABLE_ROLES = [
  'link',
  'button',
  'checkbox',
  'radio',
  'searchbox',
  'spinbutton',
  'slider',
  'textbox',
  'listbox',
  'combobox',
  'heading',
  'img',
  'list',
  'listitem',
  'table',
  'row',
  'cell',
  'columnheader',
  'navigation',
  'main',
  'article',
  'form',
  'banner',
  'contentinfo',
] as const;
