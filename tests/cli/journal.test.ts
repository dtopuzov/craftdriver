/**
 * Journal bounds, cursors, filters, waits and cleanup.
 *
 * Browser-free: the journal's contract is about bookkeeping, so it is driven
 * through a fake that hands back the event callbacks. That keeps eviction and
 * cursor arithmetic testable at every boundary, which a real browser cannot
 * be made to hit on demand.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Browser } from '../../src/lib/browser.js';
import {
  SessionJournal,
  MAX_JOURNAL_ENTRIES,
  MAX_ENTRY_TEXT,
  type JournalEntry,
} from '../../src/cli/journal.js';

type LogHandler = (m: Record<string, unknown>) => void;
type NetHandler = (e: Record<string, unknown>) => void;

interface Fake {
  browser: Browser;
  emitLog: LogHandler;
  emitRequest: NetHandler;
  emitResponse: NetHandler;
  offCalls: () => number;
}

/** A Browser-shaped stub exposing only what the journal touches. */
function fakeBrowser(opts: { bidi?: boolean } = {}): Fake {
  const bidi = opts.bidi !== false;
  let logHandler: LogHandler = () => {};
  let reqHandler: NetHandler = () => {};
  let resHandler: NetHandler = () => {};
  let offs = 0;
  const off = (): void => {
    offs++;
  };

  const browser = {
    get logs() {
      if (!bidi) throw new Error('Log monitoring requires BiDi');
      return {
        onLog(h: LogHandler) {
          logHandler = h;
          return off;
        },
      };
    },
    get network() {
      if (!bidi) throw new Error('Network interception requires BiDi');
      return {
        on(event: string, h: NetHandler) {
          if (event === 'request') reqHandler = h;
          else resHandler = h;
          return off;
        },
      };
    },
  } as unknown as Browser;

  return {
    browser,
    emitLog: (m) => logHandler(m),
    emitRequest: (e) => reqHandler(e),
    emitResponse: (e) => resHandler(e),
    offCalls: () => offs,
  };
}

const consoleMsg = (text: string, level = 'info', method = 'log'): Record<string, unknown> => ({
  type: 'console',
  level,
  method,
  text,
  timestamp: new Date(),
  args: [],
});

const jsError = (text: string): Record<string, unknown> => ({
  type: 'javascript',
  level: 'error',
  text,
  timestamp: new Date(),
  stackTrace: [{ functionName: 'f', url: 'https://x.test/a.js', lineNumber: 12, columnNumber: 3 }],
});

let journal: SessionJournal;
let fake: Fake;

beforeEach(() => {
  journal = new SessionJournal();
  fake = fakeBrowser();
  journal.attach(fake.browser);
});

describe('capture', () => {
  it('records console messages and JavaScript errors as distinct kinds', () => {
    fake.emitLog(consoleMsg('hello'));
    fake.emitLog(jsError('boom'));

    const { entries } = journal.query();
    expect(entries.map((e) => e.kind)).toEqual(['console', 'error']);
    expect((entries[1] as { origin?: string }).origin).toBe('https://x.test/a.js:12');
  });

  it('records network requests and responses without headers or bodies', () => {
    fake.emitRequest({
      url: 'https://api.test/users',
      method: 'GET',
      headers: { authorization: 'Bearer super-secret' },
      context: 'ctx-1',
    });
    fake.emitResponse({
      url: 'https://api.test/users',
      status: 200,
      mimeType: 'application/json',
      headers: { 'set-cookie': 'session=secret' },
      request: { id: 'r1', url: 'https://api.test/users', method: 'GET', headers: {} },
    });

    const { entries } = journal.query();
    expect(entries).toHaveLength(2);
    // The real requirement: nothing an agent pastes onward can carry a
    // credential, so assert against the serialized page.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('session=secret');
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('set-cookie');
    expect(entries[1]).toMatchObject({ kind: 'response', status: 200, method: 'GET' });
  });

  it('truncates an over-long message instead of retaining it whole', () => {
    fake.emitLog(consoleMsg('x'.repeat(MAX_ENTRY_TEXT + 500)));
    const text = (journal.query().entries[0] as { text: string }).text;
    expect(text.length).toBeLessThan(MAX_ENTRY_TEXT + 100);
    expect(text).toMatch(/more chars\)$/);
  });

  it('stays off, without throwing, when the browser has no BiDi', () => {
    const offline = new SessionJournal();
    offline.attach(fakeBrowser({ bidi: false }).browser);
    expect(offline.isCapturing).toBe(false);
    expect(offline.query().entries).toEqual([]);
  });
});

