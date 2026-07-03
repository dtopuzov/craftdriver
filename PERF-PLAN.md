# Perf plan: index

Replaces `TODO.md` and `BIG-PICTURE-PERF.md`. Those were informal running
notes from the [#20](https://github.com/dtopuzov/craftdriver/issues/20)
BiDi-perf session; this index plus the numbered `PERF-NN.md` files are the
decision-ready version — every claim below was independently re-verified
against the current `bidi-perf` branch (not carried over blind), and a few
things changed shape during that verification. See each file's own
Description section for the file:line evidence.

## Where things stand

Shipped and validated: classic-first default navigation, batched
`BiDiSession.connect()` (6 round trips → 1), lazy log capture, kept-eager
network subscription (A/B tested), HTTP keep-alive — got the BiDi/Classic
per-command ratio from the issue's 1.7x regression down to ~1.05–1.09x.

Then, the biggest concrete win: **driver-resolution caching cut
`Browser.launch()` by ~530ms for both BiDi and Classic** (BiDi 2763→2235ms,
Classic 2395→1860ms) by eliminating a blocking `spawnSync` that relaunched the
browser to read its version on every launch. Also shipped: default auto-wait
poll interval 100ms→25ms (helps dynamic-element waits ~60–87ms). Benchmarks:
`tests/perf/bidi-vs-classic.perf.ts`, `tests/perf/launch-critical-path.perf.ts`
(`npm run bench`).

**Usage context:** local-only (no remote/Grid/BrowserStack), so any item whose
benefit is remote-only (high per-round-trip network latency) is out — this is
why PERF-04 was dropped.

Everything below is the current status, most items now resolved.

## Priority order

1. **[PERF-01](./PERF-01.md)** — ✅ **Shipped.** BiDi duplicate-subscription
   cleanup. Removed the 3 genuinely-redundant `session.subscribe()` round
   trips (`_startPageTracking`, `Browser.waitForPage`,
   `BrowserContext.waitForPage`); left the 4th (`_startTopLevelContextTracking`'s
   `!initialContexts` fallback) in place — verified it's currently unreachable
   defensive code whose subscribe is load-bearing *if* the branch ever runs.
   Verified green on Chrome + Firefox against the existing suites that
   exercise all three fixed paths.
2. **[PERF-05](./PERF-05.md)** — ❌ **Not implemented; premise measured
   wrong.** Phase-level timing showed the thing it wanted to background
   (`initBiDi()` = WS + getTree + subscribe) is only **~35ms**, not the
   ~300–500ms the plan assumed. The real BiDi/Classic launch gap lives in
   `Driver.create()` (chromedriver enabling BiDi during New Session) and is
   browser-side, not backgroundable. **The actual launch win was elsewhere
   and is shipped:** driver-resolution was relaunching Chrome via a blocking
   `spawnSync` to read its version on *every* launch (~340ms) plus a
   redundant `--version` spawn (~150ms) and coarse readiness polling. Caching
   resolution + dropping the redundant spawns cut `service.start()` from
   ~720ms → ~180ms and total launch by **~530ms for both BiDi and Classic**
   (launch-only: BiDi 2763→2235ms, Classic 2395→1860ms), and removed the
   blocking spawns that stalled parallel launches. Verified by
   `tests/perf/launch-critical-path.perf.ts`. See PERF-05.md for the full
   measurement.
3. **[PERF-06](./PERF-06.md)** — ❌ **Not applicable.** Predicated on PERF-05
   giving BiDi/Classic launch parity so `enableBiDi` stops being a speed
   decision. No parity exists (BiDi launch ~375ms slower — browser-side BiDi
   mapper, not backgroundable), so `enableBiDi: false` stays a genuine
   launch-speed escape hatch and must not be simplified away. Moot.
4. **[PERF-04](./PERF-04.md)** — ❌ **Not worth doing; premise measured
   false for local WebDriver.** Collapsing `findElement`+`isDisplayed`
   (2 round trips) into one `execute/sync` script does not help locally —
   a single `execute/sync` round trip (~12ms) costs as much as or more than
   the two element commands it replaces (~11ms), because script execution is
   a heavier chromedriver command than simple element lookups. The
   poll-heavy case is dominated by the 100ms poll interval, not round trips.
   The premise only holds for remote/Grid WebDriver (high per-round-trip
   network latency), which isn't craftdriver's local-first use case. Highest
   risk in the plan for a nil-to-negative local return. The one small real
   lever it exposed — reducing the 100ms element-wait poll interval — was
   ✅ **shipped separately** (default now 25ms, `DEFAULT_POLL_INTERVAL_MS` in
   `wait.ts`, shared by `locator.ts`). See PERF-04.md for the measurements.

### Still open (small, local-relevant, investigative)

5. **[PERF-02](./PERF-02.md)** — Firefox BiDi-connect retry-loop
   investigation. Only relevant if you use Firefox locally; Chrome
   unaffected. Slot in whenever.
6. **[PERF-07](./PERF-07.md)** — ✅ **Researched.** A curated 16-flag browser
   startup set moved launch by ~0.4% (≈8ms, noise) — browser process init
   dominates; the flags suppress post-startup background work, not the launch
   critical path. No default flags (craftdriver stays unopinionated); shipped
   instead as an opt-in `args` launch option + honest docs for users who want
   to try them (real value is CI determinism, not local speed).

## Deferred / not scheduled

These were already assessed as not worth building without more evidence.
Capturing the reasoning so it isn't re-litigated from scratch later —
revisit only if the stated trigger condition actually shows up.

- **Scoped/narrower network observation.** Today network subscription is
  session-wide (every `network.*` event, every context) — `ctx.route()`
  already scopes *interception*, but the underlying *observation*
  subscription is global. This session's own A/B benchmark showed
  stripping it made no measurable difference (0.93x → 0.94x). Don't build
  narrower scoping speculatively — revisit only if a future BiDi-heavy
  workload (many contexts, many tabs) shows this actually costing
  something.
- **One-shot, self-tearing-down subscriptions for `waitForRequest`/
  `waitForResponse`.** Floated in the original issue research (subscribe
  only for the duration of one wait, unsubscribe after). Not worth it: the
  network subscription turned out to be free once batched (see above), and
  self-tearing-down subscriptions add a real `Promise.all` race risk the
  issue itself flagged. Revisit only if a future workload shows a real
  cost to keeping network subscription on for the whole session.
- **Selenium-style fully-deferred BiDi connection** (don't even open the
  WebSocket until a BiDi-only feature is first touched, more aggressive
  than PERF-05's background-connect). Assessed as probably not worth it:
  craftdriver leans on BiDi for enough "expected to just work" features
  (dialogs via `unhandledPromptBehavior: ignore` need BiDi's dialog
  handler armed; `waitForLoadState` is event-driven via BiDi) that a
  fully-deferred connection needs its own careful audit of what silently
  degrades if BiDi isn't up yet. PERF-05 gets most of the benefit with
  much less correctness risk.
