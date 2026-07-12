/**
 * Unit tests for matchPageFields — the pure predicate behind
 * browser.waitForPage({ url, title }). The end-to-end window selection is covered
 * by tests/electron/electron-windows.test.ts; this pins the matching semantics
 * (substring vs RegExp, AND across fields, undefined handling) fast.
 */
import { describe, it, expect } from 'vitest';
import { matchPageFields } from '../src/lib/browser';

describe('matchPageFields', () => {
  it('matches a title by substring and by RegExp', () => {
    const fields = { title: 'Craftdriver Example App' };
    expect(matchPageFields(fields, { title: 'Example App' })).toBe(true);
    expect(matchPageFields(fields, { title: /Example App/ })).toBe(true);
    expect(matchPageFields(fields, { title: 'Loading' })).toBe(false);
    expect(matchPageFields(fields, { title: /^Example/ })).toBe(false); // anchored, no match
  });

  it('matches a url by substring and by RegExp', () => {
    const fields = { url: 'file:///Apps/Example.app/renderer/index.html' };
    expect(matchPageFields(fields, { url: 'index.html' })).toBe(true);
    expect(matchPageFields(fields, { url: /\/renderer\// })).toBe(true);
    expect(matchPageFields(fields, { url: 'about:blank' })).toBe(false);
  });

  it('requires every named field to match (AND)', () => {
    const fields = { url: 'file:///x/index.html', title: 'Example App' };
    expect(matchPageFields(fields, { url: 'index.html', title: 'Example App' })).toBe(true);
    expect(matchPageFields(fields, { url: 'index.html', title: 'Splash' })).toBe(false);
    expect(matchPageFields(fields, { url: 'other', title: 'Example App' })).toBe(false);
  });

  it('does not match when the page lacks the field the matcher names', () => {
    expect(matchPageFields({ url: 'x' }, { title: 'Example App' })).toBe(false);
    expect(matchPageFields({ title: undefined }, { title: /x/ })).toBe(false);
  });

  it('ignores fields the matcher does not name', () => {
    // Only title is asked about; url is irrelevant.
    expect(matchPageFields({ url: 'anything', title: 'Example App' }, { title: 'Example App' })).toBe(true);
  });
});
