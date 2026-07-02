# PERF-05: Phase 5a — background BiDi connect in `Browser.launch()`

## Description

`Browser.launch()` still fully blocks on the complete BiDi connect
sequence (WebSocket connect + `getTree` + `subscribe`) before returning —
confirmed, `await browser.initBiDi(wsUrl)` at `browser.ts:471`, inside the
flow that returns `browser` at line 483 — even though the Classic session
is already usable at that point, and after this session's classic-first
changes, the *first* thing most tests do (navigate, click, fill) doesn't
need BiDi at all.

This has a quantified, real cost: this session's own connect-time-only
benchmark measured **~300–500ms** of pure BiDi-handshake overhead on top
of a Classic-only launch (2792ms BiDi vs. 2376ms Classic, localhost Chrome
headless). That's not process-spawn cost (identical for both) — it's
specifically the extra WebSocket connect + `getTree` + `subscribe` work
`Browser.launch()` currently makes every caller wait for, whether or not
their first action needs it.

WebdriverIO's model is the reference point here: `initiateBidi()` is
fire-and-forget, the session returns immediately, and the caller only
blocks on BiDi being ready at the point something actually needs it.

## Implementation

Two design questions need resolving before writing code — both were
already identified in the original notes and verification confirmed
they're still exactly the right things to worry about:

1. **Replace the synchronous boolean with a tri-state.** Today
   `isBiDiEnabled()` (`browser.ts:524-526`) is
   `this.bidiSession?.isConnected() ?? false` — a single synchronous
   check with no way to distinguish "still connecting" from "permanently
   failed." This needs to become a real tri-state (connecting / ready /
   failed). Every BiDi-only accessor (`browser.network`, `browser.logs`,
   `openPage()`, `newContext()`, `startTrace()`, and the various
   `requires BiDi (enableBiDi: true)` throw sites) needs to `await` a
   `this._bidiReady: Promise<void>` before doing its own work, instead of
   synchronously checking a boolean and throwing immediately. The
   `Promise` resolves on success, rejects on permanent failure — callers
   that currently throw synchronously on "BiDi not connected" need to
   become `async` awaiters of the in-flight case, only throwing once it's
   actually resolved as failed.

2. **Redesign `activePage()`'s fast path.** `activePage()`
   (`browser.ts:2010-2031`) has a fast path that assumes the
   top-level-context cache is already warm — confirmed, this is true
   *today* only because `initBiDi()` fully completes before `launch()`
   returns. Once BiDi connects in the background, `activePage()` needs its
   own explicit logic: wait for BiDi if it's still connecting, but don't
   require it if the caller only needs Classic-visible state (i.e. a
   Classic-only flow shouldn't pay the BiDi wait just because
   `activePage()` happens to have a BiDi-aware fast path). This is
   genuinely the trickiest part of this item — budget real design time for
   it, not a quick patch. Consider: does `activePage()` need a "Classic
   fallback that doesn't wait for BiDi at all" mode, separate from its
   current BiDi-aware fast path?

Shape: `Browser.launch()` returns as soon as the Classic session exists;
`initBiDi()` keeps running concurrently in the background and resolves/rejects
`this._bidiReady`.

## Verification

- Re-run `tests/perf/bidi-vs-classic.perf.ts`'s connect-time-only case
  before/after. Expect the BiDi/Classic connect-time ratio to shrink
  meaningfully toward 1x (the ~300-500ms gap should mostly disappear from
  `launch()`'s own wall time, though the *total* work is unchanged — it's
  now happening after `launch()` returns instead of before).
- Full `tests/*.test.ts` suite green — audit specifically for any test
  that implicitly assumes BiDi is fully ready the instant `launch()`
  resolves (e.g. immediately calling a BiDi-only method with no
  intervening `await`). These are exactly the tests most likely to break
  from this change and are worth finding proactively rather than via CI
  failures.
- Add a new regression test: call a BiDi-only method (e.g.
  `browser.network.mock(...)`) immediately after `Browser.launch()`
  resolves, with no other `await` in between, and confirm it correctly
  awaits the in-flight BiDi connection rather than racing against it or
  throwing a spurious "BiDi not connected" error.
- Add a second regression test confirming the opposite: a
  Classic-only flow (navigate, click, fill, assert) that never touches a
  BiDi-only accessor should complete without ever waiting on
  `_bidiReady`, i.e. this change should measurably not slow down
  Classic-only usage.

## Risks

Medium. Both design questions are well-scoped (not open-ended research
like PERF-02, not carrying an unverified protocol-level assumption like
PERF-03 Step B) — this is a known engineering shape (WebdriverIO already
does something similar), the main risk is doing the `activePage()`
redesign carelessly and introducing a race between "Classic action
happens" and "BiDi context cache warms up." Give that specific piece its
own review pass.