describe('cursors', () => {
  it('numbers entries monotonically and reports the high-water mark', () => {
    fake.emitLog(consoleMsg('a'));
    fake.emitLog(consoleMsg('b'));

    const first = journal.query();
    expect(first.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.cursor).toBe(2);

    fake.emitLog(consoleMsg('c'));
    const next = journal.query({ since: first.cursor });
    expect(next.entries.map((e) => (e as { text: string }).text)).toEqual(['c']);
    expect(next.cursor).toBe(3);
  });

  it('returns nothing when nothing happened since the cursor', () => {
    fake.emitLog(consoleMsg('a'));
    const { cursor } = journal.query();
    expect(journal.query({ since: cursor }).entries).toEqual([]);
  });

  it('does not reuse sequence numbers after a clear', () => {
    fake.emitLog(consoleMsg('a'));
    const { cursor } = journal.query();
    journal.clear();
    fake.emitLog(consoleMsg('b'));

    // A cursor an agent still holds must not start matching new entries.
    const after = journal.query({ since: cursor });
    expect(after.entries.map((e) => e.seq)).toEqual([2]);
  });
});

describe('bounds and eviction', () => {
  it('evicts oldest-first past the entry cap and counts the loss', () => {
    for (let i = 0; i < MAX_JOURNAL_ENTRIES + 25; i++) fake.emitLog(consoleMsg(`m${i}`));

    const page = journal.query();
    expect(page.entries).toHaveLength(MAX_JOURNAL_ENTRIES);
    expect(page.dropped).toBe(25);
    // The oldest survivor is the 26th message, not the first.
    expect((page.entries[0] as { text: string }).text).toBe('m25');
  });

  it('tells a reader when their cursor points into a hole', () => {
    fake.emitLog(consoleMsg('old'));
    const { cursor } = journal.query();

    for (let i = 0; i < MAX_JOURNAL_ENTRIES + 50; i++) fake.emitLog(consoleMsg(`m${i}`));

    // "no errors" and "the errors fell off the end" must not look alike.
    const page = journal.query({ since: cursor });
    expect(page.dropped).toBeGreaterThan(0);
    expect(page.droppedBeforeCursor).toBeGreaterThan(0);
  });

  it('evicts on the byte cap even when the entry count is fine', () => {
    // Each message is near the per-entry cap, so the byte cap binds first.
    const big = 'y'.repeat(MAX_ENTRY_TEXT);
    for (let i = 0; i < 400; i++) fake.emitLog(consoleMsg(big));

    const page = journal.query();
    expect(page.entries.length).toBeLessThan(400);
    expect(page.dropped).toBeGreaterThan(0);
  });

  it('caps a query with limit, keeping the newest', () => {
    for (let i = 0; i < 20; i++) fake.emitLog(consoleMsg(`m${i}`));
    const page = journal.query({ limit: 5 });
    expect(page.truncated).toBe(true);
    expect((page.entries[4] as { text: string }).text).toBe('m19');
  });
});

describe('filters', () => {
  beforeEach(() => {
    fake.emitLog(consoleMsg('a warning here', 'warn', 'warn'));
    fake.emitLog(jsError('reference error'));
    fake.emitRequest({ url: 'https://api.test/orders', method: 'POST' });
  });

  it('filters by kind', () => {
    expect(journal.query({ kinds: ['console', 'error'] }).entries).toHaveLength(2);
    expect(journal.query({ kinds: ['request'] }).entries).toHaveLength(1);
  });

  // Asking for errors must not miss a console.error. Returning nothing on a
  // page that loudly logged one reads as "the page was quiet", which is the
  // single most misleading answer this can give.
  it('treats console.error as an error, alongside uncaught exceptions', () => {
    fake.emitLog(consoleMsg('this one is shouted', 'error', 'error'));

    const errors = journal.query({ kinds: ['error'] });
    expect(errors.entries).toHaveLength(2);
    expect(errors.entries.map((e) => e.kind).sort()).toEqual(['console', 'error']);
  });

  it('does not sweep non-error console output into the error filter', () => {
    // The widening is level-scoped, not "any console entry".
    expect(
      journal.query({ kinds: ['error'] }).entries.every(
        (e) => e.kind === 'error' || ('level' in e && e.level === 'error'),
      ),
    ).toBe(true);
  });

  it('applies the same filter whether you poll or wait', async () => {
    fake.emitLog(consoleMsg('shouted later', 'error', 'error'));
    // waitFor and query shared a duplicated predicate; a filter that behaved
    // differently between them would be a genuinely confusing bug.
    const waited = await journal.waitFor({ kinds: ['error'], contains: 'shouted later' }, 50);
    expect(waited).not.toBeNull();
  });

  it('filters by console level', () => {
    expect(journal.query({ level: 'warn' }).entries).toHaveLength(1);
  });

  it('matches text and URL with one contains filter', () => {
    expect(journal.query({ contains: 'warning' }).entries).toHaveLength(1);
    expect(journal.query({ contains: 'ORDERS' }).entries).toHaveLength(1);
  });
});

