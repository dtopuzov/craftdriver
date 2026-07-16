/** Live Selenium Grid coverage for the generic remote path. */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Browser } from '../../src/index.js';

const GRID_URL = process.env.SELENIUM_GRID_URL;
const BROWSER = process.env.SELENIUM_GRID_BROWSER ?? 'chrome';
const EXAMPLES_BASE_URL =
  process.env.SELENIUM_GRID_EXAMPLES_URL ?? 'https://dtopuzov.github.io/craftdriver/examples';

// Remote launches need explicit vendor options for headless mode.
const HEADLESS = process.env.HEADLESS === 'true' || process.env.HEADLESS === '1';

function headlessCapabilities(browser: string): Record<string, unknown> {
  if (!HEADLESS) return {};
  switch (browser.toLowerCase()) {
    case 'chrome':
    case 'chromium':
      return {
        'goog:chromeOptions': {
          args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
        },
      };
    case 'edge':
    case 'msedge':
    case 'microsoftedge':
      return {
        'ms:edgeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] },
      };
    case 'firefox':
      return { 'moz:firefoxOptions': { args: ['-headless'] } };
    default:
      return {};
  }
}

// These engine families are expected to provide BiDi in the pinned CI Grid.
const BIDI_EXPECTED = ['chrome', 'chromium', 'firefox', 'edge', 'msedge', 'microsoftedge'].includes(
  BROWSER.toLowerCase()
);

const LOGIN_EXAMPLE_URL = `${EXAMPLES_BASE_URL}/login.html`;
const UPLOAD_EXAMPLE_URL = `${EXAMPLES_BASE_URL}/upload.html`;

beforeAll(() => {
  // Never silently skip and report green — a missing URL means the suite is
  // meaningless, not "0 tests, exit 0".
  if (!GRID_URL) {
    throw new Error(
      'npm run test:grid requires SELENIUM_GRID_URL — the WebDriver endpoint of a running ' +
        'Selenium Grid, e.g. SELENIUM_GRID_URL=http://192.168.0.10:4444 (the Grid root or its ' +
        '/wd/hub path, NOT the /ui/ console). This suite drives a real Grid and never runs ' +
        'without it.'
    );
  }
});

function launch(): Promise<Browser> {
  return Browser.launch({
    browserName: BROWSER,
    remote: {
      url: GRID_URL!,
      // Cold nodes may need time to resolve a driver and start the browser.
      sessionTimeoutMs: 120_000,
      commandTimeoutMs: 60_000,
      capabilities: headlessCapabilities(BROWSER),
    },
  } as unknown as Parameters<typeof Browser.launch>[0]);
}

async function loginSmoke(browser: Browser): Promise<void> {
  await browser.navigateTo(LOGIN_EXAMPLE_URL);
  await browser.getByLabel('Username').fill('alice');
  await browser.getByLabel('Password').fill('secret');
  await browser.getByRole('button', { name: 'Sign in' }).click();
  await browser.expect('#welcome').toContainText('Welcome back, alice!');
}

async function writeTempUploadFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'craftdriver-grid-upload-'));
  const filePath = path.join(dir, 'craftdriver-upload.txt');
  await fs.writeFile(filePath, 'craftdriver grid upload smoke', 'utf8');
  return filePath;
}

describe(`Selenium Grid — ${BROWSER} smokes`, () => {
  it('session → navigate → interact → assert → screenshot', async () => {
    const browser = await launch();
    try {
      await loginSmoke(browser);
      const png = await browser.screenshot();
      expect(png.length).toBeGreaterThan(0);
    } finally {
      await browser.quit();
    }
  });

  it('parallel sessions against one Grid stay isolated (quit one, drive the other)', async () => {
    const a = await launch();
    const b = await launch();
    try {
      await a.quit();
      // Quitting one session must not close the other's connection pool.
      await expect(b.navigateTo(LOGIN_EXAMPLE_URL)).resolves.toBeUndefined();
      await b.getByLabel('Username').fill('bob');
    } finally {
      await b.quit().catch(() => {});
    }
  });

  it('uploads a local file via se/file and the input reflects it', async () => {
    const filePath = await writeTempUploadFile();
    const browser = await launch();
    try {
      await browser.navigateTo(UPLOAD_EXAMPLE_URL);
      await browser.find('#file-input').setInputFiles(filePath);
      await browser.expect('#result').toContainText('craftdriver-upload.txt');
    } finally {
      await browser.quit();
    }
  });
});

describe.skipIf(!BIDI_EXPECTED)(`Selenium Grid — ${BROWSER} BiDi relay`, () => {
  it('negotiates BiDi over the Grid and drives a BiDi-only feature (fullPage screenshot)', async () => {
    const browser = await launch();
    try {
      expect(browser.isBiDiEnabled()).toBe(true);
      await browser.navigateTo(LOGIN_EXAMPLE_URL);
      const png = await browser.screenshot({ fullPage: true });
      expect(png.length).toBeGreaterThan(0);
    } finally {
      await browser.quit();
    }
  });
});
