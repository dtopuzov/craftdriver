# Accessibility audits

`craftdriver` wraps [axe-core](https://github.com/dequelabs/axe-core) so
you can assert WCAG compliance with the same fluency as any other
action — at the page, element, or locator level.

axe-core ships with craftdriver — no extra install. Works out of the box.

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });
await browser.navigateTo('https://example.com');

await browser.a11y.check();         // throws on any serious+ violation
const report = await browser.a11y.audit(); // returns the raw report
console.log(report.violations);
await browser.quit();
```

Check a page is clean except for known colour-contrast issues:

```ts
await browser.a11y.check({ disableRules: ['color-contrast'] });
```

## Finding rule IDs

Rule IDs like `color-contrast`, `image-alt`, `button-name` come from
axe-core. Look them up here:

- [Deque — full rule catalogue](https://dequeuniversity.com/rules/axe/) — the
  authoritative list, with WCAG mapping and remediation guidance per rule.
- [axe-core rule descriptions](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md) —
  one-line summary per rule, grouped by WCAG level.
- Every `A11yViolation` returned by `audit()` carries a `helpUrl` pointing
  straight at the relevant Deque page — copy the rule ID from there.

## Ignoring rules (you will have violations — this is how you manage them)

Most production pages have known, deliberate axe-core violations:
third-party widgets with poor contrast, brand colours that miss AAA,
decorative images without alt. Three escalating shapes are supported,
in order of how often you'll reach for them.

### 1. The common case — a project-wide constant

```ts
// a11y-config.ts
export const PROJECT_A11Y = {
  disableRules: ['color-contrast', 'region', 'landmark-one-main'],
};

// in your test
import { PROJECT_A11Y } from './a11y-config';
await browser.a11y.check(PROJECT_A11Y);
```

A flat `string[]` of rule IDs is what teams actually maintain in
version control.

### 2. Per-test override — extend the constant ad-hoc

```ts
await browser.a11y.check({
  ...PROJECT_A11Y,
  disableRules: [...PROJECT_A11Y.disableRules, 'aria-allowed-attr'],
});
```

Plain object spread — no hidden state, no setter.

### 3. Escape hatch — raw axe-core options

```ts
await browser.a11y.check({
  axeOptions: { rules: { 'color-contrast': { enabled: false } } },
});
```

`axeOptions` is merged last and wins over anything else. Use it when
you need exotic axe configuration (custom rule sets, locale, etc.).

## Filtering by impact

Default reports only include `serious` and `critical` violations.
Tune the threshold per call:

```ts
// CI gate: only fail PRs on critical issues
await browser.a11y.check({ minImpact: 'critical' });

// Debug everything
const report = await browser.a11y.audit({ minImpact: 'minor' });
```

## Scoping to an element

Both `ElementHandle` and `Locator` expose `.a11y`. The audit context
is restricted to the resolved element and its descendants — perfect
for asserting that *the modal you just opened* is clean even if the
rest of the page has known issues.

```ts
await browser.click('#open-settings');
await browser.find('#settings-modal').a11y.check({
  disableRules: ['color-contrast'], // brand teal misses AA, known
});

// Locator form — re-resolves on every call
const dialog = browser.locator('[role="dialog"]');
const report = await dialog.a11y.audit();
expect(report.violations).toHaveLength(0);
```

## Inspecting violations programmatically

`audit()` returns:

```ts
interface A11yResult {
  violations: A11yViolation[];
  passes: number;        // count, not the full list
  incomplete: number;
  inapplicable: number;
}

interface A11yViolation {
  id: string;            // e.g. 'color-contrast'
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  description: string;
  helpUrl: string;
  nodes: Array<{
    // A nested string[] is axe's selector path through open shadow roots.
    target: Array<string | [string, string, ...string[]]>;
    html: string;
    failureSummary: string;
  }>;
}
```

`check()` throws an `A11yError` whose `.violations` and `.result`
fields carry the full report:

```ts
import { A11yError } from 'craftdriver';

try {
  await browser.a11y.check();
} catch (e) {
  if (e instanceof A11yError) {
    for (const v of e.violations) {
      console.error(`${v.id} (${v.impact}) — ${v.helpUrl}`);
    }
  }
  throw e;
}
```

## CI patterns

Save the full report as a build artefact and gate PRs on
critical/serious only:

```ts
import { writeFileSync } from 'node:fs';

const report = await browser.a11y.audit({ minImpact: 'minor' });
writeFileSync('a11y-report.json', JSON.stringify(report, null, 2));

// Gate the run on the serious+ subset
await browser.a11y.check({ minImpact: 'serious', ...PROJECT_A11Y });
```

## How it works (one paragraph)

On the first audit, `axe-core` is lazily imported from your
`node_modules` and its `.source` is injected into the page (guarded by
a `window` flag so subsequent audits in the same document skip the
inject step). The audit itself uses Classic WebDriver
`execute/async` so the underlying `axe.run()` promise is awaited
before the result is shipped back — works with or without BiDi.
axe-core traverses open Shadow DOM itself. CraftDriver preserves axe's nested
cross-tree selector paths in `node.target`; closed roots remain outside the
audit, matching axe-core's support boundary.
