import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser, A11yError } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('a11y (axe-core wrapper)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/a11y.html`);
  });

  it('audit() returns seeded violations with their documented shape', async () => {
    const report = await browser.a11y.audit();
    const ids = report.violations.map((v) => v.id);
    expect(ids).toContain('image-alt');
    expect(ids).toContain('button-name');
    expect(typeof report.passes).toBe('number');
    expect(typeof report.incomplete).toBe('number');
    expect(typeof report.inapplicable).toBe('number');
    // spot-check shape of one violation (tests our serialisation, not axe-core)
    const v = report.violations[0];
    expect(typeof v.helpUrl).toBe('string');
    expect(['minor', 'moderate', 'serious', 'critical']).toContain(v.impact);
    expect(typeof v.nodes[0].html).toBe('string');
    expect(Array.isArray(v.nodes[0].target)).toBe(true);
  });

  it('check() throws A11yError with violations and help URLs in the message', async () => {
    let caught: unknown;
    try {
      await browser.a11y.check();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(A11yError);
    const err = caught as A11yError;
    expect(err.violations.length).toBeGreaterThan(0);
    expect(err.message).toMatch(/violation/);
    expect(err.message).toMatch(/https?:\/\//);
  });

  it('disableRules and axeOptions both suppress a rule', async () => {
    const baseline = await browser.a11y.audit();
    expect(baseline.violations.map((v) => v.id)).toContain('image-alt');

    const viaDisableRules = await browser.a11y.audit({ disableRules: ['image-alt'] });
    expect(viaDisableRules.violations.map((v) => v.id)).not.toContain('image-alt');

    const viaAxeOptions = await browser.a11y.audit({
      axeOptions: { rules: { 'image-alt': { enabled: false } } },
    });
    expect(viaAxeOptions.violations.map((v) => v.id)).not.toContain('image-alt');
  });

  it('disableRules and rules together throw a clear error', async () => {
    await expect(
      browser.a11y.audit({ disableRules: ['image-alt'], rules: ['button-name'] })
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('rules: whitelist runs only the listed rules', async () => {
    const report = await browser.a11y.audit({ rules: ['button-name'] });
    const ids = report.violations.map((v) => v.id);
    expect(ids).toContain('button-name');
    expect(ids).not.toContain('image-alt');
  });

  it('minImpact: critical keeps critical violations and drops serious ones', async () => {
    const report = await browser.a11y.audit({ minImpact: 'critical' });
    // image-alt is critical — must still be present (guards against vacuous pass)
    expect(report.violations.map((v) => v.id)).toContain('image-alt');
    // nothing below critical should leak through
    expect(report.violations.every((v) => v.impact === 'critical')).toBe(true);
  });

  it('scoping: #bad has violations, #good is clean and check() does not throw', async () => {
    const badIds = (await browser.find('#bad').a11y.audit()).violations.map((v) => v.id);
    expect(badIds).toContain('image-alt');
    expect(badIds).toContain('button-name');

    const goodIds = (await browser.find('#good').a11y.audit()).violations.map((v) => v.id);
    expect(goodIds).not.toContain('image-alt');
    expect(goodIds).not.toContain('button-name');

    // check() must not throw for the clean region
    await browser.find('#good').a11y.check();
  });

  it('Locator.a11y re-resolves after navigating away and back', async () => {
    const bad = browser.locator('#bad');
    await bad.a11y.audit(); // prime
    // Navigate away so any cached WebElement becomes stale.
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/locator.html`);
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/a11y.html`);
    // Must re-resolve against the fresh document — stale ref would throw here.
    const report = await bad.a11y.audit();
    expect(report.violations.map((v) => v.id)).toContain('image-alt');
  });
});
