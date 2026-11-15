/**
 * Falling back from hybrid Chrome launch when the BiDi session fails to
 * initialize after the mapper started (initial subscription), i.e. later
 * than the mapper-start failure covered in hybrid-fallback.test.ts.
 *
 * Contract: nothing has reached the caller yet, so the default route cleans
 * up the hybrid attempt and launches through chromedriver; the
 * `CRAFTDRIVER_CHROME_LAUNCH_MODE=hybrid` override fails instead. Its own
 * file: a fallback is remembered per Chrome binary for the whole process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Browser, ErrorCode } from '../src';
import type { BiDiTransport } from '../src/lib/bidi/transport';
import { IS_CHROMIUM } from './utils';

const state = vi.hoisted(() => ({ failSubscribe: false, transports: [] as BiDiTransport[] }));

// This suite isolates initialization fallback, not version routing. The
// compatibility matrix also runs on Chrome majors above the verified range.
vi.mock('../src/lib/bidi/vendor/chromium-bidi-mapper.manifest.json', async (importOriginal) => {
  const real = (await importOriginal<{ default: Record<string, unknown> }>()).default;
  return { default: { ...real, chromeSupport: { minMajor: 0, maxMajor: 9999 } } };
});

// Answer the mapper's first `session.subscribe` with a BiDi error.
vi.mock('../src/lib/bidi/inProcessMapper', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/bidi/inProcessMapper')>();
  return {
    ...real,
    startInProcessMapper: async (...args: Parameters<typeof real.startInProcessMapper>) => {
      const transport = await real.startInProcessMapper(...args);
      state.transports.push(transport);
      let deliver: (data: string) => void = () => {};
      const wrapped: BiDiTransport = {
        send(message) {
          const { id, method } = JSON.parse(message) as { id: number; method: string };
          if (state.failSubscribe && method === 'session.subscribe') {
            const error = { type: 'error', id, error: 'unknown error', message: 'simulated' };
            queueMicrotask(() => deliver(JSON.stringify(error)));
            return;
          }
          transport.send(message);
        },
        onMessage(handler) {
          deliver = handler;
          transport.onMessage(handler);
        },
        onClose: (handler) => transport.onClose(handler),
        isOpen: () => transport.isOpen(),
        close: () => transport.close(),
      };
      return wrapped;
    },
  };
});

const ENV_KEY = 'CRAFTDRIVER_CHROME_LAUNCH_MODE';

function launchPath(browser: Browser): string {
  return (browser as unknown as { _chromeLaunchPath: string })._chromeLaunchPath;
}

describe.runIf(IS_CHROMIUM)('hybrid launch fallback after the mapper started', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    Object.assign(state, { failSubscribe: true, transports: [] });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it('rejects invalid storageState without fallback or disabling later hybrid launches', async () => {
    state.failSubscribe = false;
    await expect(
      Browser.launch({ browserName: 'chrome', storageState: 42 as never })
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_ARGUMENT });
    expect(state.transports).toHaveLength(1);
    expect(state.transports[0].isOpen()).toBe(false);
    expect(process.stderr.write).not.toHaveBeenCalled();

    const browser = await Browser.launch({ browserName: 'chrome' });
    try {
      expect(launchPath(browser)).toBe('hybrid');
      expect(state.transports).toHaveLength(2);
    } finally {
      await browser.quit();
    }
  });

  it('fails when the override forces hybrid, and cleans up the attempt', async () => {
    process.env[ENV_KEY] = 'hybrid';
    await expect(Browser.launch({ browserName: 'chrome' })).rejects.toThrow(/simulated/);
    expect(state.transports).toHaveLength(1);
    expect(state.transports[0].isOpen()).toBe(false);
  });

  it('launches through chromedriver by default, and cleans up the attempt', async () => {
    const browser = await Browser.launch({ browserName: 'chrome' });
    try {
      expect(launchPath(browser)).toBe('chromedriver');
      expect(browser.isBiDiEnabled()).toBe(true);
      expect(await browser.evaluate(() => 1 + 1)).toBe(2);
    } finally {
      await browser.quit();
    }
    expect(state.transports).toHaveLength(1);
    expect(state.transports[0].isOpen()).toBe(false);

    // The later initialization failure must be remembered for this binary,
    // just as a mapper-start failure is, rather than retried on every launch.
    const next = await Browser.launch({ browserName: 'chrome' });
    try {
      expect(launchPath(next)).toBe('chromedriver');
      expect(state.transports).toHaveLength(1);
    } finally {
      await next.quit();
    }
  });
});
