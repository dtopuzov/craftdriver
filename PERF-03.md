# PERF-03: Shared-browser test pattern (`newContext()` instead of per-file launch)

## Description

This is the single biggest known lever in this whole plan — bigger than
every protocol-level optimization done this session combined.

`Browser.launch()` alone costs **~2.4–2.9s** (localhost Chrome headless,
measured by `tests/perf/bidi-vs-classic.perf.ts`'s connect-time-only case),
regardless of `enableBiDi`. That's chromedriver process spawn + Chrome
process spawn + capability negotiation, none of which any protocol-level
change touches. Every file under `tests/*.test.ts` does its own
`beforeAll(() => Browser.launch())` / `afterAll(() => browser.quit())` —
confirmed still 39 files today, 34 using `beforeAll`, 36 referencing
`Browser.launch`. With `vitest.config.ts`'s `pool: 'forks'` (confirmed
still the config) and `maxWorkers = floor(cpus/2)`, that's roughly
9-10 files run sequentially per worker — tens of seconds of pure
launch/quit overhead per worker, every single test run, dwarfing any
per-command protocol difference this project has been optimizing (which
moves things by tens of milliseconds, not seconds).

`browser.newContext()` already exists (`src/lib/browser.ts:1820-1866`) and
creates a genuinely isolated BiDi user context — own cookies, storage,
permissions — via a single `browser.createUserContext` BiDi call
(`browser.ts:1852`; note: not `browsingContext.create` as an earlier draft
of this doc said). This is architecturally the same idea behind Playwright
Test's reputation for speed: reuse one browser process, hand each test a
fresh isolated context instead of a fresh process. **It requires BiDi** —
`newContext()` throws `'newContext() requires BiDi (enableBiDi: true)'`
under `enableBiDi: false` (`browser.ts:1845-1849`), so this pattern only
applies to BiDi-enabled test runs.

## Implementation

Two stages, and the second is explicitly conditional on the first:

### Step A — validate the hypothesis (do this first, cheap, no library changes)

Pick one existing multi-file test area (or a couple of related small
files) and convert it to a single file with nested `describe` blocks: one
shared `beforeAll` that does one `Browser.launch()`, and each `describe`
gets `browser.newContext()` instead of its own launch. Pure
test-authoring — zero changes to `src/lib/*`. Measure wall-clock time for
that file/area before and after (`time npx vitest run tests/<converted>.test.ts`
or equivalent). This confirms the real magnitude of the win in this
specific codebase, on this hardware, before any further investment.

**If Step A's numbers don't show a meaningful win** (e.g. worker
parallelism already amortizes the launch cost more than expected), stop
here — don't build Step B speculatively. If they do show a big win, it
tells you exactly how much is on the table and justifies Step B.

### Step B — cross-file sharing (only if Step A justifies it)

The harder design: a vitest `globalSetup` that launches one `Browser`,
writes its connection info (session id, endpoint, BiDi WS URL) somewhere
test files can read (env var / temp file), and a small `attachBrowser()`
helper that reconnects to the *same* running chromedriver session from
each forked worker instead of calling `Browser.launch()` fresh.

**Before designing this further, resolve the one fully open risk this
plan carries:** nothing in this repo has verified whether chromedriver
tolerates multiple concurrent HTTP clients hitting the same `sessionId`,
or whether a second BiDi WebSocket connection to the same session's
`webSocketUrl` is workable. This needs an actual spike, not an assumption:

- Write a small standalone script (not part of the test suite) that opens
  two concurrent Node HTTP clients against one chromedriver session and
  two concurrent WebSocket connections to that session's BiDi endpoint,
  and confirms both can issue commands without interfering with each
  other.
- **If it holds:** proceed with the `globalSetup` + `attachBrowser()`
  design above.
- **If it doesn't hold:** fall back to `pool: 'threads'` (instead of
  `'forks'`) + a serializable "attach, don't relaunch" `Driver`/
  `BiDiSession` constructor path, since threads can share the live
  `Browser` object by reference without needing multiple transport
  connections at all.

## Verification

- **Step A:** compare wall-clock time for the converted file/area
  before vs. after the conversion. This is the concrete number that
  decides whether Step B is worth pursuing.
- **Step B:** the standalone chromedriver multi-client spike script,
  before any of the `globalSetup`/`attachBrowser()` code is written.
  Once implemented: run the full suite with the new pattern and compare
  total wall time against today's baseline (`npm test` timing today vs.
  after), confirm test isolation still holds (no state leaking between
  tests that used to get a fresh process and now share one) by running
  the suite twice in a row and confirming no order-dependent flakiness.

## Risks

Step A: low — test-authoring only, easily reverted, no production code
touched. Step B: meaningfully higher — new cross-process coordination
code, a genuinely unverified protocol-level assumption to resolve first,
and a real risk of subtle test-isolation bugs if state leaks between
tests sharing one browser process (a bug class per-process isolation
made structurally impossible before). Don't start Step B's implementation
before the spike concludes.
