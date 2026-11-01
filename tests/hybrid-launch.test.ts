/**
 * Hybrid Chrome launch (the default for local Chrome with BiDi): craftdriver
 * launches Chrome, runs the BiDi mapper in-process, and attaches chromedriver
 * for Classic commands in the background.
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
import {
  chooseChromeLaunchPath,
  chromeVersionVerdict,
  mapperChromeRange,
  type ChromeLaunchRouteInput,
} from '../src/lib/hybridLaunch';
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

  it('takes the hybrid path by default, forced only by the override', () => {
    expect(route({})).toEqual({ path: 'hybrid', forced: false });
    expect(route({ browserName: 'chromium' })).toEqual({ path: 'hybrid', forced: false });
    expect(route({ env: 'hybrid' })).toEqual({ path: 'hybrid', forced: true });
    expect(route({ env: '' })).toEqual({ path: 'hybrid', forced: false });
  });

  it('uses chromedriver when the override says so', () => {
    expect(route({ env: 'chromedriver' })).toEqual({
      path: 'chromedriver',
      reason: "CRAFTDRIVER_CHROME_LAUNCH_MODE is 'chromedriver'",
    });
  });

  it.each<[string, Partial<ChromeLaunchRouteInput>, RegExp]>([
    ['firefox', { browserName: 'firefox' }, /only launches Chrome/],
    ['safari', { browserName: 'safari' }, /only launches Chrome/],
    ['BiDi off', { bidiRequested: false }, /needs BiDi/],
    ['mobile emulation', { mobileEmulation: true }, /mobileEmulation/],
    ['own debugging port', { args: ['--remote-debugging-port=9333'] }, /remote-debugging/],
    ['electron', { kind: 'electron' }, /electron launches/],
    ['remote', { kind: 'remote' }, /remote launches/],
  ])('%s: uses chromedriver, also when hybrid is forced', (_, over, reason) => {
    for (const env of [undefined, 'hybrid']) {
      const fallback = route({ ...over, env });
      expect(fallback.path).toBe('chromedriver');
      expect((fallback as { reason: string }).reason).toMatch(reason);
    }
  });

  it.each<[number | undefined, string]>([
    [139, 'older'],
    [140, 'verified'],
    [158, 'verified'],
    [159, 'newer'],
    [undefined, 'unknown'],
  ])('places Chrome %s in the verified range as %s', (major, verdict) => {
    expect(chromeVersionVerdict(major, { min: 140, max: 158 })).toBe(verdict);
  });

  it('reads a verified range that is not empty', () => {
    const { min, max } = mapperChromeRange();
    expect(Number.isInteger(min) && Number.isInteger(max) && min <= max).toBe(true);
  });

  it('rejects unknown override values', () => {
    let err: unknown;
    try {
      route({ env: 'auto' });
    } catch (e) {
      err = e;
    }
    expect(CraftdriverError.is(err, ErrorCode.INVALID_ARGUMENT)).toBe(true);
    expect((err as Error).message).toMatch(
      /CRAFTDRIVER_CHROME_LAUNCH_MODE must be 'chromedriver' or 'hybrid'/
    );
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

/** Launch with `CRAFTDRIVER_CHROME_LAUNCH_MODE` set, restoring it afterwards. */
async function launchWithMode(
  mode: 'hybrid' | undefined,
  options: Parameters<typeof Browser.launch>[0] = { browserName: 'chrome' }
): Promise<Browser> {
  const before = process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE;
  if (mode) process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE = mode;
  else delete process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE;
  try {
    return await Browser.launch(options);
  } finally {
    if (before === undefined) delete process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE;
    else process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE = before;
  }
}

describe.runIf(IS_CHROMIUM)('hybrid launch with real Chrome', () => {
  let browser: Browser;

  beforeAll(async () => {
    // Forced, so a failure fails here instead of falling back to chromedriver.
    browser = await launchWithMode('hybrid');
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
      const browser = await launchWithMode('hybrid');
      const chrome = (browser as unknown as { _chrome: { userDataDir: string; pid: number } })
        ._chrome;
      // Quit before chromedriver may even have finished attaching.
      await browser.quit();
      // Helpers may take a moment to exit after the browser process; the
      // contract is that nothing is left shortly after quit().
      await expect
        .poll(() => chromeProcessesWith(chrome.userDataDir), { timeout: 3_000 })
        .toEqual([]);
      await expect.poll(() => fs.existsSync(chrome.userDataDir), { timeout: 3_000 }).toBe(false);
    }
  });

  it('uses chromedriver by default when mobileEmulation is set', async () => {
    const browser = await launchWithMode(undefined, {
      browserName: 'chrome',
      mobileEmulation: 'iPhone 14',
    });
    try {
      expect((browser as unknown as { _chromeLaunchPath: string })._chromeLaunchPath).toBe(
        'chromedriver'
      );
    } finally {
      await browser.quit();
    }
  });
});
