/** Credentialed BrowserStack coverage for the public recipe. */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Browser } from '../../src/index.js';

const require = createRequire(import.meta.url);

const USERNAME = process.env.BROWSERSTACK_USERNAME;
const ACCESS_KEY = process.env.BROWSERSTACK_ACCESS_KEY;

const RUN_MOBILE = process.env.BROWSERSTACK_TEST_MOBILE === '1';

const RUN_LOCAL = process.env.BROWSERSTACK_TEST_LOCAL === '1';
const LOCAL_BINARY = process.env.BROWSERSTACK_LOCAL_BINARY;

const HUB_URL = 'https://hub.browserstack.com/wd/hub';
const LOGIN_EXAMPLE_URL = 'https://dtopuzov.github.io/craftdriver/examples/login.html';
const UPLOAD_EXAMPLE_URL = 'https://dtopuzov.github.io/craftdriver/examples/upload.html';

// Makes each CI run identifiable in the BrowserStack dashboard.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(() => {
  if (!USERNAME || !ACCESS_KEY) {
    throw new Error(
      'npm run test:browserstack requires BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY to be ' +
        'set — this suite creates real, metered BrowserStack sessions and never runs without them. ' +
        'Get credentials from your BrowserStack Automate dashboard and export both env vars.'
    );
  }
});

function auth(): { username: string; password: string } {
  return { username: USERNAME!, password: ACCESS_KEY! };
}

function bstackOptions(
  sessionName: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    projectName: 'CraftDriver',
    buildName: `remote-smoke-${RUN_ID}`,
    sessionName,
    ...extra,
  };
}

async function loginSmoke(browser: Browser): Promise<void> {
  await browser.navigateTo(LOGIN_EXAMPLE_URL);
  await browser.getByLabel('Username').fill('alice');
  await browser.getByLabel('Password').fill('secret');
  await browser.getByRole('button', { name: 'Sign in' }).click();
  await browser.expect('#welcome').toContainText('Welcome back, alice!');
}

interface GestureEvidence {
  pointerTypes: string[];
  pointerDownIds: number[];
  pointerEndIds: number[];
  pointerMoves: number;
  touchStarts: number;
  touchEnds: number;
  touchMoves: number;
  maxTouches: number;
}

async function touchGesturesWithinViewport(browser: Browser): Promise<void> {
  const [w, h] = await browser.evaluate<[number, number]>(() => {
    const state: GestureEvidence = {
      pointerTypes: [],
      pointerDownIds: [],
      pointerEndIds: [],
      pointerMoves: 0,
      touchStarts: 0,
      touchEnds: 0,
      touchMoves: 0,
      maxTouches: 0,
    };
    (
      window as typeof window & { __craftdriverGestureEvidence?: GestureEvidence }
    ).__craftdriverGestureEvidence = state;
    document.documentElement.style.touchAction = 'none';
    window.addEventListener(
      'pointerdown',
      (event) => {
        state.pointerTypes.push(event.pointerType);
        state.pointerDownIds.push(event.pointerId);
      },
      true
    );
    window.addEventListener('pointermove', () => state.pointerMoves++, true);
    for (const eventName of ['pointerup', 'pointercancel'] as const) {
      window.addEventListener(
        eventName,
        (event) => state.pointerEndIds.push(event.pointerId),
        true
      );
    }
    window.addEventListener(
      'touchstart',
      (event) => {
        state.touchStarts++;
        state.maxTouches = Math.max(state.maxTouches, event.touches.length);
      },
      true
    );
    window.addEventListener('touchmove', () => state.touchMoves++, true);
    for (const eventName of ['touchend', 'touchcancel'] as const) {
      window.addEventListener(eventName, () => state.touchEnds++, true);
    }
    return [window.innerWidth, window.innerHeight];
  });
  const x = Math.round(w / 2);
  const y = Math.round(h / 2);
  const reach = Math.round(Math.min(w, h) * 0.15);

  await browser.gesture.swipe({ from: [x, Math.round(h * 0.6)], to: [x, Math.round(h * 0.3)] });
  const swipe = await readGestureEvidence(browser);
  expect(swipe.pointerTypes.includes('touch') || swipe.touchStarts > 0).toBe(true);
  expect(swipe.pointerMoves > 0 || swipe.touchMoves > 0).toBe(true);
  expect(swipe.pointerEndIds.length > 0 || swipe.touchEnds > 0).toBe(true);

  await resetGestureEvidence(browser);
  await browser.gesture.pinch({ center: [x, y], scale: 0.5, distance: reach });
  const pinch = await readGestureEvidence(browser);
  expect(pinch.pointerTypes.includes('touch') || pinch.touchStarts > 0).toBe(true);
  expect(pinch.pointerMoves > 0 || pinch.touchMoves > 0).toBe(true);
  expect(new Set(pinch.pointerDownIds).size >= 2 || pinch.maxTouches >= 2).toBe(true);
}

