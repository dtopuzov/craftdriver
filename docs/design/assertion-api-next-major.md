# Assertion API candidates for the next major release

Status: design note only. This does not describe the current public API and is
not a release commitment.

PR #50 deliberately preserves existing assertion behavior. The next breaking
release is an opportunity to make locator cardinality and missing-element
semantics more uniform, even where that changes existing tests.

## Recommended changes

### Require explicit cardinality for element assertions

Matchers that inspect an element should require exactly one match:

- zero matches: keep waiting until the assertion timeout;
- one match: evaluate the matcher;
- more than one match: fail with a clear strict-cardinality error.

Callers that intentionally want one element from a collection would make that
choice explicit:

```typescript
await browser.locator('.result').first().expect().toHaveText('First');
await browser.locator('.result').nth(2).expect().toBeVisible();
```

Collection matchers such as `toHaveCount()` would continue to evaluate every
match. This replaces the current implicit first-match behavior and would be a
breaking change.

### Normalize missing-element behavior

All value and state assertions should require a resolved element, including
their negated forms:

- text and contained text;
- input value;
- attributes and classes;
- CSS;
- enabled, disabled, checked, and focused state;
- viewport intersection.

For example, a missing locator would no longer satisfy
`not.toHaveText('Error')` or `not.toHaveAttribute('disabled')`. This prevents a
misspelled selector from turning a negative assertion into a false success.

Visibility should remain the deliberate exception. Add `toBeHidden()` with the
explicit meaning “missing or not displayed,” and define `not.toBeVisible()` as
the same condition. Element removal itself should remain explicit through
`toHaveCount(0)` or `waitFor({ state: 'detached' })`; an attachment assertion
alias is still unnecessary.

### Preserve matcher-specific negation

`.not` should reverse the matcher condition, not globally redefine locator
resolution:

| Matcher category | Proposed missing-target behavior |
| --- | --- |
| Element value/state/geometry | Retry, then fail |
| `toBeVisible()` negation / `toBeHidden()` | Pass |
| Collection count | Evaluate the count as zero |
| Page URL/title | Evaluate the current page value |

This rule should live in the public assertion documentation and shared polling
implementation so new matchers cannot accidentally choose different semantics.

### Preserve terminal errors during polling

Assertion polling should retry only conditions that can reasonably recover,
such as a missing or stale element during rerendering. Invalid selectors,
unsupported browser features, closed pages, and driver/transport failures
should retain their original error code instead of becoming a later generic
assertion mismatch.

## Migration considerations

- Announce that negative text/value/attribute/class assertions no longer pass
  for missing locators.
- Recommend `toHaveCount(0)` for absence and `toBeHidden()` for the combined
  “absent or hidden” case.
- Point multi-match callers to `first()`, `last()`, or `nth()` before upgrading.
- Add conformance tests covering every matcher category and missing-target
  behavior before releasing the major version.
