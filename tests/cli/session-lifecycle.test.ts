/**
 * Session lifecycle: recovering from a failed launch, and what `quit` clears.
 *
 * Two failures motivated these. A rejected launch was cached as a rejected
 * promise, so one missing driver poisoned the session and every later command
 * replayed the same stale error. And `quit` reset refs but kept trace and
 * mock metadata and journal history, so the session went on describing a
 * browser that no longer existed.
 *
 * These drive the dispatcher against a stub browser: the contract is about
 * session bookkeeping, not about anything a real browser does.
 */
import { describe, it, expect, vi } from 'vitest';
import { createBrowserHandle, dispatch, resetBrowserOwnedState } from '../../src/cli/dispatcher';
import type { DispatchContext } from '../../src/cli/dispatcher';
import { SnapshotTracker } from '../../src/cli/snapshot';
import { SessionJournal } from '../../src/cli/journal';
import { INTERNAL_EVALUATE_CLASSIC, type Browser } from '../../src/lib/browser';

type LogListener = (message: Record<string, unknown>) => void;

/**
 * Minimal stand-in. `logs.onLog` is captured so a test can emit a console
 * message through the journal's real capture path; `network` throws, which
 * `attach` treats as "no BiDi" and tolerates.
 */
function fakeBrowser(): { browser: Browser; emitLog: (text: string) => void } {
  let listener: LogListener | null = null;
  const browser = {
    quit: async () => undefined,
    get logs() {
      return { onLog: (cb: LogListener) => { listener = cb; return () => { listener = null; }; } };
    },
    get network(): never {
      throw new Error('no BiDi');
    },
  } as unknown as Browser;

  return {
    browser,
    emitLog: (text: string) => {
      listener?.({
        type: 'console',
        method: 'log',
        level: 'info',
        text,
        timestamp: new Date(),
      });
    },
  };
}

function context(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    handle: createBrowserHandle(async () => fakeBrowser().browser),
    launchOptions: {},
    tracker: new SnapshotTracker(),
    ...overrides,
  };
}

describe('browser handle recovery', () => {
  it('retries after a failed launch instead of caching the rejection', async () => {
    let attempts = 0;
    const handle = createBrowserHandle(async () => {
      attempts++;
      // Fail once, as a missing driver or a busy port would.
      if (attempts === 1) throw new Error('chromedriver not found');
      return fakeBrowser().browser;
    });

    await expect(handle.get()).rejects.toThrow('chromedriver not found');
    // Before the fix this replayed the same rejected promise forever, and the
    // only way out was closing the session.
    await expect(handle.get()).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  it('shares one launch between concurrent callers', async () => {
    let launches = 0;
    const handle = createBrowserHandle(async () => {
      launches++;
      return fakeBrowser().browser;
    });

    await Promise.all([handle.get(), handle.get(), handle.get()]);
    expect(launches).toBe(1);
  });

  it('reports no browser through peek() after a failed launch', async () => {
    const handle = createBrowserHandle(async () => { throw new Error('nope'); });
    await expect(handle.get()).rejects.toThrow();
    expect(handle.peek()).toBeNull();
  });
});

describe('go result recovery', () => {
  it('falls back to context-aware page reads when the Classic probe loses its realm', async () => {
    const page = {
      url: vi.fn().mockResolvedValue('https://example.test/destination'),
      title: vi.fn().mockResolvedValue('Destination'),
    };
    const browser = {
      navigateTo: vi.fn().mockResolvedValue(undefined),
      [INTERNAL_EVALUATE_CLASSIC]: vi
        .fn()
        .mockRejectedValue(new Error('execution context was destroyed')),
      activePage: vi.fn().mockResolvedValue(page),
    } as unknown as Browser;
    const ctx = context({ handle: createBrowserHandle(async () => browser) });

    await expect(dispatch(ctx, 'go', { url: 'https://example.test/start' })).resolves.toEqual({
      url: 'https://example.test/destination',
      title: 'Destination',
    });
    expect(browser.navigateTo).toHaveBeenCalledWith('https://example.test/start');
    expect(browser[INTERNAL_EVALUATE_CLASSIC]).toHaveBeenCalledOnce();
    expect(page.url).toHaveBeenCalledOnce();
    expect(page.title).toHaveBeenCalledOnce();
  });
});

describe('quit clears state that belonged to the closed browser', () => {
  it('drops trace metadata and mocks', async () => {
    const ctx = context({
      activeTrace: { name: 'run-1', outDir: '/tmp/t', startedAt: new Date().toISOString() },
      mocks: [{ id: 'm1', pattern: '/api', kind: 'mock', status: 200 }],
    });
    await ctx.handle.get();

    await dispatch(ctx, 'quit');

    // Both previously survived into a browser that never installed them:
    // `trace status` claimed a dead trace was running, and `mock list`
    // reported intercepts that no longer existed.
    expect(ctx.activeTrace).toBeNull();
    expect(ctx.mocks).toEqual([]);
  });

  it('drops journal history so the old browser does not log into the new one', async () => {
    const journal = new SessionJournal();
    const fake = fakeBrowser();
    const ctx = context({
      journal,
      handle: createBrowserHandle(async () => {
        journal.attach(fake.browser);
        return fake.browser;
      }),
    });

    await ctx.handle.get();
    fake.emitLog('from the old browser');
    expect(journal.query({ limit: 50 }).entries).toHaveLength(1);

    await dispatch(ctx, 'quit');

    expect(journal.query({ limit: 50 }).entries).toHaveLength(0);
  });

  it('drops the snapshot baseline so no ref survives the browser', async () => {
    const ctx = context();
    await ctx.handle.get();
    await dispatch(ctx, 'quit');
    expect(ctx.tracker.documentId).toBeNull();
  });

  it('keeps the ref high-water mark so numbers are never reissued', async () => {
    const ctx = context();
    const before = ctx.tracker.minRef;
    await ctx.handle.get();
    await dispatch(ctx, 'quit');
    expect(ctx.tracker.minRef).toBeGreaterThanOrEqual(before);
  });

  it('releases journal waiters rather than leaving them to time out', async () => {
    const journal = new SessionJournal();
    const ctx = context({ journal });
    await ctx.handle.get();

    const waiter = journal.waitFor({ contains: 'never arrives' }, 30_000);
    await dispatch(ctx, 'quit');

    // A caller blocked on an event the dead browser can no longer emit must
    // come back immediately, not sit out the full timeout.
    await expect(waiter).resolves.toBeNull();
  });

  it('leaves a session usable after quit', async () => {
    const ctx = context();
    await ctx.handle.get();
    await dispatch(ctx, 'quit');
    // Lazily relaunches into a fresh browser.
    await expect(ctx.handle.get()).resolves.toBeDefined();
  });
});

describe('resetBrowserOwnedState', () => {
  it('is safe on a context with no journal', () => {
    const ctx = context();
    expect(() => resetBrowserOwnedState(ctx)).not.toThrow();
  });
});
