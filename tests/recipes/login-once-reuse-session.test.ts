// Runnable proof for docs/recipes/login-once-reuse-session.md
// The MD "generate" block is the first test's body; the "reuse" block is the
// second test's body (minus the temp-file plumbing).
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Browser } from '../../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from '../utils';

describe('log in once, reuse the session', () => {
  const baseUrl = EXAMPLES_BASE_URL;
  const authState = path.join(os.tmpdir(), `craftdriver-auth-${Date.now()}.json`);

  afterAll(() => {
    fs.rmSync(authState, { force: true });
  });

  it('generates auth state once', async () => {
    const browser = await Browser.launch({ browserName: BROWSER_NAME });

    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.getByLabel('Username').fill('alice');
    await browser.getByLabel('Password').fill('secret');
    await browser.getByRole('button', { name: 'Sign in' }).click();
    await browser.expect('#welcome').toContainText('Welcome back, alice!');

    await browser.saveState(authState);
    await browser.quit();
  });

  it('starts already signed in', async () => {
    const browser = await Browser.launch({
      browserName: BROWSER_NAME,
      storageState: authState,
    });

    await browser.navigateTo(`${baseUrl}/login.html`);
    await browser.expect('#welcome').toContainText('Welcome back, alice!');

    await browser.quit();
  });

  // Pins the "What storageState Restores" section of the MD. The launch option
  // runs while the browser is still on about:blank, which has no origin, so
  // origin-scoped storage has nowhere to land — measured, not assumed. Without
  // this the doc could quietly drift back to promising both halves.
  it('restores cookies but not localStorage on the launch path', async () => {
    const browser = await Browser.launch({
      browserName: BROWSER_NAME,
      storageState: authState,
    });
    await browser.navigateTo(`${baseUrl}/login.html`);

    const stored = await browser.evaluate<Record<string, string>>(
      'const r = {}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); r[k]=localStorage.getItem(k);} return r;',
    );
    // The login example writes lastUser + theme, and saveState captured them.
    expect(Object.keys(stored)).toHaveLength(0);

    // Navigate-then-load is the order that does restore them.
    await browser.loadState(authState);
    const afterExplicitLoad = await browser.evaluate<Record<string, string>>(
      'return { lastUser: localStorage.getItem("lastUser") }',
    );
    expect(afterExplicitLoad.lastUser).toBe('alice');

    await browser.quit();
  });
});
