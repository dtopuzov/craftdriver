/**
 * Falling back from hybrid Chrome launch to chromedriver.
 *
 * Contract: a Chrome version or a hybrid-launch failure never fails
 * `Browser.launch`. Outside the verified Chrome range the fallback is silent
 * (`CRAFTDRIVER_DEBUG=1` shows it); a failed hybrid launch prints one notice
 * per process, and later launches skip the failing attempt. The
 * `CRAFTDRIVER_CHROME_LAUNCH_MODE=hybrid` override disables both fallbacks.
 *
 * The verified range (manifest) and the mapper start are mocked, so the
 * installed Chrome can land outside the range and hybrid can fail on demand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Browser } from '../src';
import { IS_CHROMIUM } from './utils';

const state = vi.hoisted(() => ({ min: 0, max: 9999, failMapper: false, mapperStarts: 0 }));

vi.mock('../src/lib/bidi/vendor/chromium-bidi-mapper.manifest.json', async (importOriginal) => {
  const real = (await importOriginal<{ default: Record<string, unknown> }>()).default;
  return {
    default: {
      ...real,
      chromeSupport: {
        get minMajor() {
          return state.min;
        },
        get maxMajor() {
          return state.max;
        },
      },
    },
  };
});

vi.mock('../src/lib/bidi/inProcessMapper', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/bidi/inProcessMapper')>();
  return {
    ...real,
    startInProcessMapper: (...args: Parameters<typeof real.startInProcessMapper>) => {
      state.mapperStarts++;
      if (state.failMapper) return Promise.reject(new Error('simulated mapper failure'));
      return real.startInProcessMapper(...args);
    },
  };
});

const ENV_KEYS = ['CRAFTDRIVER_CHROME_LAUNCH_MODE', 'CRAFTDRIVER_DEBUG'];

function launchPath(browser: Browser): string {
  return (browser as unknown as { _chromeLaunchPath: string })._chromeLaunchPath;
}

async function launchAndCheck(expected: 'hybrid' | 'chromedriver'): Promise<void> {
  const browser = await Browser.launch({ browserName: 'chrome' });
  try {
    expect(launchPath(browser)).toBe(expected);
    expect(await browser.evaluate(() => 1 + 1)).toBe(2);
  } finally {
    await browser.quit();
  }
}

describe.runIf(IS_CHROMIUM)('hybrid launch fallback', () => {
  let savedEnv: Record<string, string | undefined>;
  let stderr: string[];

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(state, { min: 0, max: 9999, failMapper: false, mapperStarts: 0 });
    stderr = [];
    const write = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk, ...rest) => {
      if (String(chunk).startsWith('[craftdriver')) stderr.push(String(chunk));
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

  it('silently uses chromedriver on a Chrome newer than the verified range', async () => {
    state.max = 1;
    // First: Chrome is launched before its version is known, then dropped.
    // The second launch knows the version and does not start Chrome again.
    await launchAndCheck('chromedriver');
    await launchAndCheck('chromedriver');
    expect(state.mapperStarts).toBe(0);
    expect(stderr.filter((l) => l.startsWith('[craftdriver]'))).toEqual([]);
  });

  it('uses hybrid by default on a verified Chrome', async () => {
    await launchAndCheck('hybrid');
  });

  it('silently uses chromedriver on a Chrome older than the verified range', async () => {
    Object.assign(state, { min: 9998, max: 9999 });
    await launchAndCheck('chromedriver');
    expect(stderr.filter((l) => l.startsWith('[craftdriver]'))).toEqual([]);
  });

  it('explains the choice with CRAFTDRIVER_DEBUG=1', async () => {
    state.max = 1;
    process.env.CRAFTDRIVER_DEBUG = '1';
    await launchAndCheck('chromedriver');
    expect(stderr.join('')).toMatch(
      /\[craftdriver:chrome\] launch=chromedriver \(Chrome \d+ is outside the Chrome versions verified for hybrid launch \(0-1\)\)/
    );
  });

  it('runs hybrid on any Chrome version when the override forces it', async () => {
    state.max = 1;
    process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE = 'hybrid';
    await launchAndCheck('hybrid');
  });

  it('throws instead of falling back when the override forces hybrid', async () => {
    state.failMapper = true;
    process.env.CRAFTDRIVER_CHROME_LAUNCH_MODE = 'hybrid';
    await expect(Browser.launch({ browserName: 'chrome' })).rejects.toThrow(
      /simulated mapper failure/
    );
  });

  // Last: a failure is remembered for this Chrome binary for the rest of the process.
  it('falls back once with a notice when hybrid fails, then skips it', async () => {
    state.failMapper = true;
    await launchAndCheck('chromedriver');
    await launchAndCheck('chromedriver');
    expect(state.mapperStarts).toBe(1);
    const notices = stderr.filter((l) => l.startsWith('[craftdriver]'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(
      /Hybrid Chrome launch failed, using chromedriver instead: .*simulated mapper failure/
    );
    expect(notices[0]).toMatch(/CRAFTDRIVER_CHROME_LAUNCH_MODE=chromedriver/);
  });
});
