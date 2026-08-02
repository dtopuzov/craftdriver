# Run Accessibility Gates

A page can look right and still be unusable with a screen reader. Wire an
accessibility check into CI and serious regressions fail the build instead of
shipping. `check()` throws an `A11yError` listing every violation and its help
URL; scope it to a component to gate exactly the region you care about. This
recipe checks a clean region of the live
[accessibility example](https://dtopuzov.github.io/craftdriver/examples/a11y.html).

```ts
await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/a11y.html');

// Passes silently when the region is clean; throws A11yError (with violations
// and help URLs) when it is not — so a regression fails the test.
await browser.locator('#good').a11y.check({ minImpact: 'serious' });
```

## Audit Without Failing

When you want to inspect or report violations instead of failing, use `audit()`
— it returns the report rather than throwing:

```ts
const report = await browser.a11y.audit({ minImpact: 'serious' });
console.log(`${report.violations.length} violation(s)`);
```

## Find And Fix Without Writing A Test

Gating tells you a build broke; it does not help you fix the page. For that,
run the audit from the command line — same axe-core, no test file:

```bash
craftdriver go https://dtopuzov.github.io/craftdriver/examples/a11y.html
craftdriver a11y
```

Each violation node comes back with a `ref=eN`. That ref is the point: axe
reports a CSS path like `div > p:nth-child(3)`, which says where the element
sat rather than which element it is. A ref goes straight into `locators`, which
hands back a selector durable enough to write the fix against:

```bash
craftdriver locators ref=e4            # → #no-alt
#   … add the missing alt text in the source, reload …
craftdriver a11y --check --min-impact serious  # exit 1 while it is still broken
```

`--check` is the only thing that makes findings exit non-zero, so the same
command reads as a report during the fix and as a gate in CI. `--min-impact`
is the one threshold in both modes. Never commit a ref — it is live-session
state, and `locators` exists to convert it.

## Notes

- Use `check()` when violations should fail the test; use `audit()` to inspect or write a report.
- Scope with `locator(...)` / `find(...)` for dynamic UI such as dialogs, menus, and checkout panels.
- `minImpact` filters by severity so you can gate on `serious`/`critical` first and tighten later.
- CLI `a11y` / `a11y --check` mirror library `audit()` / `check()`. They share
  rule IDs, impacts, and the `disableRules` list a team maintains.

## Learn More

- [Accessibility](../accessibility.md)
- [Selectors](../selectors.md)
