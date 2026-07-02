# PERF-01: BiDi duplicate-subscription cleanup

## Description

`BiDiSession.connect()` already subscribes to `browsingContext.contextCreated`
and `browsingContext.contextDestroyed` globally, once, as part of its
merged connect-time batch (`src/lib/bidi/index.ts:79-100`, the two events
subscribed at lines 91-92). Four other call sites re-subscribe to the same
two events independently, on first use, even though the events are already
flowing:

1. `BrowserContext._startPageTracking()` — `src/lib/browserContext.ts:990-993`
2. `Browser.waitForPage()` — `src/lib/browser.ts:1702` (subscribes to
   `browsingContext.contextCreated` alone)
3. `BrowserContext.waitForPage()` — `src/lib/browserContext.ts:262` (same,
   `contextCreated` alone)
4. `Browser._startTopLevelContextTracking()` fallback branch —
   `src/lib/browser.ts:1929-1931` (only runs when `initialContexts` wasn't
   seeded — see Risks)

Only the first of these four was in the original tracking doc; the other
three were found during verification for this plan. Each one sends a
`session.subscribe` command that gets nothing new — the events are already
being delivered — so it's a pure wasted round trip on first use of
`ctx.route()` / `ctx.on('page')` / `waitForPage()` / (rarely) the
top-level-context fallback path.

**Why it's safe to remove:** BiDi's `session.subscribe` is idempotent per
the spec — calling it twice for the same event/context doesn't duplicate
event delivery. Event *handlers* are registered separately via
`BiDiConnection.on(...)`, not tied to the subscribe call itself, so
removing the redundant `subscribe()` calls doesn't risk handlers silently
not firing or firing twice — confirmed by reading `src/lib/bidi/connection.ts`'s
`subscribe()`/`on()` split.

## Implementation

Same shape as this session's `BiDiSession.connect()` batching fix: each of
the four call sites should register its `conn.on(...)` handler directly
off the existing connection instead of calling `.subscribe()` again.
Concretely:

- `_startPageTracking()` (`browserContext.ts:990-993`): drop the
  `subscribe()` call, keep the `conn.on('browsingContext.contextCreated', ...)`
  /`contextDestroyed` handler registration.
- `Browser.waitForPage()` (`browser.ts:1702`) and
  `BrowserContext.waitForPage()` (`browserContext.ts:262`): same — drop
  the one-off `subscribe(['browsingContext.contextCreated'])` call, rely on
  the connect-time global subscription.
- `_startTopLevelContextTracking()`'s fallback branch
  (`browser.ts:1929-1931`): **needs extra care before removing.** This
  branch is documented (`browser.ts:1913-1922`) as a defensive path for
  when `initialContexts` wasn't seeded at connect time. Before dropping its
  `subscribe()` call, confirm two things by reading the actual connect
  sequence in `Browser.launch()`/`initBiDi()`:
  1. Is `BiDiSession.connect()`'s global subscribe guaranteed to have
     already run by the time this fallback branch can execute (i.e. is
     there any code path where this fallback runs *before* `connect()`
     has subscribed)?
  2. Is this fallback branch actually reachable in current code, or is it
     dead/rarely-hit defensive code? If it's genuinely unreachable given
     today's `initBiDi()` sequencing, note that in the PR instead of
     leaving stale defensive code in place.

If either check turns up a real ordering risk, leave that one call site's
`subscribe()` in place and only fix the other three — don't force
uniformity at the cost of correctness.

## Verification

- No new perf benchmark needed — this is a microsecond-level round-trip
  removal on first use of a handful of methods, not something the existing
  wall-clock benchmarks (`tests/perf/*.perf.ts`) would show a visible
  delta for.
- Run the existing suites that exercise these code paths and confirm they
  stay green: `tests/browser-context.test.ts`, `tests/pages.test.ts`, and
  any test using `waitForPage()` (grep `tests/*.test.ts` for `waitForPage`
  to get the exact list).
- Add one small regression test per fixed call site if none already
  exists: open a context/page via the fixed path and confirm the
  `contextCreated`/`contextDestroyed` handler still fires exactly once
  (not zero times, not twice) — this is the actual risk being guarded
  against by removing a "harmless" redundant subscribe.

## Risks

Low. The subscribe-is-idempotent reasoning is solid and verified against
the connection code. The only real risk is the `_startTopLevelContextTracking`
fallback branch's ordering guarantee — call that out explicitly in review
rather than assuming it's the same shape as the other three.
