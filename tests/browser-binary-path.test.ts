/**
 * Tests for resolveBrowserBinaryPath() — the browser-binary resolution chain
 * (Chrome/Chromium/Firefox), independent of and opt-in relative to the
 * existing driver-binary chain in driverManager.ts.
 */

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { resolveBrowserBinaryPath } from '../src/lib/driverManager';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL } from './utils';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';

/** Remove a list of keys from process.env, returning a restore function. */
function unsetEnvVars(keys: string[]): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

const BROWSER_PATH_ENV_VARS = [
  'CRAFTDRIVER_CHROME_PATH',
  'CRAFTDRIVER_FIREFOX_PATH',
  'CRAFTDRIVER_BROWSER_PATH',
  'CHROME_BIN',
  'FIREFOX_BIN',
  'SE_CHROME_PATH',
  'SE_FIREFOX_PATH',
];

describe('resolveBrowserBinaryPath()', () => {
  const testRoot = path.join(os.tmpdir(), `craftdriver-browserpath-${process.pid}`);
  let restoreEnv = () => {};

  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(testRoot, { recursive: true });
    restoreEnv = unsetEnvVars(BROWSER_PATH_ENV_VARS);
  });

  afterEach(() => {
    restoreEnv?.();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function touch(name: string): string {
    const p = path.join(testRoot, name);
    fs.writeFileSync(p, '');
    return p;
  }

  it('returns undefined when nothing resolves', () => {
    expect(resolveBrowserBinaryPath('chrome')).toBeUndefined();
    expect(resolveBrowserBinaryPath('firefox')).toBeUndefined();
  });

  it('resolves the explicit argument first', () => {
    const explicit = touch('explicit-chrome');
    process.env.CRAFTDRIVER_CHROME_PATH = touch('env-chrome');
    expect(resolveBrowserBinaryPath('chrome', explicit)).toBe(explicit);
  });

  it('falls through an invalid explicit argument to the env chain', () => {
    const envPath = touch('env-chrome');
    process.env.CRAFTDRIVER_CHROME_PATH = envPath;
    expect(resolveBrowserBinaryPath('chrome', path.join(testRoot, 'does-not-exist'))).toBe(envPath);
  });

  it('prefers CRAFTDRIVER_CHROME_PATH over CRAFTDRIVER_BROWSER_PATH', () => {
    process.env.CRAFTDRIVER_CHROME_PATH = touch('specific');
    process.env.CRAFTDRIVER_BROWSER_PATH = touch('generic');
    expect(resolveBrowserBinaryPath('chrome')).toBe(process.env.CRAFTDRIVER_CHROME_PATH);
  });

  it('prefers CRAFTDRIVER_BROWSER_PATH over CHROME_BIN', () => {
    process.env.CRAFTDRIVER_BROWSER_PATH = touch('generic');
    process.env.CHROME_BIN = touch('chrome-bin');
    expect(resolveBrowserBinaryPath('chrome')).toBe(process.env.CRAFTDRIVER_BROWSER_PATH);
  });

  it('prefers CHROME_BIN over SE_CHROME_PATH', () => {
    process.env.CHROME_BIN = touch('chrome-bin');
    process.env.SE_CHROME_PATH = touch('se-chrome');
    expect(resolveBrowserBinaryPath('chrome')).toBe(process.env.CHROME_BIN);
  });

  it('falls back to SE_CHROME_PATH when nothing else is set', () => {
    process.env.SE_CHROME_PATH = touch('se-chrome');
    expect(resolveBrowserBinaryPath('chrome')).toBe(process.env.SE_CHROME_PATH);
  });

  it('skips an env var pointing at a nonexistent file', () => {
    process.env.CRAFTDRIVER_CHROME_PATH = path.join(testRoot, 'does-not-exist');
    process.env.CHROME_BIN = touch('chrome-bin');
    expect(resolveBrowserBinaryPath('chrome')).toBe(process.env.CHROME_BIN);
  });

  it('resolves Firefox vars independently of Chrome vars', () => {
    process.env.CRAFTDRIVER_CHROME_PATH = touch('chrome');
    process.env.CRAFTDRIVER_FIREFOX_PATH = touch('firefox');
    expect(resolveBrowserBinaryPath('firefox')).toBe(process.env.CRAFTDRIVER_FIREFOX_PATH);
    expect(resolveBrowserBinaryPath('chrome')).toBe(process.env.CRAFTDRIVER_CHROME_PATH);
  });
});

/** Best-effort discovery of a real, already-installed Chrome/Chromium binary
 *  on this machine — deliberately independent of driverManager's own
 *  CHROME_CANDIDATES list, so the test doesn't just check its own homework. */
function findSystemChromeBinary(): string | undefined {
  const platform = os.platform();
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].find((p) => fs.existsSync(p));
  }
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ].find((p) => fs.existsSync(p));
  }
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [cmd], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return undefined;
}

describe('Browser.launch() with a custom browserPath', () => {
  const systemChrome = findSystemChromeBinary();

  it.skipIf(!systemChrome)(
    'launches successfully when browserPath points at a real Chrome binary',
    async () => {
      const browser = await Browser.launch({ browserName: 'chrome', browserPath: systemChrome });
      try {
        await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`);
        await browser.fill('#username', 'testuser');
        await browser.fill('#password', 'secret');
        await browser.click('#submit');
        await browser.find('#result').expect().toContainText('Welcome back');
      } finally {
        await browser.quit();
      }
    },
    60_000,
  );
});
