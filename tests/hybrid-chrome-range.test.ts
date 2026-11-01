/**
 * Hybrid launch outside the verified Chrome range. The range comes from the
 * mapper manifest; it is mocked here so the installed Chrome lands above or
 * below it.
 *
 * Contract: an env-requested hybrid launch never fails because of the Chrome
 * version (it falls back to chromedriver with a one-time notice). An explicit
 * `chromeLaunchMode: 'hybrid'` runs on an unverified newer Chrome with a
 * warning, and throws below the supported floor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Browser } from '../src';
import { CraftdriverError, ErrorCode } from '../src/lib/errors';
import { IS_CHROMIUM } from './utils';

const range = vi.hoisted(() => ({ min: 0, max: 1 }));

vi.mock('../src/lib/bidi/vendor/chromium-bidi-mapper.manifest.json', async (importOriginal) => {
  const real = (await importOriginal<{ default: Record<string, unknown> }>()).default;
  return {
    default: {
      ...real,
      chromeSupport: {
        get minMajor() {
          return range.min;
        },
        get maxMajor() {
          return range.max;
        },
      },
    },
  };
});

const ENV_KEYS = ['CRAFTDRIVER_CHROME_LAUNCH_MODE', 'CRAFTDRIVER_CHROME_HYBRID_ANY_VERSION'];

function launchPath(browser: Browser): string {
  return (browser as unknown as { _chromeLaunchPath: string })._chromeLaunchPath;
}

describe.runIf(IS_CHROMIUM)('hybrid launch outside the verified Chrome range', () => {
  let savedEnv: Record<string, string | undefined>;
  let notices: string[];

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    notices = [];
    const write = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk, ...rest) => {
      if (String(chunk).startsWith('[craftdriver]')) notices.push(String(chunk));
      return write(chunk, ...(rest as []));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('env hybrid on a newer Chrome falls back to chromedriver, noticing once', async () => {
    Object.assign(range, { min: 0, max: 1 });
    process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE = 'hybrid';
    // The second launch already knows the Chrome version and skips the
    // wasted Chrome start; both must end on chromedriver and work.
    for (let i = 0; i < 2; i++) {
      const browser = await Browser.launch({ browserName: 'chrome' });
      try {
        expect(launchPath(browser)).toBe('chromedriver');
        expect(await browser.evaluate(() => 1 + 1)).toBe(2);
      } finally {
        await browser.quit();
      }
    }
    const fallback = notices.filter((n) => n.includes('newer than the newest Chrome'));
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatch(/verified for hybrid launch \(1\)\. .*Using chromedriver\./);
  });

  it('env hybrid on an older Chrome falls back to chromedriver', async () => {
    Object.assign(range, { min: 9999, max: 9999 });
    process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE = 'hybrid';
    const browser = await Browser.launch({ browserName: 'chrome' });
    try {
      expect(launchPath(browser)).toBe('chromedriver');
    } finally {
      await browser.quit();
    }
    expect(notices.some((n) => /needs Chrome 9999 or newer.*Using chromedriver\./.test(n))).toBe(
      true
    );
  });

  it('explicit hybrid on a newer Chrome runs hybrid with a warning', async () => {
    Object.assign(range, { min: 0, max: 1 });
    const browser = await Browser.launch({ browserName: 'chrome', chromeLaunchMode: 'hybrid' });
    try {
      expect(launchPath(browser)).toBe('hybrid');
      expect(await browser.evaluate(() => 1 + 1)).toBe(2);
    } finally {
      await browser.quit();
    }
    expect(notices.some((n) => n.includes("Continuing because chromeLaunchMode is 'hybrid'"))).toBe(
      true
    );
  });

  it('explicit hybrid on an older Chrome throws UNSUPPORTED', async () => {
    Object.assign(range, { min: 9999, max: 9999 });
    const err = await Browser.launch({ browserName: 'chrome', chromeLaunchMode: 'hybrid' }).then(
      async (b) => {
        await b.quit();
        return undefined;
      },
      (e: unknown) => e
    );
    expect(CraftdriverError.is(err, ErrorCode.UNSUPPORTED)).toBe(true);
    expect((err as Error).message).toMatch(/needs Chrome 9999 or newer/);
  });

  it('CRAFTDRIVER_CHROME_HYBRID_ANY_VERSION=1 runs hybrid on any version', async () => {
    Object.assign(range, { min: 0, max: 1 });
    process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE = 'hybrid';
    process.env.CRAFTDRIVER_CHROME_HYBRID_ANY_VERSION = '1';
    const browser = await Browser.launch({ browserName: 'chrome' });
    try {
      expect(launchPath(browser)).toBe('hybrid');
    } finally {
      await browser.quit();
    }
  });
});
