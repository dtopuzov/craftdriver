import { describe, it, expect } from 'vitest';
import { By, CraftdriverError, ErrorCode } from '../src';

// Pure-logic coverage: By text/name locators compile to XPath string literals,
// which have no regular-expression operator. A RegExp (the common mistake, since
// Playwright supports `{ name: /re/ }`) must fail early at the public entry point
// with a stable code and a real fix — not crash deep in the literal builder.
describe('By text/name validation', () => {
  const regex = /count is/i;
  const asString = (v: unknown) => v as unknown as string;

  it('By.role({ name: RegExp }) throws INVALID_ARGUMENT with a helpful hint', () => {
    let err: unknown;
    try {
      By.role('button', { name: asString(regex) });
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.INVALID_ARGUMENT)).toBe(true);
    const ce = err as CraftdriverError;
    expect(ce.message).toContain('By.role name must be a string');
    expect(ce.message).toContain('RegExp');
    expect(ce.hint).toMatch(/exact: false/);
    expect(ce.hint).toMatch(/data-testid/);
  });

  it('rejects a RegExp across the whole text/label family', () => {
    const builders: Array<[string, () => unknown]> = [
      ['By.text', () => By.text(asString(regex))],
      ['By.partialText', () => By.partialText(asString(regex))],
      ['By.labelText', () => By.labelText(asString(regex))],
      ['By.placeholder', () => By.placeholder(asString(regex))],
      ['By.altText', () => By.altText(asString(regex))],
      ['By.title', () => By.title(asString(regex))],
    ];
    for (const [label, build] of builders) {
      let err: unknown;
      try {
        build();
      } catch (e) {
        err = e;
      }
      expect(CraftdriverError.is(err, ErrorCode.INVALID_ARGUMENT), `${label} should throw`).toBe(
        true
      );
    }
  });

  it('reports the received type for non-RegExp misuse', () => {
    expect(() => By.role('button', { name: asString(42) })).toThrowError(/received a number/);
    expect(() => By.text(asString(null))).toThrowError(/received null/);
  });

  it('rejects falsy non-string role names instead of silently dropping the filter', () => {
    // `if (opts.name)` truthiness used to skip these, producing a role-only
    // locator with no error — the same crash class this fix closes elsewhere.
    for (const bad of [null, false, 0, NaN]) {
      let err: unknown;
      try {
        By.role('button', { name: asString(bad) });
      } catch (e) {
        err = e;
      }
      expect(CraftdriverError.is(err, ErrorCode.INVALID_ARGUMENT), String(bad)).toBe(true);
    }
  });

  it('treats an empty-string role name as "no name filter", not an empty-name match', () => {
    const roleOnly = By.role('button', { name: '' });
    expect(roleOnly.using).toBe('xpath');
    // No accessible-name predicate is emitted for an empty name.
    expect(roleOnly.value).not.toContain('@aria-label');
    // Same shape as passing no name at all.
    expect(roleOnly.value).toBe(By.role('button').value);
  });

  it('still builds XPath for valid string names, incl. substring matching', () => {
    const exact = By.role('button', { name: 'Count is 0' });
    expect(exact.using).toBe('xpath');
    expect(exact.value).toContain('Count is 0');

    // Substring matching is the supported way to do fuzzy name matching.
    const substring = By.role('button', { name: 'Count is', exact: false });
    expect(substring.value).toContain('contains(');
  });
});
