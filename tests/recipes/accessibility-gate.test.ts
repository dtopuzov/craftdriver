// Runnable proof for docs/recipes/accessibility-gate.md
// The MD snippet is the first test's body; the second test proves the gate is
// not vacuous (it does surface real violations).
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('accessibility gate', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/a11y.html`);
  });

  afterAll(async () => {
    await browser.quit();
  });

  it('passes the gate for a clean region', async () => {
    // check() throws an A11yError listing violations; a clean region resolves.
    await browser.locator('#good').a11y.check({ minImpact: 'serious' });
  });

  it('surfaces real violations elsewhere (gate is not vacuous)', async () => {
    const report = await browser.a11y.audit({ minImpact: 'serious' });
    expect(report.violations.length).toBeGreaterThan(0);
  });
});