describe('waiting', () => {
  // The defect this module exists to fix: by the time an agent asks, the event
  // has usually already arrived.
  it('resolves from what is already buffered', async () => {
    fake.emitLog(consoleMsg('already here'));
    const found = await journal.waitFor({ contains: 'already here' }, 50);
    expect(found).not.toBeNull();
    expect((found as { text: string }).text).toBe('already here');
  });

  it('resolves when a matching entry arrives later', async () => {
    const pending = journal.waitFor({ contains: 'later' }, 2_000);
    fake.emitLog(consoleMsg('arrives later'));
    expect(await pending).not.toBeNull();
  });

  it('honours since, so an old match does not satisfy a new wait', async () => {
    fake.emitLog(consoleMsg('ping'));
    const { cursor } = journal.query();
    // The buffered "ping" is at or below the cursor, so it must not count.
    expect(await journal.waitFor({ contains: 'ping', since: cursor }, 50)).toBeNull();
  });

  it('returns null on timeout rather than throwing', async () => {
    expect(await journal.waitFor({ contains: 'never' }, 50)).toBeNull();
  });

  it('releases a pending waiter on detach instead of hanging it', async () => {
    const pending = journal.waitFor({ contains: 'never' }, 60_000);
    journal.detach();
    // Without this the caller would block for the full timeout on shutdown.
    expect(await pending).toBeNull();
  });
});

describe('cleanup', () => {
  it('clear empties the buffer but keeps capturing', () => {
    fake.emitLog(consoleMsg('a'));
    journal.clear();
    expect(journal.query().entries).toEqual([]);

    fake.emitLog(consoleMsg('b'));
    expect(journal.query().entries).toHaveLength(1);
  });

  it('detach unsubscribes every listener and stops capture', () => {
    journal.detach();
    expect(journal.isCapturing).toBe(false);
    // console + request + response
    expect(fake.offCalls()).toBe(3);
  });

  it('attach is idempotent for the same browser, so nothing double-records', () => {
    journal.attach(fake.browser);
    fake.emitLog(consoleMsg('once'));
    expect(journal.query().entries).toHaveLength(1);
  });

  // `quit` closes the browser and a later command launches a new one. If
  // attach stayed a no-op because it had already run, capture would be
  // silently dead for the rest of the session — the journal would keep
  // answering, with nothing in it.
  it('re-attaches when the session launches a different browser', () => {
    const relaunched = fakeBrowser();
    journal.attach(relaunched.browser);

    relaunched.emitLog(consoleMsg('after relaunch'));
    const entries = journal.query().entries;
    expect(entries).toHaveLength(1);
    expect((entries[0] as { text: string }).text).toBe('after relaunch');
  });

  it('drops the old browser listeners when it re-attaches', () => {
    const relaunched = fakeBrowser();
    journal.attach(relaunched.browser);
    // The first browser is gone; anything still wired to it is a leak.
    expect(fake.offCalls()).toBe(3);
  });
});

describe('entry shape', () => {
  it('carries a serializable time and no live objects', () => {
    fake.emitLog(consoleMsg('a'));
    const entry = journal.query().entries[0] as JournalEntry;
    expect(typeof entry.time).toBe('string');
    expect(() => JSON.stringify(entry)).not.toThrow();
  });
});