function readGestureEvidence(browser: Browser): Promise<GestureEvidence> {
  return browser.evaluate(
    () =>
      (window as typeof window & { __craftdriverGestureEvidence: GestureEvidence })
        .__craftdriverGestureEvidence
  );
}

async function resetGestureEvidence(browser: Browser): Promise<void> {
  await browser.evaluate(() => {
    const state = (window as typeof window & { __craftdriverGestureEvidence: GestureEvidence })
      .__craftdriverGestureEvidence;
    state.pointerTypes.length = 0;
    state.pointerDownIds.length = 0;
    state.pointerEndIds.length = 0;
    state.pointerMoves = 0;
    state.touchStarts = 0;
    state.touchEnds = 0;
    state.touchMoves = 0;
    state.maxTouches = 0;
  });
}

async function writeTempUploadFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'craftdriver-bstack-upload-'));
  const filePath = path.join(dir, 'craftdriver-upload.txt');
  await fs.writeFile(filePath, 'craftdriver remote upload smoke', 'utf8');
  return filePath;
}

describe('BrowserStack — desktop smokes', () => {
  it('desktop Chrome: BiDi enabled, full flow, screenshot', async () => {
    const browser = await Browser.launch({
      browserName: 'chrome',
      enableBiDi: true,
      remote: {
        url: HUB_URL,
        auth: auth(),
        sessionTimeoutMs: 120_000,
        commandTimeoutMs: 120_000,
        capabilities: {
          browserVersion: 'latest',
          'bstack:options': bstackOptions('desktop-chrome', {
            os: 'Windows',
            osVersion: '11',
            seleniumBidi: true,
            // Version shown in BrowserStack's BiDi setup example.
            seleniumVersion: '4.20.0',
          }),
        },
      },
    });
    try {
      expect(browser.isBiDiEnabled()).toBe(true);
      await loginSmoke(browser);
      const png = await browser.screenshot();
      expect(png.length).toBeGreaterThan(0);
    } finally {
      await browser.quit();
    }
  });

  it('desktop Safari: BiDi not enabled, same flow', async () => {
    const browser = await Browser.launch({
      browserName: 'safari',
      remote: {
        url: HUB_URL,
        auth: auth(),
        sessionTimeoutMs: 120_000,
        commandTimeoutMs: 120_000,
        capabilities: {
          'bstack:options': bstackOptions('desktop-safari', {
            os: 'OS X',
            osVersion: 'Sonoma',
          }),
        },
      },
    });
    try {
      expect(browser.isBiDiEnabled()).toBe(false);
      await loginSmoke(browser);
    } finally {
      await browser.quit();
    }
  });

  it('desktop Chrome: uploads a local file via se/file and the input reflects it', async () => {
    const filePath = await writeTempUploadFile();
    const browser = await Browser.launch({
      browserName: 'chrome',
      remote: {
        url: HUB_URL,
        auth: auth(),
        sessionTimeoutMs: 120_000,
        commandTimeoutMs: 120_000,
        capabilities: {
          'bstack:options': bstackOptions('desktop-chrome-upload', {
            os: 'Windows',
            osVersion: '11',
          }),
        },
      },
    });
    try {
      await browser.navigateTo(UPLOAD_EXAMPLE_URL);
      await browser.find('#file-input').setInputFiles(filePath);
      await browser.expect('#result').toContainText('craftdriver-upload.txt');
    } finally {
      await browser.quit();
    }
  });
});

