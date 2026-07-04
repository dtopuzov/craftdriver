---
name: craftdriver-engineering
description: >
  Engineering standards for DEVELOPING craftdriver (the library itself) — not
  for using it. Load when modifying src/, adding or changing public API, making
  a performance claim or change, writing/triaging tests, editing docs/, or
  recording a design decision in this repo. Encodes the evidence discipline,
  flake policy, API-review checklist, and protocol-strategy rule the project
  runs on.
---

# craftdriver engineering standards

Internal, maintainer-facing. **North star: every claim is backed by a number or
a test** — perf claims by benchmarks, correctness by CI, ergonomics by real
usage. Adjectives ("fast", "robust") are not evidence.

## Evidence discipline (the non-negotiable one)

- **No perf-motivated change without before/after numbers** in the PR/commit
  description — including your own commits. Measure the touched path against a
  clean baseline (`git stash` the change, run the same bench both ways).
- **Evidence hierarchy when choosing a design:** measured number > reference
  implementation behavior (read wdio/Playwright source) > spec text > intuition.
  When intuition disagrees with a measurement, the measurement wins. (Case in
  point: BiDi navigate was *assumed* free transport; it measured ~50ms slower
  than Classic on Chrome, which reversed the decision.)
- A premise that sounds obvious is a hypothesis until measured. Perf premises in
  this repo have repeatedly over-attributed cost to round-trip *count* when the
  real cost was process boot or fixed sleeps. Profile where time actually goes.

## Correctness

- **Test pyramid honesty.** Browser-driving integration tests are the product
  truth — keep them primary. Pure-logic modules (selector parsing,
  serialization, timing math) get fast unit tests so failures localize.
- **Flake policy.** A flaky test is a bug in the library or the test, never
  "weather." Quarantine + tracking issue + triage. **Zero automatic retries in
  CI** — retries bury the exact races users will hit (the "execution contexts
  cleared" bug is that class of thing).
- **Cross-browser or documented.** A change works the same on chrome, chromium,
  and firefox, or it documents the gap. BiDi is young; browsers break it between
  releases.
- **W3C discipline.** Test against the BiDi spec's semantics, not "what Chrome
  happens to do." Note the spec section a feature implements.

## Public API is a reviewed artifact

Before merging any new/changed public method:
1. **Side-by-side with Playwright and wdio equivalents.** Where craftdriver
   differs, the difference is deliberate and documented — not an accident.
2. **Error messages state selector, timeout, and what was expected.** Every
   public throw is a `CraftdriverError` with a stable `code`.
3. **Cross-browser parity** (above), or a documented gap.
4. **The public type surface change is intentional** — regenerate and diff the
   API reference (`npm run docs:api:check`); an unreviewed surface change is a bug.
5. **Semver + deprecation.** Deprecate with a runtime warning one minor before
   removal, with a migration note. Trust is a feature.

## Protocol strategy is explicit, not emergent

Rules for choosing Classic vs BiDi per command live in **one documented place**,
not scattered as per-method heuristics. **Every protocol-mixing seam is a future
race condition.** When you must mix (e.g. Classic navigate → BiDi evaluate), name
the barrier that makes it safe or add the retry that covers its absence — don't
leave it implicit.

## Docs that can't rot

- **Every snippet in `docs/` should be executable** and exercised against
  `examples/` pages, so a snippet that stops working is a build failure, not a
  user's discovery.
- Three layers, kept deliberate: generated API reference (`npm run docs:api`) →
  task guides (`docs/*.md`) → runnable examples (`examples/`).

## Decision records

Research that led to a direction gets a short record so context survives
branches and months. **Delete or mark done when it lands — a stale plan is worse
than none.** Keep `plans/` to *pending, actionable* work; move resolved
decisions to `docs/` (or git history + memory) and remove them from `plans/`.

## Release & changelog

Changelog per release has three sections: features, fixes, **performance (with
numbers)**. Making perf a standing changelog section forces the measurement
habit and markets the priority.
