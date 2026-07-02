# PERF-04: Auto-wait single-round-trip collapse

## Description

**This item's scope is ~2-3x bigger than originally documented — read this
section before estimating effort.**

The original framing was "fix `wait.ts`'s `until.elementIsVisible`."
Verification confirmed that piece: `until.elementIsVisible`
(`src/lib/wait.ts:94-102`) does, per poll attempt, two round trips —
`driver.findElement(locator)` (`POST /session/{id}/element`) then
`el.isDisplayed()` (`GET /session/{id}/element/{id}/displayed`) — and only
then sleeps a fixed `intervalMs` (default 100, `wait.ts:26/30`) before
retrying, via `setTimeout` at `wait.ts:47`.

But verification also found **two more independent implementations of the
exact same anti-pattern** that a `wait.ts`-only fix would completely miss:

1. **`locator.ts` does not use `wait.ts`'s `until` helpers at all.**
   `Locator._waitForVisible` (`locator.ts:136-173`), `_waitForAny`
   (`locator.ts:176-198`), and `_waitForNegativeState`
   (`locator.ts:309-334`) are separate, hand-rolled poll loops with the
   same find-then-check-then-sleep(100) shape. This matters because
   `Locator` (via `browser.locator()`) is the primary modern API surface —
   fixing only `wait.ts` leaves roughly half the hot path untouched. Worse:
   `Locator._findFinal()` can issue *more than 2* round trips per poll
   tick when filtering nested candidates (`_filterHas`, `_filterText` loop
   over candidates calling `el.findElements`/`getText` each) — the actual
   round-trip count for `Locator`-based flows can exceed the "2-3" the
   original doc estimated.
2. **A third poll loop exists in `waitForLoadState`'s Classic fallback**,
   in both `Browser.waitForLoadState()` (`browser.ts:1090-1097`) and
   `Page.waitForLoadState()` (`page.ts`, equivalent shape) — polling
   `document.readyState` via `executeScript` every 100ms. This is a
   different kind of polling (page state, not element visibility) and
   likely needs a different fix shape (see Implementation).

Every `By` locator (`src/lib/by.ts`) resolves to either `using: 'css
selector'` or `using: 'xpath'` — confirmed exhaustively, no third kind
exists anywhere in `src/lib`. This means one script shape genuinely can
cover every locator kind for the element-visibility poll loops (item 1
above) — the underlying idea is sound, it's just bigger than one file.

`Driver.executeScript()` (`driver.ts:131-139`, `POST
/session/{id}/execute/sync`) is confirmed to do a single round trip, and
the W3C WebDriver spec's script-return serialization special-cases DOM
`Element`/`Node` return values into the same web-element-reference format
`findElement` returns — so a script can locate + check visibility + return
a directly-usable element reference in one round trip. `Driver.executeAsyncScript()`
(`driver.ts:146-154`, `POST /session/{id}/execute/async`) also exists,
confirmed, and is the better fit for the `document.readyState` polling
case (item 2) since it lets the browser itself wait and resolve once,
rather than Node polling from outside.

## Implementation

1. **Add a poll-heavy benchmark case first.** None of the existing
   `tests/perf/*.perf.ts` files exercise a scenario where an element only
   becomes visible after a delay, forcing multiple poll iterations —
   confirmed, all current benchmark interactions target elements already
   present on page load. Add one (e.g. a page where a button appears after
   a few hundred ms) so the impact of this change is measured before/after,
   not assumed. This is cheap and should happen regardless of what else
   in this item gets built.

2. **Design one reusable find+check+return script** for the
   element-visibility poll loops (item 1). Shape:
   `return (() => { const el = document.querySelector(sel) /* or
   document.evaluate for xpath */; if (!el) return null; const r =
   el.getBoundingClientRect(); const visible = r.width > 0 && r.height > 0
   && getComputedStyle(el).visibility !== 'hidden'; return visible ? el :
   null; })()`, executed via `executeScript`. Re-run fresh on every poll
   attempt — this does **not** introduce caching; `Locator`'s
   "always re-resolve" design (confirmed: no memoization anywhere in
   `_findRaw`/`_findFinal`, `locator.ts:91-133`, matching Playwright's own
   `Locator` semantics) is correct and must be preserved.