describe.skipIf(!RUN_MOBILE)(
  'BrowserStack — real-device smokes (opt-in: BROWSERSTACK_TEST_MOBILE=1)',
  () => {
    it('Android Chrome on a real device', async () => {
      const browser = await Browser.launch({
        browserName: 'chrome',
        remote: {
          url: HUB_URL,
          auth: auth(),
          sessionTimeoutMs: 120_000,
          commandTimeoutMs: 120_000,
          capabilities: {
            'bstack:options': bstackOptions('android-chrome-real-device', {
              deviceName: 'Samsung Galaxy S23',
              osVersion: '13.0',
              realMobile: true,
            }),
          },
        },
      });
      try {
        await loginSmoke(browser);
        await touchGesturesWithinViewport(browser);
      } finally {
        await browser.quit();
      }
    });

    it('iPhone Safari on a real device', async () => {
      const browser = await Browser.launch({
        browserName: 'safari',
        remote: {
          url: HUB_URL,
          auth: auth(),
          sessionTimeoutMs: 120_000,
          commandTimeoutMs: 120_000,
          capabilities: {
            'bstack:options': bstackOptions('iphone-safari-real-device', {
              deviceName: 'iPhone 15',
              osVersion: '17',
              realMobile: true,
            }),
          },
        },
      });
      try {
        await loginSmoke(browser);
        await touchGesturesWithinViewport(browser);
      } finally {
        await browser.quit();
      }
    });
  }
);

describe.skipIf(!RUN_LOCAL)(
  'BrowserStack Local (opt-in: BROWSERSTACK_TEST_LOCAL=1 + BROWSERSTACK_LOCAL_BINARY)',
  () => {
    it('drives a locally-hosted page through the tunnel', async () => {
      if (!LOCAL_BINARY) {
        throw new Error(
          'BROWSERSTACK_TEST_LOCAL=1 requires BROWSERSTACK_LOCAL_BINARY to point at a BrowserStackLocal ' +
            'binary (see https://www.browserstack.com/docs/automate/selenium/local-testing-introduction).'
        );
      }
      const localIdentifier = `craftdriver-${RUN_ID}`;
      const examplesServer = spawn(
        process.execPath,
        [
          require.resolve('http-server/bin/http-server'),
          './examples',
          '-a',
          '127.0.0.1',
          '-p',
          '8099',
          '-c-1',
        ],
        { stdio: 'ignore' }
      );
      const tunnel: ChildProcessWithoutNullStreams = spawn(LOCAL_BINARY, [
        '--key',
        ACCESS_KEY!,
        '--local-identifier',
        localIdentifier,
      ]);

      try {
        await waitForTunnelReady(tunnel);
        await waitForServerReady('http://127.0.0.1:8099/login.html');

        const browser = await Browser.launch({
          browserName: 'chrome',
          remote: {
            url: HUB_URL,
            auth: auth(),
            sessionTimeoutMs: 120_000,
            commandTimeoutMs: 120_000,
            capabilities: {
              'bstack:options': bstackOptions('browserstack-local', {
                os: 'Windows',
                osVersion: '11',
                local: true,
                localIdentifier,
              }),
            },
          },
        });
        try {
          await browser.navigateTo('http://127.0.0.1:8099/login.html');
          await browser.getByLabel('Username').fill('alice');
          await browser.getByLabel('Password').fill('secret');
          await browser.getByRole('button', { name: 'Sign in' }).click();
          await browser.expect('#welcome').toContainText('Welcome back, alice!');
        } finally {
          await browser.quit();
        }
      } finally {
        examplesServer.kill();
        tunnel.kill();
      }
    });
  }
);

function waitForTunnelReady(tunnel: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('BrowserStackLocal did not report ready in time')),
      30_000
    );
    tunnel.stdout.on('data', (chunk: Buffer) => {
      if (/connected/i.test(chunk.toString('utf8'))) {
        clearTimeout(timer);
        resolve();
      }
    });
    tunnel.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`BrowserStackLocal exited early (code ${code})`));
    });
  });
}

async function waitForServerReady(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`local examples server at ${url} did not become ready in time`);
}
