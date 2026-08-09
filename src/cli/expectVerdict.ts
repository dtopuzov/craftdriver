/**
 * Verification steps with a verdict.
 *
 * The CLI has excellent *reads* and, until now, no *assertions*: `is visible`
 * answers `{"result":false}` and exits 0, so nothing on this surface could say
 * "expected visible, was hidden" and fail. Inside a batch that gap is the
 * expensive one — a batch could report that every step *executed*, never that
 * the outcome was the wanted one.
 *
 * Nothing here re-implements waiting. Every poll, timeout and retry is the
 * library's (`src/lib/expect.ts`); this module owns three things the library
 * deliberately does not:
 *
 * - the **agent-facing message**, phrased around the selector the caller typed
 *   rather than the internal locator description;
 * - the **diagnosis on failure** — one classification pass, on the failure path
 *   only, so `expect text` cannot report `got ""` for an element that does not
 *   exist and `expect visible` says *exists but is not displayed*. This is the
 *   shape `visibilityDiagnosis.ts` established for the action commands;
 * - the **verdict**, as an `EXPECT_MISMATCH` the CLI turns into exit 1 and a
 *   batch turns into a stopped run with a named failed step.
 */
import type { Browser } from '../lib/browser.js';
import type { By } from '../lib/by.js';
import type { ElementHandle } from '../lib/elementHandle.js';
import { CraftdriverError, ErrorCode } from '../lib/errors.js';
import type { SessionJournal } from './journal.js';

/** Deliberately small: these four cover most of what an agent verifies. */
export type ExpectMode = 'visible' | 'text' | 'url' | 'no-errors';

export const EXPECT_MODES: readonly ExpectMode[] = ['visible', 'text', 'url', 'no-errors'];

/** Exact match (a positional argument) or substring (`--contains`). */
export interface ExpectMatch {
  kind: 'exact' | 'contains';
  value: string;
}

/** An element target, carrying the selector spelling the caller used. */
export interface ExpectTarget {
  by: By;
  /** As typed — `ref=e7`, `testid=save`, `#id`. Never the internal `By` shape. */
  selector: string;
  timeout: number;
}

export interface ExpectVerdict {
  ok: true;
  matcher: ExpectMode;
  selector?: string;
  mode?: ExpectMatch['kind'];
  expected?: string;
  /**
   * `no-errors` only: the window it just cleared, and where to read from next.
   *
   * No eviction or delivery qualifier here on purpose — a verdict that needed
   * one is not a pass. They live on the failures, where they change what the
   * caller should do next.
   */
  errors?: number;
  logCursor?: number;
}

/** Error texts quoted in a failed `no-errors`, so the verdict needs no follow-up. */
const MAX_REPORTED_ERRORS = 3;

function mismatch(
  message: string,
  detail: Record<string, unknown>,
  hint?: string
): CraftdriverError {
  return new CraftdriverError(ErrorCode.EXPECT_MISMATCH, message, {
    detail,
    ...(hint ? { hint } : {}),
  });
}

/**
 * What the selector matches right now, or null when that cannot be answered.
 *
 * The one classification round trip every failure path shares — null means the
 * page moved under us or the driver is unhappy, in which case the original
 * expectation failure is still true and still the better answer.
 */
async function resolveMatches(browser: Browser, by: By): Promise<ElementHandle[] | null> {
  try {
    return await browser.findAll(by);
  } catch {
    return null;
  }
}

export async function expectVisible(
  browser: Browser,
  target: ExpectTarget
): Promise<ExpectVerdict> {
  const { by, selector, timeout } = target;
  try {
    await browser.expect(by).toBeVisible({ timeout });
  } catch (error) {
    // A specific code — a stale ref, a detached shadow root, a driver fault —
    // already says what happened and must reach the caller unchanged.
    if (!CraftdriverError.is(error, ErrorCode.EXPECT_MISMATCH)) throw error;
    const elements = await resolveMatches(browser, by);
    if (elements === null) throw error;
    const matched = elements.length;
    if (matched === 0) {
      throw mismatch(
        `expected ${selector} to be visible, but nothing matched it within ${timeout}ms`,
        { selector, matcher: 'visible', expected: 'visible', actual: 'no match', matched, timeout },
        'The selector matched zero elements. Check it against `snapshot`, or use testid= / role= for a durable one.'
      );
    }
    throw mismatch(
      `expected ${selector} to be visible, but it is hidden after ${timeout}ms ` +
        `(${matched} ${matched === 1 ? 'element matches' : 'elements match'}, none displayed)`,
      { selector, matcher: 'visible', expected: 'visible', actual: 'hidden', matched, timeout },
      'The element exists but never became visible — open the view containing it (modal, accordion, tab) first.'
    );
  }
  return { ok: true, matcher: 'visible', selector };
}

