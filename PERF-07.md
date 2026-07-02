# PERF-07: Driver startup flags investigation

## Description

Lowest priority item in this plan, kept mainly so it isn't lost. Question:
does chromedriver's (or geckodriver's) own startup have flags or
capabilities that trim its own init cost — disabling browser features
craftdriver never exercises (e.g. extensions, certain background
services)? This is a driver/browser-configuration question, not a
craftdriver-code question.

Confirmed still true and unchanged: `driverManager.ts` already caches
downloaded driver binaries correctly (chromedriver keyed by exact browser
version, no re-download on cache hit — `driverManager.ts:265-266`;
geckodriver on a TTL — see the driver-configuration docs updated earlier
this session) — that part is good, don't touch it. `DriverService`
allocates a fresh free port per launch cheaply — not a bottleneck, no
action needed there either. This item is specifically about the launched
browser/driver *process's own startup work*, separate from the download/
caching question.

Explicitly low priority: this is only worth investigating once PERF-03
lands and reduces how often a fresh driver process is even needed in the
first place — no point shaving milliseconds off a cost that's about to be
mostly eliminated by not launching nearly as often.

## Implementation

1. Research chromedriver's and geckodriver's own CLI flags and W3C
   capability options for anything that reduces startup work — e.g.
   Chrome flags passed through capabilities like disabling
   extensions/background-networking/GPU (some of these may already be
   set for headless mode; check what's already passed vs. what else is
   available), or geckodriver-specific profile/preference flags that skip
   unnecessary initialization.
2. Prototype passing a candidate flag/capability and measure — don't
   apply anything without a measured before/after, since some flags could
   have side effects on test behavior (e.g. disabling a feature a test
   fixture implicitly relies on).
3. Only keep changes that show a real, repeatable improvement in the
   benchmark below.

## Verification

`tests/perf/bidi-vs-classic.perf.ts`'s connect-time-only benchmark
before/after each candidate flag — same tool already used to establish
the current ~2.4-2.9s launch baseline, so results are directly comparable.

## Risks

Low — exploratory, no existing behavior is being changed unless a flag
proves out. The only real risk is a flag having a side effect on test
behavior that isn't caught by the perf benchmark alone (which doesn't
exercise every feature) — run the full `tests/*.test.ts` suite too before
adopting any flag permanently, not just the perf benchmark.
