# PERF-02: Firefox BiDi-connect retry-loop investigation

## Description

`Browser.initBiDi()` (`src/lib/browser.ts:489-519`) retries the BiDi
WebSocket connect up to `maxAttempts = 8` times (line 495) with a backoff
of `300 * attempt` ms (line 511) — i.e. waits of 300, 600, 900, 1200, 1500,
1800, 2100ms between attempts 1-8. Worst case total wait is
`300 × (1+2+...+7) = 8400ms` (~8.4s) before giving up — **not** the ~10.8s
originally noted; that was a math error in the earlier tracking doc.

The comment at lines 492-494 explains the retry exists because "Firefox
may not have finished binding its BiDi WebSocket yet (especially when a
previous session just closed on the same port, or the profile is still
initialising)." This is Chrome-unaffected — none of this session's
benchmarks (all Chrome) touch this code path at all.

## Implementation

This is research-first, not a guaranteed code change:

1. **Reproduce and characterize.** Run `npm run test:firefox` repeatedly
   (it already exists as a script) and log how many retry attempts are
   typically needed in practice — is it usually 1-2 attempts (small,
   ignorable cost) or does it regularly climb toward the 8-attempt worst
   case (real, frequent cost worth fixing)? This number changes the
   urgency of everything below.
2. **Check for a readiness signal.** Look at what geckodriver actually
   returns in its capabilities/response when the BiDi WebSocket isn't
   ready yet — is there a distinguishable error (e.g. connection refused
   vs. a specific geckodriver error code) that would let the code
   differentiate "not ready yet, retry fast" from "actually broken, stop
   retrying"? Check the geckodriver GitHub issue tracker / release notes
   for known BiDi-endpoint-timing issues around session creation — this is
   an upstream characteristic, not craftdriver's own bug, so it's worth
   checking whether it's already tracked/fixed in a newer geckodriver
   version before writing any workaround code.
3. **Only if a concrete better signal exists**, implement it (e.g. probe
   readiness via a lightweight check instead of blind retry-with-backoff).
   If nothing better than "keep retrying with backoff" exists upstream,
   the correct outcome of this investigation is to **leave the code as-is
   and document the ~8.4s worst case clearly** (fix the doc math, note it
   as an accepted characteristic of geckodriver, not a craftdriver defect)
   rather than force a code change that doesn't actually improve anything.

## Verification

- `npm run test:firefox` before and after any change, run several times in
  a row (retry timing is inherently non-deterministic) to confirm no new
  flakiness was introduced in BiDi connect reliability.
- If a change is made, add a note to the retry loop's comment explaining
  the upstream reasoning found during investigation, so the next person
  doesn't have to re-derive it.
- If no change is made, this task's "verification" is simply: confirm the
  corrected ~8.4s worst-case math is reflected wherever this is documented
  (this file, and any doc comment near `initBiDi()`).

## Risks

Low code risk either way — worst case this remains a documented,
budgeted-for characteristic rather than a fix. The main risk is treating
this as more urgent than it is: it's Firefox-only, and every benchmark
number this project has produced so far is Chrome-only, so there's no
current evidence this is costing real time in practice. Time-box the
investigation; don't let it block anything else in this plan.