3. **Preserve current error semantics explicitly — don't assume this is
   free.** Today, `driver.findElement` throws a distinct error on "no such
   element" (a generic `Error`, `driver.ts:109`) while `until.elementIsVisible`
   and `Locator`'s poll loops each swallow that via their own try/catch to
   mean "not found yet, keep polling" (`wait.ts:99-101`,
   `locator.ts:147-149`). A single script returning `null` collapses "not
   found" and "found but hidden" into one signal, and loses the
   distinction from "a genuinely unexpected error occurred" that HTTP
   status/exception shape currently gives each call site almost for free.
   Design this explicitly — e.g. have the script throw (via a JS `throw`,
   which surfaces as a distinguishable `execute/sync` error) for real
   errors and return `null` only for "not found/not visible yet."

4. **Design frame/nested-locator scoping for `Locator`.** This is the
   hardest, most novel part and is not addressed by a simple script sketch.
   `Locator`'s nested `.locator()` chains resolve parent-relative
   (`parentEls[0].findElements(...)`, `locator.ts:92-97`). A collapsed
   script-based lookup needs to accept a previously-resolved parent
   element reference as a script argument and scope its
   `querySelector`/XPath evaluation to that element (e.g.
   `parentEl.querySelector(sel)` instead of `document.querySelector(sel)`)
   — this needs its own design pass, not a mechanical port of the
   top-level-only case. Frame-scoped resolution via
   `ElementHandle.withContext`/`Locator.withContext`
   (`elementHandle.ts:34-49`, `locator.ts:28-43`) should keep working
   as-is, since those switch the WebDriver top-level frame context via a
   separate Classic command *before* any find/visibility check runs, and
   `execute/sync` runs inside whatever frame is currently switched-to —
   but confirm this with a real iframe test case, don't assume.

5. **Apply in this order:** `wait.ts`'s `until` helpers first (simplest,
   top-level-only, no nested scoping needed) → `locator.ts` (hardest,
   needs the parent-scoping design from step 4) → reconsider
   `waitForLoadState`'s pollers separately, since they're a different
   shape entirely (page-state polling, not element-visibility polling) —
   `executeAsyncScript` (letting the browser wait in-page and resolve once
   `document.readyState` satisfies, instead of Node polling every 100ms)
   is likely the better fit there than reusing the find+check script.

## Verification

- The new poll-heavy benchmark (step 1 above), before/after each stage of
  this change, so the win is a real number, not an assumption.
- Full `tests/*.test.ts` suite green after each stage, with **focused
  attention** on: XPath-based locators (`By.role`, `By.text`,
  `By.labelText`, `By.placeholder`, `By.altText`, `By.title`), iframe-scoped
  locators (anything using `.withContext`), and nested `.locator()` chains
  — these are exactly the cases flagged as higher-risk during
  verification, not generic coverage.
- A dedicated test for the error-semantics distinction from step 3: assert
  that a genuinely-erroring locator (e.g. malformed XPath) still surfaces
  a real error, not a silent "keep polling" no-op that eventually times
  out with a confusing message.

## Risks

**High** — the highest-risk item in this plan. It's a hot path touching
nearly every public method (`click`, `fill`, `find`, every `Locator`
method, every `expect(locator).to…()` assertion). Three independent
implementations need unifying, not one. Nested-locator scoping is
genuinely novel engineering, not a mechanical port of the existing logic.
Recommended to be the last of the "active" items in this plan for exactly
these reasons — do it after the lower-risk, higher-certainty items land,
and only once the new benchmark shows the return is worth the investment.