export async function expectText(
  browser: Browser,
  target: ExpectTarget,
  match: ExpectMatch
): Promise<ExpectVerdict> {
  const { by, selector, timeout } = target;
  const verb = match.kind === 'contains' ? 'contain' : 'have';
  try {
    const api = browser.expect(by);
    if (match.kind === 'contains') await api.toContainText(match.value, { timeout });
    else await api.toHaveText(match.value, { timeout });
  } catch (error) {
    if (!CraftdriverError.is(error, ErrorCode.EXPECT_MISMATCH)) throw error;
    const elements = await resolveMatches(browser, by);
    if (elements === null) throw error;
    const matched = elements.length;
    if (matched === 0) {
      // Without this the library's message reads `but got ""`, which an agent
      // reasonably takes as "the element is there and empty" — a different
      // problem with a different fix.
      throw mismatch(
        `expected ${selector} to ${verb} text "${match.value}", but nothing matched it within ${timeout}ms`,
        {
          selector,
          matcher: 'text',
          mode: match.kind,
          expected: match.value,
          actual: null,
          matched,
          timeout,
        },
        'The selector matched zero elements. Check it against `snapshot`, or use testid= / role= for a durable one.'
      );
    }
    // Reuses the elements the classification pass already resolved, so a
    // failed text assertion costs one extra round trip, not two.
    const actual = await elements[0]
      .text()
      .then((text) => text.trim())
      .catch(() => null);
    if (actual === null) throw error;
    throw mismatch(
      `expected ${selector} to ${verb} text "${match.value}", but got "${actual}" after ${timeout}ms`,
      {
        selector,
        matcher: 'text',
        mode: match.kind,
        expected: match.value,
        actual,
        matched,
        timeout,
      }
    );
  }
  return { ok: true, matcher: 'text', selector, mode: match.kind, expected: match.value };
}

/** Escape a substring so it can be handed to the library's RegExp matcher. */
function literalPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

export async function expectUrl(
  browser: Browser,
  match: ExpectMatch,
  timeout: number
): Promise<ExpectVerdict> {
  try {
    // `--contains` rides the library's RegExp support rather than growing a
    // second URL poller. The failure message is rewritten below so the agent
    // sees the substring it typed, not the escaped pattern we built from it.
    const expected = match.kind === 'contains' ? literalPattern(match.value) : match.value;
    await browser.expect().toHaveURL(expected, { timeout });
  } catch (error) {
    if (!CraftdriverError.is(error, ErrorCode.EXPECT_MISMATCH)) throw error;
    const observed = error.detail?.actual;
    const actual = typeof observed === 'string' ? observed : await browser.url().catch(() => '');
    const verb = match.kind === 'contains' ? 'contain' : 'be';
    throw mismatch(
      `expected the URL to ${verb} "${match.value}", but it is "${actual}" after ${timeout}ms`,
      { matcher: 'url', mode: match.kind, expected: match.value, actual, timeout }
    );
  }
  return { ok: true, matcher: 'url', mode: match.kind, expected: match.value };
}

/**
 * Assert the page has logged no errors.
 *
 * The one mode that does not auto-wait, and the reason is not an oversight:
 * waiting for the *absence* of an error can only ever burn the whole timeout,
 * so this reports what has been captured at the moment it runs. An error the
 * application throws later belongs to the next observation — or to
 * `logs wait`, which is the command for waiting on a specific message.
 *
 * It does pay one round trip first, as an ordering barrier rather than a
 * wait. Capture is BiDi; a click's own response can come back before the
 * console event that click caused, so counting immediately misses it — which,
 * inside a batch, is exactly the case this assertion exists for. Because both
 * travel the same WebSocket in order, a reply to a request sent *after* the
 * action proves every event the browser had already emitted was delivered
 * first. `browsingContext.getTree` is the cheapest such request and, unlike an
 * evaluate, a modal dialog cannot block it. (This is the same barrier the
 * observation envelope relies on by counting after its snapshot.)
 *
 * Counts from the start of the session by default. `since` — the `logCursor`
 * every observation already emits — narrows it to one window. Deliberately not
 * "since the last check": an assertion that passes on a re-run because the
 * first run consumed the evidence is worse than a noisy one.
 *
 * Three outcomes, not two. A buffered error settles it — that is the ordinary
 * failure. Otherwise the window has to be trustworthy before "no errors" can
 * be claimed: errors evicted from the bounded journal, or a barrier the driver
 * would not answer, both make it `STATE_INVALID` — undecidable — for the same
 * reason a session that never captured anything is. Absence of evidence is not
 * evidence of absence, and this is the one command whose whole job is to say
 * so.
 */
