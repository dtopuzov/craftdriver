/**
 * Hybrid Chrome launch (`chromeLaunchMode: 'hybrid'`): craftdriver launches
 * Chrome, runs the BiDi mapper in-process, and attaches chromedriver for
 * Classic commands in the background.
 *
 * Covers the routing table, the background-attach contract of the Classic
 * HTTP layer, Classic/BiDi interop on one session, and process cleanup.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from '../src';
import { CraftdriverError, ErrorCode } from '../src/lib/errors';
import { HttpClient } from '../src/lib/http';
import { chooseChromeLaunchPath, type ChromeLaunchRouteInput } from '../src/lib/hybridLaunch';
import type { WebDriverEndpoint } from '../src/lib/types';
import { EXAMPLES_BASE_URL, IS_CHROMIUM } from './utils';

const chromeBase: ChromeLaunchRouteInput = {
  kind: 'browser',
  browserName: 'chrome',
  bidiRequested: true,
  mobileEmulation: false,
};

describe('chrome launch routing', () => {
  const route = (over: Partial<ChromeLaunchRouteInput>) =>
    chooseChromeLaunchPath({ ...chromeBase, ...over });

  it('defaults to chromedriver', () => {
    expect(route({})).toEqual({ path: 'chromedriver', reason: "chromeLaunchMode is 'auto'" });
    expect(route({ option: 'chromedriver', env: 'hybrid' }).path).toBe('chromedriver');
  });

  it('takes the hybrid path when asked, strictly for the option', () => {
    expect(route({ option: 'hybrid' })).toEqual({ path: 'hybrid', strict: true });
    expect(route({ env: 'hybrid' })).toEqual({ path: 'hybrid', strict: false });
    expect(route({ env: 'hybrid', browserName: 'chromium' }).path).toBe('hybrid');
  });

  it.each<[string, Partial<ChromeLaunchRouteInput>, RegExp]>([
    ['firefox', { browserName: 'firefox' }, /only launches Chrome/],
    ['safari', { browserName: 'safari' }, /only launches Chrome/],
    ['BiDi off', { bidiRequested: false }, /needs BiDi/],
    ['mobile emulation', { mobileEmulation: true }, /mobileEmulation/],
    ['own debugging port', { args: ['--remote-debugging-port=9333'] }, /remote-debugging/],
    ['electron', { kind: 'electron' }, /electron launches/],
  ])('%s: explicit hybrid throws, env hybrid falls back', (_, over, reason) => {
    let err: unknown;
    try {
      route({ ...over, option: 'hybrid' });
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.UNSUPPORTED)).toBe(true);
    expect((err as Error).message).toMatch(reason);

    const fallback = route({ ...over, env: 'hybrid' });
    expect(fallback.path).toBe('chromedriver');
    expect((fallback as { reason: string }).reason).toMatch(reason);
  });

  it('rejects unknown modes from the option and the env var', () => {
    expect(() => route({ option: 'fast' })).toThrow(/chromeLaunchMode must be one of/);
    expect(() => route({ env: 'yes' })).toThrow(/CRAFTDRIVER_CHROME_LAUNCH_MODE must be one of/);
  });

  it('rejects chromeLaunchMode on Electron and remote launches', async () => {
    await expect(
      Browser.launch({
        electron: { appBinaryPath: '/nope' },
        chromeLaunchMode: 'hybrid',
      } as never)
    ).rejects.toThrow(/electron cannot be combined with chromeLaunchMode/);
    await expect(
      Browser.launch({
        remote: { url: 'http://127.0.0.1:1/wd/hub' },
        chromeLaunchMode: 'hybrid',
      } as never)
    ).rejects.toThrow(/remote cannot be combined with chromeLaunchMode/);
  });
});

describe('Classic commands during a background attach', () => {
  let server: http.Server;
  let port: number;
  const paths: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      paths.push(req.url!);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: null }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('wait for the attach, then use the real endpoint and session id', async () => {
    const endpoint: WebDriverEndpoint = { protocol: 'http', hostname: '127.0.0.1', port: 0 };
    let attach!: (id: string) => void;
    endpoint.pendingSession = {
      placeholder: 'pending-x',
      ready: new Promise<string>((r) => (attach = r)),
    };
    const sent = new HttpClient(endpoint).send({ method: 'GET', path: '/session/pending-x/url' });
    await new Promise((r) => setTimeout(r, 50));
    expect(paths).toEqual([]);

    endpoint.port = port;
    attach('real-session');
    await sent;
    expect(paths).toEqual(['/session/real-session/url']);
  });

  it('fail with the attach error when the attach failed', async () => {
    const failure = new CraftdriverError(ErrorCode.DRIVER_ERROR, 'chromedriver could not attach');
    const ready = Promise.reject(failure);
    ready.catch(() => {});
    const endpoint: WebDriverEndpoint = {
      protocol: 'http',
      hostname: '127.0.0.1',
      port: 0,
      pendingSession: { placeholder: 'p', ready },
    };
    await expect(
      new HttpClient(endpoint).send({ method: 'GET', path: '/session/p/title' })
    ).rejects.toBe(failure);
  });
});

/** Chrome processes whose command line mentions `needle` (POSIX only). */
function chromeProcessesWith(needle: string): string[] {
  try {
    return execFileSync('pgrep', ['-f', needle], { encoding: 'utf8' }).trim().split('\n');
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

describe.runIf(IS_CHROMIUM)('hybrid launch with real Chrome', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: 'chrome', chromeLaunchMode: 'hybrid' });
  });
  afterAll(async () => {
    await browser?.quit();
  });

  it('starts on the hybrid path with BiDi', () => {
    expect((browser as unknown as { _chromeLaunchPath: string })._chromeLaunchPath).toBe('hybrid');
    expect(browser.isBiDiEnabled()).toBe(true);
  });

  it('mixes Classic and BiDi on one session', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/login.html`); // Classic
    expect(await browser.evaluate(() => location.pathname)).toBe('/login.html'); // BiDi
    await browser.fill('#username', 'testuser');
    await browser.fill('#password', 'secret');
    await browser.click('#submit');
    await browser.find('#result').expect().toContainText('Welcome back');
  });

  it('shows dialogs to both onDialog (BiDi) and the Classic alert API', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/dialogs.html`);
    let handled = '';
    const off = browser.onDialog(async (dialog) => {
      // Read through Classic while the dialog is open, then close it.
      const classicText = await browser.getDialogMessage();
      await dialog.accept();
      handled = `${dialog.message()} / ${classicText}`;
    });
    try {
      await browser.click('#show-alert');
      await expect.poll(() => handled).toBe('Hello from alert / Hello from alert');
      await browser.expect('h1').toHaveText('Dialogs');
    } finally {
      off();
    }
  });

  it('saves downloads into downloadsDir', async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/download.html`);
    const dl = await browser.waitForDownload(() => browser.click('#download-btn'));
    expect(fs.existsSync(dl.path)).toBe(true);
  });
});

describe.runIf(IS_CHROMIUM && process.platform !== 'win32')('hybrid launch cleanup', () => {
  it('leaves no Chrome process or profile behind across repeated launches', async () => {
    for (let i = 0; i < 5; i++) {
      const browser = await Browser.launch({ browserName: 'chrome', chromeLaunchMode: 'hybrid' });
      const chrome = (browser as unknown as { _chrome: { userDataDir: string; pid: number } })
        ._chrome;
      // Quit before chromedriver may even have finished attaching.
      await browser.quit();
      expect(chromeProcessesWith(chrome.userDataDir)).toEqual([]);
      expect(fs.existsSync(chrome.userDataDir)).toBe(false);
    }
  });

  it('falls back to chromedriver when the env asks for hybrid but mobileEmulation is set', async () => {
    const before = process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE;
    process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE = 'hybrid';
    try {
      const browser = await Browser.launch({ browserName: 'chrome', mobileEmulation: 'iPhone 14' });
      try {
        expect((browser as unknown as { _chromeLaunchPath: string })._chromeLaunchPath).toBe(
          'chromedriver'
        );
      } finally {
        await browser.quit();
      }
    } finally {
      if (before === undefined) delete process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE;
      else process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE = before;
    }
  });
});
