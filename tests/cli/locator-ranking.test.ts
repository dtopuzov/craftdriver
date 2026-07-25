import { describe, it, expect } from 'vitest';
import { looksVolatile, propose, type Evidence } from '../../src/cli/locatorCandidates';

// Pure-logic coverage for the stability-aware locator ranking. The rule:
// prefer the locator that is simultaneously the most stable AND the most
// meaningful — semantic role/name locators lead while the name is stable, but
// the moment the accessible name looks dynamic they are demoted below a stable
// anchor, so `craftdriver locators` stops recommending a name that will rot.

const evidence = (over: Partial<Evidence>): Evidence => ({
  role: null,
  name: null,
  label: null,
  testid: null,
  text: null,
  id: null,
  nameAttr: null,
  tag: 'button',
  nonce: 'n',
  ...over,
});

const kinds = (e: Evidence) => propose(e).map((c) => c.kind);

describe('looksVolatile', () => {
  it('flags names with digits or currency signs', () => {
    for (const v of ['Count is 0', '3 items', '$4.99', '12:30 PM', 'Page 2 of 9']) {
      expect(looksVolatile(v), v).toBe(true);
    }
  });

  it('flags localized numerals and non-ASCII currency signs', () => {
    for (const v of ['٣ items', '₹99', '₩5000', '3 000 €', '५ अंक']) {
      expect(looksVolatile(v), v).toBe(true);
    }
  });

  it('leaves genuinely stable labels alone, localized or not', () => {
    for (const s of ['Sign in', 'Email', 'Save', 'Guardar', 'Anmelden', 'ログイン', 'Zürich']) {
      expect(looksVolatile(s), s).toBe(false);
    }
  });
});

describe('propose ordering', () => {
  it('leads with role+name when the accessible name is stable', () => {
    const order = kinds(evidence({ role: 'button', name: 'Sign in', id: 'submit', text: 'Sign in' }));
    expect(order[0]).toBe('role');
    expect(order).toContain('css');
    expect(order.indexOf('role')).toBeLessThan(order.indexOf('css'));
  });

  it('demotes role+name below a stable anchor when the name is dynamic', () => {
    // The Vite counter: <button id="counter">Count is 0</button>.
    const order = kinds(evidence({ role: 'button', name: 'Count is 0', text: 'Count is 0', id: 'counter' }));
    expect(order[0]).toBe('css'); // #counter — stable, wins
    expect(order.indexOf('css')).toBeLessThan(order.indexOf('role'));
    expect(order.indexOf('css')).toBeLessThan(order.indexOf('text'));
  });

  it('still offers the role+name candidate when the name is dynamic (demoted, not dropped)', () => {
    const order = kinds(evidence({ role: 'button', name: 'Count is 0', id: 'counter' }));
    expect(order).toContain('role');
  });

  it('prefers a test id over a dynamic role+name when the app ships one', () => {
    const order = kinds(evidence({ role: 'button', name: '$4.99', testid: 'price' }));
    expect(order[0]).toBe('testid');
    expect(order.indexOf('testid')).toBeLessThan(order.indexOf('role'));
  });

  it('demotes a dynamic label per-candidate, not only a dynamic name', () => {
    // A field whose accessible name AND label both read "Seats remaining 3":
    // the label is exactly as brittle as the name and must not ride to the top.
    const order = kinds(
      evidence({ role: 'spinbutton', name: 'Seats remaining 3', label: 'Seats remaining 3', id: 'seats' }),
    );
    expect(order[0]).toBe('css'); // #seats — the only stable anchor, wins
    expect(order.indexOf('css')).toBeLessThan(order.indexOf('label'));
    expect(order.indexOf('css')).toBeLessThan(order.indexOf('role'));
  });

  it('keeps a stable label ahead of a demoted dynamic name', () => {
    // Label "Seats" is stable; the accessible name "Seats remaining 3" is not.
    const order = kinds(
      evidence({ role: 'spinbutton', name: 'Seats remaining 3', label: 'Seats', id: 'seats' }),
    );
    expect(order[0]).toBe('label'); // stable + most semantic
    expect(order.indexOf('label')).toBeLessThan(order.indexOf('role'));
    expect(order.indexOf('css')).toBeLessThan(order.indexOf('role'));
  });
});
