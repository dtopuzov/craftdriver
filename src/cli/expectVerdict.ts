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
  /** `no-errors` only: the window it just cleared, and where to read from next. */
  errors?: number;
  logCursor?: number;
  logsDropped?: number;
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

  // The barrier. Failure to take it is not failure to assert: the count below
  // is still the best answer available, and throwing here would turn a driver
  // hiccup into a failed assertion about the page.
  await browser
    .activePage()
    .then((page) => page.url())
    .catch(() => undefined);

  const { errors, dropped } = journal.countErrorsSince(since);
  const logCursor = journal.cursor;
  if (errors === 0) {
    return {
      ok: true,
      matcher: 'no-errors',
      errors,
      logCursor,
      ...(dropped > 0 ? { logsDropped: dropped } : {}),
    };
  }

  // Quote the first few. The whole point is that the verdict does not cost a
  // follow-up `logs` call to become actionable.
  const page = journal.query({ kinds: ['error'], since, limit: MAX_REPORTED_ERRORS });
  const texts = page.entries.map((entry) => ('text' in entry ? entry.text : entry.url));
  const more = errors > texts.length ? ` (+${errors - texts.length} more)` : '';
  const window = since > 0 ? ` since cursor ${since}` : '';
  throw mismatch(
    `expected no errors${window}, but the page logged ${errors}: ` +
      texts.map((text) => JSON.stringify(text)).join('; ') +
      more,
    {
      matcher: 'no-errors',
      expected: 0,
      actual: errors,
      since,
      logCursor,
      ...(dropped > 0 ? { logsDropped: dropped } : {}),
    },
    `read them in full with \`logs --kind error --since ${since}\`.`
  );
}
