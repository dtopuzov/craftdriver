# Perf plan: index

Replaces `TODO.md` and `BIG-PICTURE-PERF.md`. Those were informal running
notes from the [#20](https://github.com/dtopuzov/craftdriver/issues/20)
BiDi-perf session; this index plus the numbered `PERF-NN.md` files are the
decision-ready version — every claim below was independently re-verified
against the current `bidi-perf` branch (not carried over blind), and a few
things changed shape during that verification. See each file's own
Description section for the file:line evidence.

## Where things stand

Shipped and validated this session: classic-first default navigation,
batched `BiDiSession.connect()` (6 round trips → 1), lazy log capture,
kept-eager network subscription (A/B tested, not guessed), HTTP keep-alive.
Result: BiDi/Classic ratio **1.12x → ~1.05–1.09x** on synthetic example
pages, **1.17–1.19x** on a real Postgres-backed app — down from the
original issue's 1.7x regression. `tests/perf/bidi-vs-classic.perf.ts`,
`tests/perf/registration-shape.perf.ts`, and
`tests/perf/realapp/registration-easymath.perf.ts` are the benchmarks that
back these numbers; run with `npm run bench` / `npm run bench:realapp`.

Everything below is what's left, re-verified and re-prioritized.

## Priority order

**[PERF-03](./PERF-03.md) is deprioritized** — it speeds up test-suite
wall-clock time (test-authoring/infrastructure), not any automation
command's speed, which is explicitly not the current interest. Left in
the file set for reference, not on the active path below.

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
3. **[PERF-06](./PERF-06.md)** — Phase 5b, rename/simplify `enableBiDi`.
   Explicitly sequenced after PERF-05 lands; also a breaking public-API
   decision — this file presents options, doesn't pick one for you.
4. **[PERF-04](./PERF-04.md)** — auto-wait single-round-trip collapse.
   Verification found this is ~2–3x bigger in scope than originally
   documented (3 independent poll loops, not 1) and the highest-risk item
   here (hot path touching nearly every public method). Do after the
   lower-risk items above, and only after adding the poll-heavy benchmark
   the file calls for. This is the item that most directly makes every
   `click()`/`fill()`/`find()` call faster.
5. **[PERF-02](./PERF-02.md)** — Firefox BiDi-connect retry-loop
   investigation. Independent of everything else; Chrome numbers aren't
   affected either way. Slot in whenever.
6. **[PERF-07](./PERF-07.md)** — driver startup flags investigation.
   Lowest priority, do last.

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
