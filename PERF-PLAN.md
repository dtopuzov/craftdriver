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

1. **[PERF-03](./PERF-03.md) Step A only** — shared-browser test pattern,
   single-file validation. Cheapest possible test of the single biggest
   known lever (39 test files × ~2.4–2.9s launch each, dwarfs every
   protocol-level number measured so far). Zero library changes. Do this
   first — it tells you whether further perf investment is worth it before
   committing to anything else below.
2. **[PERF-01](./PERF-01.md)** — BiDi duplicate-subscription cleanup (4
   spots, not the 1 originally documented). Quick, mechanical, same shape
   as work already shipped. No reason to delay.
3. **[PERF-05](./PERF-05.md)** — Phase 5a, background BiDi connect in
   `Browser.launch()`. The connect-time gap is quantified (~300–500ms),
   the design questions are already scoped, and the "wait until validated
   in the wild" condition from the original notes is now satisfied — we
   have real-app numbers.
4. **[PERF-06](./PERF-06.md)** — Phase 5b, rename/simplify `enableBiDi`.
   Explicitly sequenced after PERF-05 lands; also a breaking public-API
   decision — this file presents options, doesn't pick one for you.
5. **[PERF-03](./PERF-03.md) Step B** — cross-file browser sharing. Only
   after Step A's numbers justify it, and only after spiking the
   still-fully-open chromedriver multi-client question (see the file).
6. **[PERF-04](./PERF-04.md)** — auto-wait single-round-trip collapse.
   Verification found this is ~2–3x bigger in scope than originally
   documented (3 independent poll loops, not 1) and the highest-risk item
   here (hot path touching nearly every public method). Do after the
   lower-risk items above, and only after adding the poll-heavy benchmark
   the file calls for.
7. **[PERF-02](./PERF-02.md)** — Firefox BiDi-connect retry-loop
   investigation. Independent of everything else; Chrome numbers aren't
   affected either way. Slot in whenever.
8. **[PERF-07](./PERF-07.md)** — driver startup flags investigation.
   Lowest priority, explicitly "cheap to check once PERF-03 lands." Do
   last.

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
