# navigateTo protocol choice — decision record (RESOLVED)

Status: **RESOLVED 2026-07-04** — gate measured, **BiDi-first rejected**, kept
Classic-first, landed Option A (evaluate retry). See "Gate result" and
"Decision" below. Original research (2026-07-03) preserved for context.
Branch `bidi-perf`.

## Problem

The branch made `waitUntil: 'load'` navigations Classic-first for performance
(Classic `navigateTo` blocks until `readyState === 'complete'`, saving a BiDi
round trip). This exposed a race: **Classic navigate → immediate BiDi
`script.callFunction`** can throw `BiDi error [unknown error]: execution
contexts cleared` (seen in `tests/clock.test.ts` "setFixedTime() preload
survives navigations").

### Root cause

- `evaluate()` targets `{ context: <browsing-context id> }` (src/lib/browser.ts
  ~L1251). BiDi resolves that to the context's *current default realm* at
  command time. Every navigation destroys the old realm and creates a new one.
- BiDi `browsingContext.navigate` with `wait: 'complete'` resolves **after**
  the new realm is live → a following `{ context }` call is safe. Same
  protocol, real barrier.
- Classic `navigateTo` returns when the **Classic** session sees
  `readyState === 'complete'`. That is *not* a realm barrier for the BiDi side
  of the same browser — BiDi realm bookkeeping can still be mid-transition.
  A BiDi evaluate landing in that gap fails with "execution contexts cleared".
- One sentence: **two protocol views of one browser; Classic's "navigation
  done" is not a synchronization point BiDi respects.**

### Current mitigation (commit d1d9bbb)

"fix: keep preload-backed navigation on BiDi" — routes navigation through BiDi
only when preload scripts are active (`_hasInitScriptsForNavigation()`).
Correct, tested, low-risk — but a **heuristic**: it correlates "preload active"
with "next op is a BiDi evaluate". The general Classic-navigate→BiDi-evaluate
race remains open for ordinary user code (`navigateTo(url)` then
`evaluate(...)` with no preload).

## Evidence: how webdriverio handles this

Checked `/Users/admin/git/webdriverio/packages` (2026-07-03):

- **wdio is BiDi-first for navigation.** `webdriverio/src/commands/browser/url.ts`:
  when `this.isBidi`, it *always* uses `browsingContextNavigate({ context, wait })`
  (default `wait: 'complete'`). Classic `navigateTo` is used only for non-BiDi
  sessions or as a **reactive fallback** when BiDi navigate throws one of:
  - `navigation canceled by concurrent navigation` (Chrome)
  - `failed with error: unknown error` (Firefox)
  - `no such frame` (context destroyed mid-navigation)
  (see w3c/webdriver-bidi#878 for the concurrent-navigation issue)
- **wdio's `execute` targets `{ target: { context } }`** exactly like our
  `evaluate()`, and has **no retry** for "execution contexts cleared".
- Conclusion: wdio never hits our race because it **never mixes protocols
  across a navigate→evaluate pair**. They solved it by protocol choice, not
  defensive retries.

## Options considered

- **A. Retry `evaluate()` once/twice on "execution contexts cleared".**
  Safe (the error is pre-execution: the script never ran, no partial side
  effects; in-script errors arrive as `result.type === 'exception'` on a
  different code path, never retried). Fixes the general case in ~10 lines.
  Still worth having as a safety net even under BiDi-first.
- **B. Make Classic navigate establish a BiDi barrier before returning.**
  Adds a BiDi round trip to the fast path — defeats the optimization.
  d1d9bbb is effectively B, scoped to preload sessions.
- **C. Event-driven realm tracking** (`script.realmCreated/realmDestroyed`,
  like Playwright/Puppeteer internals; scaffolding exists in
  `_topLevelContextTracking`). Most robust, largest change, overkill for now.
- **D. BiDi-first navigation (wdio model)** — always navigate via BiDi when a
  BiDi session is connected; keep Classic as reactive fallback on the known
  error list above. Removes the race *by construction*; deletes the d1d9bbb
  heuristic and the dual-path branching in `page.ts` / `browser.ts`.

## Gate result (measured 2026-07-04)

Ran the isolated-navigate micro-benchmark in one open BiDi session, 15 measured
iterations after 3 warmups, interleaved A/B per iteration, HEADLESS. Temporary
bench (`tests/perf/navigate-protocol.perf.ts`) — deleted after the decision.

**Chrome** (stable across 3 runs):

| op                              | median  | p95     |
| ------------------------------- | ------- | ------- |
| Classic `driver.navigateTo`     | ~30 ms  | ~35 ms  |
| BiDi `browsingContext.navigate` | ~80 ms  | ~105 ms |
| **delta (BiDi − Classic)**      | **~50 ms** | ~65 ms |

**Firefox**: delta ~0 ms median (BiDi ≈ Classic), but Classic navigate→evaluate
had a fatter tail (p95 ~313 ms vs BiDi ~116 ms).

The "execution contexts cleared" race did **not** reproduce on either engine
(0 failures in ~90 navigate→evaluate pairs). The only reproduced instance
remains the clock/preload case, already handled by d1d9bbb.

**Verdict: delta is MATERIAL on Chrome (BiDi 2.6× slower per navigate), not the
expected single digits.** The plan's expectation was wrong — BiDi navigate on
Chrome is measurably more expensive than the Classic `/url` endpoint. This is
the "surprising" branch (old work item #3).

## Decision

- **Reject D (BiDi-first).** ~50 ms/navigate Chrome regression for no benefit
  (the race it would remove doesn't reproduce in ordinary code). Fails the
  project's no-perf-regression rule.
- **Keep Classic-first** for `waitUntil: 'load'` (30 ms vs 80 ms on Chrome).
- **Keep the d1d9bbb preload heuristic** — deterministic BiDi barrier for
  preload/clock sessions where a BiDi evaluate reliably follows; the ~50 ms is
  paid only there, and correctness matters most there. **Not** dropped.
- **Land A (evaluate retry)** as the general safety net for ordinary
  `navigateTo → evaluate` code that has no preload. Cheap, safe, no happy-path
  cost.

## What shipped (Option A)

- `Browser.evaluate()` retries `script.callFunction` up to
  `EVAL_REALM_RETRY_ATTEMPTS` (3) times on a message containing
  "execution contexts cleared", re-resolving `getContext()` each attempt, with
  a `EVAL_REALM_RETRY_DELAY_MS` (25 ms) pause. Constants in `src/lib/timing.ts`.
- The error is pre-execution (script never ran, no side effects). In-script
  errors take the `result.type === 'exception'` path and are never retried —
  covered by a regression test.
- Tests in `tests/evaluate.test.ts`: injected-error recovery + "does not retry a
  genuine in-script exception". Full suite green (294 pass). Micro-bench
  re-run after the change: happy-path navigate→evaluate unchanged (no overhead).

### Evidence checks (before/after)
- Chrome navigate→evaluate median: 140.4 ms before → 138.7 ms after (noise).
- Full suite: 294 passed / 2 skipped, both before and after.

### Not done (deliberately)
- No BiDi-first switch in `browser.ts`/`page.ts` — rejected above.
- d1d9bbb heuristic kept, not dropped.
- Docs unchanged — wait-semantics behaviour is unchanged.

## Follow-up cleanups (evaluated 2026-07-04)

Two optional items were surfaced during review and evaluated on their own merit
(owner confirmed keep-current-state first):

- **② Unify the load-state → BiDi-wait mapping — SHIPPED (code quality, not
  perf).** The `none→none / domcontentloaded→interactive / else→complete`
  ternary was copy-pasted in three navigate entry points (`Browser.navigateTo`,
  `Page.navigateTo`, `Page.setContent`). Extracted to `bidiWaitFor()` in new
  `src/lib/loadState.ts` — one source of truth for the wait-semantics contract,
  removing the drift risk that breeds exactly this file's class of bug.
  Behavior-identical. Evidence: tsc + eslint clean; **two consecutive full-suite
  runs green (296 pass / 2 skip)** after the change (one transient, unrelated
  flake on a third run). No public API or behavior change.
- **③ Response-returning `navigateTo` (Playwright-style status assertions) —
  DROPPED as redundant.** Probed empirically: `waitForResponse('**/page.html')`
  already catches the top-level navigation response with `status === 200` (the
  main document is a normal `network.responseCompleted` event, and the network
  subscription is session-wide / transport-independent). So the capability
  already exists via `Promise.all([waitForResponse(url), navigateTo(url)])`;
  adding a return value would be new permanent public API for zero new
  capability. Not built.

### Possible follow-ups (not blocking)
- The evaluate retry could wrap `page.ts` / `frame.ts` `script.callFunction`
  sites for symmetry; left out to keep scope minimal (they weren't implicated).
- Firefox Classic navigate→evaluate tail latency (p95 ~313 ms) is worth a look
  if Firefox becomes a supported target, but it's not an error, just a stall.
