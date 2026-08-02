# Accessibility audits

`craftdriver` wraps [axe-core](https://github.com/dequelabs/axe-core) so
you can assert WCAG compliance with the same fluency as any other
action — at the page, element, or locator level.

axe-core ships with craftdriver — no extra install. Works out of the box.

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });
await browser.navigateTo('https://example.com');

await browser.a11y.check();         // throws on any violation (minor+ by default)
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

The default `minor` threshold includes every axe violation. Raise it when a
project deliberately gates only higher-impact findings:

```ts
// CI gate: only fail PRs on critical issues
await browser.a11y.check({ minImpact: 'critical' });

// Report serious and critical findings only
const report = await browser.a11y.audit({ minImpact: 'serious' });
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
  description: string;   // the long gloss
  help: string;          // the one-line imperative: 'Images must have alternative text'
  tags: string[];        // axe's own tags — see below
  helpUrl: string;
  nodes: Array<{
    // A nested string[] is axe's selector path through open shadow roots.
    target: Array<string | [string, string, ...string[]]>;
    html: string;
    failureSummary: string;
  }>;
}
```

`tags` is axe's raw tag list, not a craftdriver invention — it mixes
conformance levels (`wcag2a`, `wcag21aa`), success criteria (`wcag111` is
1.1.1, `wcag2410` is 2.4.10) and categories (`cat.forms`). Filter for the
prefix you care about:

```ts
const criteria = violation.tags.filter((t) => /^wcag\d\d\d+$/.test(t));
```

There is deliberately no craftdriver severity scale on top of it: axe's four
impacts and its own tags are the model, and re-encoding them here would just be
a second thing to keep in step with axe's rule catalogue.

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

## From the CLI or an agent

The API above is for *gating* — a check in a suite that fails a build. The
counterpart is *fixing*, and that does not want a test file written first:

```bash
craftdriver a11y                 # whole page
craftdriver a11y '#settings'     # one region
```

Same axe-core, same four impacts, same rule IDs. The one thing the CLI adds is
that a violation can be acted on: every reported node carries a snapshot `ref`,
so it feeds straight into `craftdriver locators ref=eN` and comes back as a
durable selector for the source fix. axe's own `target` is a CSS path
(`div > p:nth-child(3)`) — a position, not a handle — which is why the audit
issues refs of its own rather than passing axe's string along.

```bash
craftdriver a11y                       # → ref=e14 on the offending <img>
craftdriver locators ref=e14           # → #no-alt
#   … add alt="…" in the source, reload …
craftdriver a11y --check               # exits 1 while it is still broken
```

`--check` mirrors the API distinction between `audit()` and `check()`: without
it the command reports findings and exits 0; with it the same findings produce
an explicit pass/fail verdict and exit 1 when any are present. `--min-impact`
is the single threshold for both modes. `--rules` and `--disable-rules` map
across too. Output is bounded by `--limit` and `--nodes` and says so with
`truncated`.

Refs are live-session handles. They mean nothing in the next session, so
**never put one in committed source** — that is what `locators` is for. Full
flag reference and the two known gaps (shadow-boundary locators, iframes) are
in [cli.md](./cli.md#accessibility-audit-then-fix); the equivalent MCP tool is
`browser_a11y`.

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
