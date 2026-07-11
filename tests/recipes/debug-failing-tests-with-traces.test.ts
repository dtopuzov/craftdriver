// Runnable proof for docs/recipes/debug-failing-tests-with-traces.md
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Browser } from '../../src';
import { BROWSER_NAME, EXAMPLES_BASE_URL } from '../utils';

describe('login trace', () => {
  let browser: Browser;
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'craftdriver-trace-recipe-'));
  const rawTraceDir = path.join(tempRoot, 'login-raw');
  const publishedTraceZip = process.env.CRAFTDRIVER_RECIPE_TRACE_ZIP;
  const traceZip = publishedTraceZip
    ? path.resolve(publishedTraceZip)
    : path.join(tempRoot, 'login-failure.zip');

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  beforeEach(async () => {
    await browser.startTrace({
      outDir: rawTraceDir,
      title: 'Failing login test',
    });
  });

  afterEach(async ({ task }) => {
    const failed = task.result?.state === 'fail';
    // The environment override is used only to regenerate the downloadable
    // passing sample. Normal recipe runs keep a zip exclusively on failure.
    const keep = failed || publishedTraceZip !== undefined;
    await browser.stopTrace(keep ? { path: traceZip } : undefined);
    if (keep && !existsSync(traceZip)) {
      throw new Error(`Trace zip was not written: ${traceZip}`);
    }
    if (!keep) rmSync(rawTraceDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await browser.quit();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('fills and submits the login form', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
    await browser.fill('#username', 'alice');
    await browser.fill('#password', 'secret');
    await browser.click('#submit');
    await browser.expect('#welcome').toContainText('Welcome back, alice!');
  });
});
