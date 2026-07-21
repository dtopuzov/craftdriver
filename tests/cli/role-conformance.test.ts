/**
 * Conformance between the three implementations of role/name semantics.
 *
 * The snapshot tells an agent what an element is, the locator builder turns
 * that into a selector for a committed test, and `By.role` is what actually
 * resolves the selector at runtime. Those were three separate mappings and
 * they had drifted: a `<select multiple>` was `listbox` in the snapshot and
 * `combobox` to the locator builder, so the correct role locator was never
 * proposed and a brittle `text=RedBlue` was recommended instead.
 *
 * The contract pinned here: every role the shared extractor can emit resolves
 * through `By.role` back to the element it was read from. `locatorCandidates`
 * reports `unique` only when a candidate matches exactly one element *and*
 * that element is the probed one, so a `unique` role candidate is end-to-end
 * proof rather than a string comparison.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Browser } from '../../src/lib/browser';
import { By } from '../../src/lib/by';
import { takeSnapshot } from '../../src/cli/snapshot';
import { locatorCandidates } from '../../src/cli/locatorCandidates';
import { EMITTABLE_ROLES } from '../../src/cli/pageSemantics';
import { BROWSER_NAME } from '../utils';

/**
 * One element per emittable role, each with a name unique across the page so
 * "resolved uniquely" is a meaningful assertion. Structural elements get an
 * explicit `aria-label` because their text content is their children's.
 *
 * `<header>`/`<footer>` sit at body level on purpose: nested in sectioning
 * content they are not landmarks, which the last case below covers.
 */
const FIXTURE = `<!doctype html>
<a id="r-link" href="#x">Link Name</a>
<button id="r-button">Button Name</button>
<input id="r-checkbox" type="checkbox" aria-label="Check Name" />
<input id="r-radio" type="radio" aria-label="Radio Name" />
<input id="r-searchbox" type="search" aria-label="Search Name" />
<input id="r-spinbutton" type="number" aria-label="Number Name" />
<input id="r-slider" type="range" aria-label="Slider Name" />
<input id="r-textbox" type="text" aria-label="Text Name" />
<input id="r-image" type="image" alt="Image Button Name" />
<input id="r-password" type="password" aria-label="Password Name" />
<textarea id="r-textarea" aria-label="Textarea Name"></textarea>
<select id="r-listbox" multiple aria-label="Colors">
  <option>Red</option><option>Blue</option>
</select>
<select id="r-combobox" aria-label="Single Pick"><option>One</option></select>
<h2 id="r-heading">Heading Name</h2>
<img id="r-img" alt="Logo Name" />
<ul id="r-list" aria-label="List Name"><li id="r-listitem" aria-label="Item Name">x</li></ul>
<table id="r-table" aria-label="Table Name">
  <tr id="r-row" aria-label="Row Name">
    <th id="r-columnheader" aria-label="Header Name">H</th>
    <td id="r-cell" aria-label="Cell Name">C</td>
  </tr>
</table>
<nav id="r-navigation" aria-label="Nav Name"></nav>
<main id="r-main" aria-label="Main Name"></main>
<article id="r-article" aria-label="Article Name"></article>
<form id="r-form" aria-label="Form Name"></form>
<header id="r-banner" aria-label="Banner Name"></header>
<footer id="r-contentinfo" aria-label="Footer Name"></footer>
<section><header id="r-nested-header" aria-label="Nested Header">h</header></section>
<input id="r-hidden" type="text" aria-label="Hidden Name" hidden />
`;

/** `eN: role "name" hint` -> [role, name] for lines that carry a name. */
function rolesAndNames(lines: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of lines) {
    const m = /^e\d+:\s*(\S+)\s+"([^"]*)"/.exec(line.trim());
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

describe('role/name conformance across snapshot, locators and By.role', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    await browser.setContent(FIXTURE);
  });

  afterAll(async () => {
    await browser.quit();
  });

  // The matrix. A new branch in `ariaRole` without a By.role counterpart
  // fails here rather than shipping an unresolvable recommendation.
  for (const role of EMITTABLE_ROLES) {
    it(`proposes and resolves role=${role}`, async () => {
      const report = await locatorCandidates(browser, By.css(`#r-${role}`), 5);
      const roleCandidate = report.candidates.find((c) => c.kind === 'role');

      expect(roleCandidate, `no role candidate proposed for ${role}`).toBeDefined();
      expect(roleCandidate!.selector).toMatch(new RegExp(`^role=${role}\\[name=`));
      // `unique` means By.role resolved it to exactly one element, and that
      // element is the one the candidate was read from.
      expect(roleCandidate!.status, `role=${role} did not resolve uniquely`).toBe('unique');
    });
  }

  it('recommends the role locator for a multi-select, not its option text', async () => {
    const report = await locatorCandidates(browser, By.css('#r-listbox'), 5);

    // The regression in full: listbox is what the snapshot says, so listbox is
    // what must be recommended. `text=RedBlue` is the concatenated option text
    // and breaks the moment a colour is added.
    expect(report.best).toBe('role=listbox[name=Colors]');
    expect(report.best).not.toMatch(/^text=/);
  });

  it('agrees with the snapshot on every role and name it reports', async () => {
    const snap = await takeSnapshot(browser, 0);
    const pairs = rolesAndNames(snap.lines);
    expect(pairs.length).toBeGreaterThan(10);

    for (const [role, name] of pairs) {
      // Tag-name fallbacks (password inputs, labels) are not ARIA roles and
      // are deliberately never proposed as role locators.
      if (!(EMITTABLE_ROLES as readonly string[]).includes(role)) continue;
      const found = await browser.findAll(By.role(role, { name }));
      expect(found.length, `snapshot reported ${role} "${name}" but By.role found none`)
        .toBeGreaterThan(0);
    }
  });

  it('reports a search input as searchbox in both surfaces', async () => {
    const snap = await takeSnapshot(browser, 0);
    expect(snap.lines.some((l) => /searchbox "Search Name"/.test(l))).toBe(true);

    const report = await locatorCandidates(browser, By.css('#r-searchbox'), 5);
    expect(report.best).toBe('role=searchbox[name=Search Name]');
  });

  it('reports an image input as a button, not a textbox', async () => {
    const report = await locatorCandidates(browser, By.css('#r-image'), 5);
    expect(report.best).toBe('role=button[name=Image Button Name]');
  });

  it('offers no role candidate for an element with no ARIA role', async () => {
    // <input type="password"> has no corresponding role. Claiming `textbox`
    // would produce a locator that resolves to nothing; the label candidate
    // is the honest answer.
    const report = await locatorCandidates(browser, By.css('#r-password'), 5);
    expect(report.candidates.find((c) => c.kind === 'role')).toBeUndefined();
  });

  it('keeps a password input addressable in the snapshot', async () => {
    // No ARIA role must not mean invisible to the agent.
    const snap = await takeSnapshot(browser, 0);
    expect(snap.lines.some((l) => /"Password Name"/.test(l))).toBe(true);
  });

  it('omits a header nested in sectioning content from the snapshot', async () => {
    const snap = await takeSnapshot(browser, 0);
    expect(snap.lines.some((l) => /Nested Header/.test(l))).toBe(false);
  });

  it('omits hidden elements from the snapshot', async () => {
    const snap = await takeSnapshot(browser, 0);
    expect(snap.lines.some((l) => /Hidden Name/.test(l))).toBe(false);
  });
});
