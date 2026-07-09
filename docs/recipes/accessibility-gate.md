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

## Notes

- Use `check()` when violations should fail the test; use `audit()` to inspect or write a report.
- Scope with `locator(...)` / `find(...)` for dynamic UI such as dialogs, menus, and checkout panels.
- `minImpact` filters by severity so you can gate on `serious`/`critical` first and tighten later.

## Learn More

- [Accessibility](../accessibility.md)
- [Selectors](../selectors.md)
