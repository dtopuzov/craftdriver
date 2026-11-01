/**
 * Direct Chrome launch (no chromedriver), used by the hybrid launch path.
 *
 * Fake-Chrome cases cover the DevTools-URL handshake (URL, timeout, early
 * exit) without a browser; one real-Chrome case proves the CDP endpoint works
 * and that close() leaves neither a process nor a profile behind.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  buildChromeArgs,
  CHROMEDRIVER_DEFAULT_SWITCHES,
  expandPrefs,
  launchChrome,
  userDataDirFromArgs,
} from '../src/lib/chromeLauncher';
import { findChromeBinary } from '../src/lib/driverManager';
import { CraftdriverError, ErrorCode } from '../src/lib/errors';
import { IS_CHROMIUM } from './utils';

const isWindows = process.platform === 'win32';
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-chrome-'));
afterAll(() => fs.rmSync(fakeDir, { recursive: true, force: true }));

/** A POSIX shell script standing in for Chrome. Records its argv. */
function fakeChrome(name: string, body: string): string {
  const file = path.join(fakeDir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "$@" > "${file}.args"\n${body}\n`, { mode: 0o755 });
  return file;
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function profileDir(argsFile: string): string {
  const m = /--user-data-dir=(\S+)/.exec(fs.readFileSync(argsFile, 'utf8'));
  return m![1];
}

describe('chrome launcher: command line', () => {
  it('appends headless, profile and user args after the chromedriver defaults', () => {
    const args = buildChromeArgs({
      headless: true,
      userDataDir: '/tmp/p',
      args: ['--lang=de', '--disable-sync'],
    });
    expect(args.slice(0, CHROMEDRIVER_DEFAULT_SWITCHES.length)).toEqual([
      ...CHROMEDRIVER_DEFAULT_SWITCHES,
    ]);
    expect(args.slice(CHROMEDRIVER_DEFAULT_SWITCHES.length)).toEqual([
      '--headless=new',
      '--user-data-dir=/tmp/p',
      '--lang=de',
      '--disable-sync',
      'data:,',
    ]);
  });

  it('expands dotted prefs into the nested Preferences shape', () => {
    expect(
      expandPrefs({
        'download.default_directory': '/d',
        'download.prompt_for_download': false,
        'safebrowsing.enabled': true,
      })
    ).toEqual({
      download: { default_directory: '/d', prompt_for_download: false },
      safebrowsing: { enabled: true },
    });
  });

  it('detects a caller-supplied profile', () => {
    expect(userDataDirFromArgs(['--lang=de', '--user-data-dir=/x/y'])).toBe('/x/y');
    expect(userDataDirFromArgs(['--lang=de'])).toBeUndefined();
  });
});

describe.skipIf(isWindows)('chrome launcher: DevTools handshake (fake Chrome)', () => {
  it('resolves the DevTools URL and writes prefs into the temp profile', async () => {
    const bin = fakeChrome(
      'ok',
      'echo "noise" >&2\necho "DevTools listening on ws://127.0.0.1:41234/devtools/browser/abc" >&2\nsleep 30'
    );
    const chrome = await launchChrome({
      binary: bin,
      headless: true,
      prefs: { 'download.default_directory': '/d' },
    });
    const profile = profileDir(`${bin}.args`);
    try {
      expect(chrome.wsUrl).toBe('ws://127.0.0.1:41234/devtools/browser/abc');
      expect(chrome.debuggerAddress).toBe('127.0.0.1:41234');
      const prefs = JSON.parse(
        fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8')
      );
      expect(prefs).toEqual({ download: { default_directory: '/d' } });
    } finally {
      await chrome.close();
      await chrome.close(); // idempotent
    }
    expect(alive(chrome.pid)).toBe(false);
    expect(fs.existsSync(profile)).toBe(false);
  });

  it('fails with the output tail when Chrome exits before DevTools is ready', async () => {
    const bin = fakeChrome('dies', 'echo "sandbox exploded" >&2\nexit 3');
    const err = await launchChrome({ binary: bin, headless: true }).catch((e) => e);
    expect(CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)).toBe(true);
    expect(err.message).toContain('exited (code 3)');
    expect(err.message).toContain('sandbox exploded');
    expect(fs.existsSync(profileDir(`${bin}.args`))).toBe(false);
  });

  it('times out, kills Chrome and removes the profile when no URL arrives', async () => {
    const bin = fakeChrome('hangs', 'echo "still booting" >&2\nexec sleep 30');
    const err = await launchChrome({ binary: bin, headless: true, timeoutMs: 300 }).catch((e) => e);
    expect(CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)).toBe(true);
    expect(err.message).toContain('within 300ms');
    expect(err.message).toContain('still booting');
    expect(fs.existsSync(profileDir(`${bin}.args`))).toBe(false);
  });

  it('keeps a caller-supplied profile', async () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'own-profile-'));
    const bin = fakeChrome(
      'own',
      'echo "DevTools listening on ws://127.0.0.1:1/devtools/browser/x" >&2\nsleep 30'
    );
    const chrome = await launchChrome({
      binary: bin,
      headless: true,
      args: [`--user-data-dir=${own}`],
    });
    await chrome.close();
    expect(fs.existsSync(own)).toBe(true);
    fs.rmSync(own, { recursive: true, force: true });
  });

  it('reports a missing binary', async () => {
    const err = await launchChrome({
      binary: path.join(fakeDir, 'does-not-exist'),
      headless: true,
    }).catch((e) => e);
    expect(CraftdriverError.is(err, ErrorCode.DRIVER_ERROR)).toBe(true);
    expect(err.message).toContain('ENOENT');
  });
});

describe.runIf(IS_CHROMIUM)('chrome launcher: real Chrome', () => {
  it('launches, answers CDP, and leaves nothing behind on close', async () => {
    const binary = findChromeBinary();
    expect(binary, 'no Chrome installed').toBeDefined();
    const chrome = await launchChrome({ binary: binary!, headless: true });
    const profile = chrome.userDataDir!;
    expect(fs.existsSync(profile)).toBe(true);
    try {
      const ws = new WebSocket(chrome.wsUrl);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      const reply = await new Promise<{ result: { targetInfos: unknown[] } }>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(String(data))));
        ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      });
      expect(Array.isArray(reply.result.targetInfos)).toBe(true);
      const { result } = await new Promise<{ result: { product: string } }>((resolve) => {
        ws.once('message', (data) => resolve(JSON.parse(String(data))));
        ws.send(JSON.stringify({ id: 2, method: 'Browser.getVersion' }));
      });
      expect(result.product).toMatch(/Chrome\/\d+/);
      ws.close();
    } finally {
      await chrome.close();
    }
    expect(alive(chrome.pid)).toBe(false);
    expect(fs.existsSync(profile)).toBe(false);
  });
});
