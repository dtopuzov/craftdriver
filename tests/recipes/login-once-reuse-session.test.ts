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

  // Pins the "What storageState Restores" section of the MD. On a BiDi session
  // the launch option restores cookies AND localStorage: the saved origins are
  // hydrated once before the first navigation, so the login page's first script
  // already sees them. (The recipe MD prose is reconciled in the docs pass.)
  it('restores localStorage on the launch path (BiDi)', async () => {
    const browser = await Browser.launch({
      browserName: BROWSER_NAME,
      storageState: authState,
    });
    await browser.navigateTo(`${baseUrl}/login.html`);

    const stored = await browser.evaluate<Record<string, string>>(
      'const r = {}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); r[k]=localStorage.getItem(k);} return r;',
    );
    // The login example writes lastUser + theme; saveState captured them and the
    // launch-time hydrator restored them.
    expect(stored.lastUser).toBe('alice');

    await browser.quit();
  });
});
