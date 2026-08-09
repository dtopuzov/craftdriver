/**
 * `expect no-errors` — the three outcomes, with fakes.
 *
 * `agent-expect.test.ts` drives this against a real page. What a real page
 * cannot be made to do on demand is fail the ordering barrier, or evict
 * exactly one error and keep three, and those are the cases where a verdict
 * command is at its most dangerous: an unfounded green is worse than no check
 * at all, because a batch and a CI gate read the status and nothing else.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Browser } from '../../src/lib/browser.js';
import { CraftdriverError, ErrorCode } from '../../src/lib/errors.js';
import { expectNoErrors } from '../../src/cli/expectVerdict.js';
import { SessionJournal, MAX_JOURNAL_ENTRIES } from '../../src/cli/journal.js';

type LogHandler = (m: Record<string, unknown>) => void;

/** Only the two things `expectNoErrors` touches: the journal feed, and the barrier. */
function fakeBrowser(opts: { barrier?: 'ok' | 'reject' } = {}) {
  let logHandler: LogHandler = () => {};
  const browser = {
    get logs() {
      return {
        onLog(h: LogHandler) {
          logHandler = h;
          return () => {};
        },
      };
    },
    get network() {
      return { on: () => () => {} };
    },
    activePage: async () => {
      if (opts.barrier === 'reject') throw new Error('no such window: target window already closed');
      return { url: async () => 'https://x.test/' };
    },
  } as unknown as Browser;
  return { browser, emitLog: (m: Record<string, unknown>) => logHandler(m) };
}

const jsError = (text: string): Record<string, unknown> => ({
  type: 'javascript',
  level: 'error',
  text,
  timestamp: new Date(),
});

const chatter = (text: string): Record<string, unknown> => ({
  type: 'console',
  level: 'info',
  method: 'log',
  text,
  timestamp: new Date(),
});

let journal: SessionJournal;

beforeEach(() => {
  journal = new SessionJournal();
});

async function failureOf(browser: Browser, since = 0): Promise<CraftdriverError> {
  try {
    await expectNoErrors(browser, journal, since);
  } catch (error) {
    if (!CraftdriverError.is(error)) throw error;
    return error;
  }
  throw new Error('expect no-errors passed, but the test needed it to fail');
}

describe('expect no-errors', () => {
  it('passes on a quiet page, once delivery is confirmed', async () => {
    const { browser, emitLog } = fakeBrowser();
    journal.attach(browser);
    emitLog(chatter('just talking'));

    await expect(expectNoErrors(browser, journal, 0)).resolves.toMatchObject({
      ok: true,
      matcher: 'no-errors',
      errors: 0,
    });
  });

  it('refuses to pass when the barrier could not be taken', async () => {
    // The driver would not answer, so an error the page logged may still be in
    // flight. An unconfirmed zero is not the affirmative answer a green
    // verdict claims to be — and this is the shape a closed window takes.
    const { browser } = fakeBrowser({ barrier: 'reject' });
    journal.attach(browser);

    const failure = await failureOf(browser);
    expect(failure.code).toBe(ErrorCode.STATE_INVALID);
    expect(failure.message).toContain('would not confirm');
    expect(failure.detail).toMatchObject({ logsSettled: false });
  });

  it('reports a buffered error as a mismatch even when the barrier failed', async () => {
    // A driver fault does not make a logged error undecidable: the page threw,
    // and that is an answer.
    const { browser, emitLog } = fakeBrowser({ barrier: 'reject' });
    journal.attach(browser);
    emitLog(jsError('boom'));

    const failure = await failureOf(browser);
    expect(failure.code).toBe(ErrorCode.EXPECT_MISMATCH);
    expect(failure.message).toContain('boom');
  });

  it('reports buffered errors as a mismatch even when older ones were evicted', async () => {
    // "Three errors are right here and one older one was lost" is not
    // undecidable — it is false, with evidence. Sending an agent to read logs
    // it has already been handed is the failure mode being avoided.
    const { browser, emitLog } = fakeBrowser();
    journal.attach(browser);
    emitLog(jsError('the one that got away'));
    for (let i = 0; i < MAX_JOURNAL_ENTRIES; i++) emitLog(chatter(`m${i}`));
    emitLog(jsError('still here'));

    const failure = await failureOf(browser);
    expect(failure.code).toBe(ErrorCode.EXPECT_MISMATCH);
    expect(failure.message).toContain('still here');
    // The lost one is named as well, so the count reads as a lower bound.
    expect(failure.message).toContain('evicted before this ran');
    expect(failure.detail).toMatchObject({ actual: 1, logsDropped: 1 });
  });

  it('quotes an evicted count as an upper bound when that is all it is', async () => {
    // Past the retained sequence numbers the journal can only bound the loss.
    // The mismatch is still the right verdict — an error is right here — but
    // the number beside it must not read like a figure.
    const { browser, emitLog } = fakeBrowser();
    journal.attach(browser);
    for (let i = 0; i < MAX_JOURNAL_ENTRIES * 2 + 1; i++) emitLog(jsError(`e${i}`));

    const failure = await failureOf(browser);
    expect(failure.code).toBe(ErrorCode.EXPECT_MISMATCH);
    expect(failure.message).toContain('up to');
    expect(failure.message).toContain('more evicted before this ran');
    expect(failure.detail).toMatchObject({ logsDroppedExact: false });
  });

  it('is undecidable only when nothing is left to point at', async () => {
    const { browser, emitLog } = fakeBrowser();
    journal.attach(browser);
    emitLog(jsError('the one that got away'));
    for (let i = 0; i < MAX_JOURNAL_ENTRIES + 5; i++) emitLog(chatter(`m${i}`));

    const failure = await failureOf(browser);
    expect(failure.code).toBe(ErrorCode.STATE_INVALID);
    expect(failure.message).toContain('cannot be established');
    expect(failure.detail).toMatchObject({ logsDropped: 1, errors: 0 });
  });

  it('says nothing was captured rather than nothing happened', async () => {
    const detached = new SessionJournal();
    const { browser } = fakeBrowser();
    const failure = await (async () => {
      try {
        await expectNoErrors(browser, detached, 0);
      } catch (error) {
        return error as CraftdriverError;
      }
      throw new Error('expected a failure');
    })();
    expect(failure.code).toBe(ErrorCode.STATE_INVALID);
    expect(failure.message).toContain('console capture is off');
  });

  it('refuses a cursor the session has not issued', async () => {
    const { browser } = fakeBrowser();
    journal.attach(browser);
    const failure = await failureOf(browser, 5_000);
    expect(failure.code).toBe(ErrorCode.INVALID_ARGUMENT);
    expect(failure.message).toContain('ahead of this session');
  });
});
