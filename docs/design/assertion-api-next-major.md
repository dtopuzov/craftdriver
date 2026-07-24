# Assertion API candidate for the next major release

Status: design note only. This does not describe the current public API and is
not a release commitment.

The next breaking release is an opportunity to reconsider locator cardinality
across the complete locator API.

## Require explicit cardinality for element operations

Operations that inspect or interact with one element could require exactly one
match:

- zero matches: keep waiting until the operation timeout;
- one match: perform the operation;
- more than one match: fail with a clear strict-cardinality error.

Callers that intentionally want one element from a collection would make that
choice explicit:

```typescript
await browser.locator('.result').first().expect().toHaveText('First');
await browser.locator('.result').nth(2).expect().toBeVisible();
```

Collection operations such as `count()` and `toHaveCount()` would continue to
evaluate every match. This would replace the current implicit first-match
behavior and must be designed consistently for assertions, actions, state
queries, and element reads rather than changing assertions alone.

## Migration considerations

- Point multi-match callers to `first()`, `last()`, or `nth()` before upgrading.
- Add conformance tests for every single-element locator operation.
- Keep collection operations explicitly non-strict.