export async function expectNoErrors(
  browser: Browser,
  journal: SessionJournal | undefined,
  since: number
): Promise<ExpectVerdict> {
  if (!journal) {
    throw new CraftdriverError(ErrorCode.STATE_INVALID, 'expect no-errors: no journal on this session');
  }
  // "Nothing was captured" is not "nothing happened". Passing here would tell
  // an agent the page is clean when the truth is that nobody was listening.
  if (!journal.isCapturing) {
    throw new CraftdriverError(
      ErrorCode.STATE_INVALID,
      'expect no-errors: console capture is off, so this cannot be answered',
      {
        detail: { since },
        hint: 'console and network history require BiDi; a Classic session cannot report errors.',
      }
    );
  }

  // A cursor the session has not issued yet asserts over an empty window, and
  // would pass no matter what the page did. It is always a caller mistake —
  // usually a cursor from another session — so it is refused rather than
  // silently answered.
  if (since > journal.cursor) {
    throw new CraftdriverError(
      ErrorCode.INVALID_ARGUMENT,
      `expect no-errors: --since ${since} is ahead of this session's log cursor (${journal.cursor})`,
      {
        detail: { since, logCursor: journal.cursor },
        hint: 'pass the `logCursor` from an observation of this session, or omit --since.',
      }
    );
  }

  // The barrier.
  const settled = await browser
    .activePage()
    .then((page) => page.url())
    .then(() => true)
    .catch(() => false);

  const { errors, dropped, droppedExact } = journal.countErrorsSince(since);
  const logCursor = journal.cursor;
  // An error that is still buffered settles the question on its own: the page
  // logged one, so "no errors" is false rather than unanswerable, whatever
  // else was lost or unconfirmed. Checked first for that reason — reporting a
  // known failure as undecidable would send an agent to read logs it has
  // already been handed.
  if (errors > 0) {
    // Quote the first few. The whole point is that the verdict does not cost a
    // follow-up `logs` call to become actionable.
    const page = journal.query({ kinds: ['error'], since, limit: MAX_REPORTED_ERRORS });
    const texts = page.entries.map((entry) => ('text' in entry ? entry.text : entry.url));
    const more = errors > texts.length ? ` (+${errors - texts.length} more)` : '';
    const window = since > 0 ? ` since cursor ${since}` : '';
    const lost =
      dropped > 0
        ? `, and ${droppedExact ? dropped : `up to ${dropped}`} more evicted before this ran`
        : '';
    throw mismatch(
      `expected no errors${window}, but the page logged ${errors}: ` +
        texts.map((text) => JSON.stringify(text)).join('; ') +
        more +
        lost,
      {
        matcher: 'no-errors',
        expected: 0,
        actual: errors,
        since,
        logCursor,
        ...(dropped > 0 ? { logsDropped: dropped } : {}),
        ...(dropped > 0 && !droppedExact ? { logsDroppedExact: false } : {}),
      },
      `read them in full with \`logs --kind error --since ${since}\`.`
    );
  }

  // Nothing visible failed, so the remaining question is whether the window is
  // trustworthy. Two ways it is not, and neither may be reported as a pass:
  // errors evicted from the bounded journal, and a barrier the driver would
  // not answer — in which case an error the last action caused may not have
  // been delivered yet. `logsDropped` on a green verdict is metadata a CI gate
  // or a batch does not read, and "we did not keep the evidence" must not
  // reach an agent as "there was nothing to keep".
  if (dropped > 0) {
    const count = droppedExact ? `${dropped}` : `up to ${dropped}`;
    throw new CraftdriverError(
      ErrorCode.STATE_INVALID,
      `expect no-errors: ${count} error${dropped === 1 ? ' was' : 's were'} evicted from ` +
        `the log before this ran, so "no errors" cannot be established`,
      {
        detail: {
          matcher: 'no-errors',
          since,
          logCursor,
          errors,
          logsDropped: dropped,
          ...(droppedExact ? {} : { logsDroppedExact: false }),
        },
        hint:
          'the journal keeps a bounded history; assert against a narrower window with ' +
          '`--since <logCursor>`, or clear it with `logs clear` before the step you are checking.',
      }
    );
  }
  if (!settled) {
    throw new CraftdriverError(
      ErrorCode.STATE_INVALID,
      'expect no-errors: the driver would not confirm that pending events had been ' +
        'delivered, so an error the page logged may not have arrived yet',
      {
        detail: { matcher: 'no-errors', since, logCursor, errors, logsSettled: false },
        hint:
          'this is a driver or session fault rather than a page one — check the session ' +
          'is still alive (`status`) and retry.',
      }
    );
  }

  return { ok: true, matcher: 'no-errors', errors, logCursor };
}
