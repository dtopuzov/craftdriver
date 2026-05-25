/**
 * BrowserContext cookies + storageState — real-world QA scenarios.
 *
 * The canonical use case is the "auth fixture" pattern: log in once,
 * save the session to disk, and skip the login UI in every subsequent
 * test. This file covers that round-trip plus multi-user isolation and
 * targeted cookie cleanup — all on Chrome AND Firefox via BROWSER_NAME.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('BrowserContext cookies & storageState', () => {
  let browser: Browser;
  let tmpDir: string;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'craftdriver-storage-'));
  });

  afterAll(async () => {
    await browser.quit();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Cookies ────────────────────────────────────────────────────────────

  it('cookies() returns cookies set by a page in this context', async () => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
      await page.waitForLoadState('load');
      await page.find('#username').fill('alice');
      await page.find('#password').fill('secret');
      await page.find('#submit').click();
      await page.expect('#welcome').toContainText('alice');

      const cookies = await ctx.cookies();
      const sid = cookies.find((c) => c.name === 'session');
      expect(sid).toBeDefined();
      expect(sid?.value).toBe('alice');
    } finally {
      await ctx.close();
    }
  });

  it('cookies(urls) filters to cookies sendable to the given URL', async () => {
    const ctx = await browser.newContext();
    try {
      const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
      await page.waitForLoadState('load');
      await page.find('#username').fill('alice');
      await page.find('#password').fill('secret');
      await page.find('#submit').click();
      await page.expect('#welcome').toBeVisible();

      // First-party host returns the session cookie.
      const local = await ctx.cookies(baseUrl);
      expect(local.some((c) => c.name === 'session')).toBe(true);

      // An unrelated host returns nothing.
      const other = await ctx.cookies('https://tracker.example.com/');
      expect(other.some((c) => c.name === 'session')).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it('addCookies() pre-seeds a session before the first navigation', async () => {
    // The auth-fixture shortcut: skip the login form by injecting the
    // session cookie directly, then load the page and assert we are in.
    const ctx = await browser.newContext();
    try {
      const hostname = new URL(baseUrl).hostname;
      await ctx.addCookies([
        { name: 'session', value: 'alice', domain: hostname, path: '/' },
      ]);
      const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
      await page.waitForLoadState('load');
      // The page restores the session from the cookie on load.
      await page.expect('#welcome').toContainText('alice');
    } finally {
      await ctx.close();
    }
  });

  it('addCookies() rejects sameSite:none without secure:true', async () => {
    const ctx = await browser.newContext();
    try {
      await expect(
        ctx.addCookies([
          { name: 'x', value: '1', domain: 'example.com', sameSite: 'none', secure: false },
        ])
      ).rejects.toThrow(/sameSite/);
    } finally {
      await ctx.close();
    }
  });

  it('clearCookies({ name }) signs the user out without touching other cookies', async () => {
    const ctx = await browser.newContext();
    try {
      const hostname = new URL(baseUrl).hostname;
      await ctx.addCookies([
        { name: 'session', value: 'alice', domain: hostname, path: '/' },
        { name: 'theme', value: 'dark', domain: hostname, path: '/' },
      ]);

      await ctx.clearCookies({ name: 'session' });

      const remaining = await ctx.cookies();
      expect(remaining.some((c) => c.name === 'session')).toBe(false);
      expect(remaining.some((c) => c.name === 'theme')).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('clearCookies() with no filter wipes every cookie in the context', async () => {
    const ctx = await browser.newContext();
    try {
      const hostname = new URL(baseUrl).hostname;
      await ctx.addCookies([
        { name: 'a', value: '1', domain: hostname, path: '/' },
        { name: 'b', value: '2', domain: hostname, path: '/' },
      ]);
      expect((await ctx.cookies()).length).toBeGreaterThanOrEqual(2);

      await ctx.clearCookies();
      expect(await ctx.cookies()).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  // ── storageState round-trip (the auth-fixture pattern) ─────────────────

  it('saveStorageState() + newContext({ storageState }) skips the login UI', async () => {
    // Step 1 (the "auth fixture", normally a one-time setup):
    //   log in for real, then snapshot cookies + localStorage to disk.
    const setupCtx = await browser.newContext();
    const setupPage = await setupCtx.newPage({ url: `${baseUrl}/login.html` });
    await setupPage.waitForLoadState('load');
    await setupPage.find('#username').fill('alice');
    await setupPage.find('#password').fill('secret');
    await setupPage.find('#submit').click();
    await setupPage.expect('#welcome').toContainText('alice');

    const statePath = path.join(tmpDir, 'alice.json');
    const state = await setupCtx.saveStorageState(statePath);
    expect(state.cookies?.some((c) => c.name === 'session')).toBe(true);
    expect(state.localStorage?.[new URL(baseUrl).origin]?.theme).toBe('dark');
    await setupCtx.close();

    // Step 2 (every test from here on):
    //   load the snapshot — the form is already gone on first paint.
    const ctx = await browser.newContext({ storageState: statePath });
    try {
      const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
      await page.waitForLoadState('load');
      await page.expect('#welcome').toContainText('alice');

      // localStorage was restored before page scripts ran.
      const theme = await page.evaluate<string | null>(
        `return localStorage.getItem('theme');`
      );
      expect(theme).toBe('dark');
    } finally {
      await ctx.close();
    }
  });

  it('loadStorageState() replaces (does not stack) prior preload scripts', async () => {
    const ctx = await browser.newContext();
    try {
      const origin = new URL(baseUrl).origin;
      await ctx.loadStorageState({
        localStorage: { [origin]: { mode: 'first' } },
      });
      await ctx.loadStorageState({
        localStorage: { [origin]: { mode: 'second' } },
      });

      const page = await ctx.newPage({ url: `${baseUrl}/login.html` });
      await page.waitForLoadState('load');
      const mode = await page.evaluate<string | null>(
        `return localStorage.getItem('mode');`
      );
      // Second call wins — first preload was removed.
      expect(mode).toBe('second');
    } finally {
      await ctx.close();
    }
  });

  it('storageState() snapshot is empty for a brand-new context', async () => {
    const ctx = await browser.newContext();
    try {
      const state = await ctx.storageState();
      expect(state.cookies ?? []).toEqual([]);
      expect(state.localStorage ?? {}).toEqual({});
    } finally {
      await ctx.close();
    }
  });
});
