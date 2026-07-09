// Runnable proof for docs/recipes/trace-failing-test.md
// The MD snippet is the withTrace helper plus the test body.
import { afterAll, beforeAll, describe, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('capture failure evidence with tracing', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;
  const tracesRoot = path.join(os.tmpdir(), `craftdriver-traces-${Date.now()}`);

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
    rmSync(tracesRoot, { recursive: true, force: true });
  });

  async function withTrace(name: string, run: () => Promise<void>) {
    const outDir = path.join(tracesRoot, `${name}-${Date.now()}`);
    await browser.startTrace({ outDir });

    try {
      await run();
    } catch (error) {
      console.error(`Trace kept at ${outDir}`);
      throw error;
    } finally {
      await browser.stopTrace().catch(() => undefined);
    }
  }

  it('records a replayable trail around a flow', async () => {
    await withTrace('login', async () => {
      await browser.navigateTo(`${baseUrl}/login.html`);
      await browser.getByLabel('Username').fill('alice');
      await browser.getByLabel('Password').fill('secret');
      await browser.getByRole('button', { name: 'Sign in' }).click();
      await browser.expect('#welcome').toContainText('Welcome back, alice!');
    });
  });
});
