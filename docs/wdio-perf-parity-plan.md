# craftdriver → WebdriverIO perf‑parity: investigation & fix plan

**Goal:** make craftdriver with `enableBiDi: true` **at least as fast as WebdriverIO** across the
`craftdriver-perf` suite (stretch: faster). This doc is written to be executed in a *fresh* session —
it is self‑contained: it carries the measured data, the confirmed root causes, the exact code
locations in **both** repos, the experiments to run, and the success criteria.

Repos (all are local working dirs):
- craftdriver: `/Users/admin/git/craftdriver` (the code to optimize; imports from `src`, ships `dist`)
- perf harness: `/Users/admin/git/craftdriver-perf` (benchmarks; `craftdriver` symlinks → `../../craftdriver/dist`)
- WebdriverIO: `/Users/admin/git/webdriverio/packages` (reference implementation)

---

## Status (2026-07-05)

- ✅ **Round-trip counter** — implemented (`src/lib/instrument.ts`, wired into `http.ts` +
  `bidi/connection.ts`). See §1.
- ↩️ **Gap C** (visibility wait re-finds every poll) — strategy (a) was implemented, measured, then
  **reverted on review**. The win was real but small (~4–9ms wall-clock) and lived entirely on the
  `By` path — caching the first-resolved element there changes `findElement`'s "current match in
  document order" semantics to "fixed identity until stale", a flakiness source under dynamic DOM
  (coexisting old/new nodes during transitions, prepended matches; stale-invalidation does not cover
  an attached-but-no-longer-first node). Not worth it: strategy (b) also ruled out on evidence.
  **The counter still proved the residual gap is in navigate + startup, not the visibility poll** —
  so Gap B and Gap A are where the wdio gap actually lives. See §2 "Measured outcome".
- 🔬 **Gap A** (BiDi startup cost, +142 vs wdio) — H-A1 **refuted** (backoff never fires; initBiDi is
  only ~33ms). The cost is in `POST /session` spinning up the chromium-bidi mapper, **inside
  chromedriver, not craftdriver's connect path**. Next: compare wdio's `POST /session` wall time
  before investing — the +142 may be capability flags or just machine variance. See §4.
- ❌ **Gap B** (navigate under the mapper, +8) — **REFUTED**. Routing `'load'` through BiDi
  `browsingContext.navigate` measured **slower**, not faster: navigate 28→57 (+29), heavy-network
  184→1326 (+1142, a 7× regression). Two independent causes, and the premise itself was a misread —
  **wdio's benchmark navigates Classic** (`wdio:enforceWebDriverClassic: true`), so there was never a
  BiDi-navigate speedup to match. Change reverted; committed Classic-first-for-`'load'` is correct and
  already competitive. See §3 "Measured outcome". Gap B is **closed** — no craftdriver-side navigate lever.

---

## 0. Where we stand (measured)

Per‑scenario **median ms** (lower = better). `cd-opt` = craftdriver `enableBiDi:false` (classic),
`cd-bidi` = craftdriver `enableBiDi:true` (default), `wdio` = WebdriverIO (BiDi by default).
Source files: `craftdriver-perf/results/*.json` (baseline `cd-bidi` = pristine SHA `c69b01f`,
`2026-07-05T06:57`; `cd-opt` `06:59`; `wdio` `07:04`; loadavg ~2.3–2.8, comparable).

| scenario | cd-opt | cd-bidi | wdio | **cd-bidi − wdio** | ratio |
|---|---:|---:|---:|---:|---:|
| **startup** | 1731 | **2194** | 2052 | **+142** | 1.07× |
| **heavy network: navigate+wait-visible** | 137 | **211** | 170 | **+41** | 1.24× |
| **wait for visible (delayed reveal)** | 101 | **101** | 87 | **+15** | 1.17× |
| **navigate** | 23 | **33** | 25 | **+8** | 1.34× |
| screenshot | 50 | 50 | 51 | −1 | 0.98× |
| click x10 | 460 | 471 | 485 | −14 | 0.97× |
| combo | 359 | 362 | 392 | −30 | 0.92× |
| keyboard | 92 | 96 | 158 | −62 | 0.61× |
| locate x10 | 124 | 124 | 192 | −68 | 0.65× |

**Read this carefully — it reframes the whole effort:**
- craftdriver is **already faster than WDIO** on locate, keyboard, click, combo, screenshot. Do **not** touch those.
- Only **4 gaps** exist, and they are the *same two root causes* wearing different hats:
  - **A. BiDi connect cost** → `startup` (+142).
  - **B. Navigation under the mapper** → `navigate` (+8), and it feeds `heavy network`. *(The +8 is real,
    but it has no craftdriver-side fix — routing via BiDi navigate was tried and measured 7× slower; see
    §3 "Measured outcome". The tax is the mapper observing the Classic navigate, inherent to BiDi mode.)*
  - **C. Element‑visibility waiting does 2× the round trips** → `wait for visible` (+15), and it dominates `heavy network` (+41).
- The `heavy network` gap (+41) ≈ the navigate gap + the wait‑visible gap amplified by ~45 in‑flight requests.
- **Not** the cause (already investigated, ruled out with evidence): network‑event *subscription*. Making it lazy changed heavy‑network by ~0ms (0 events vs 45, same wall clock). Do not re‑chase this.

---

## 1. Measurement methodology (do this first, and after every change)

Machine drift on this box is real (seen 4× swings under load). Control it:

1. Start the perf fixture server: in `craftdriver-perf`, `npm run serve` (serves `./fixtures` on `:8081`).
2. Export the pinned driver: `export CHROMEDRIVER_PATH=~/.cache/craftdriver/chromedriver/149.0.7827.201/mac-x64/chromedriver`.
3. Rebuild craftdriver after each change: in `craftdriver`, `npx tsc -p tsconfig.json` (the perf suite loads `dist`).
4. Run **A/B back‑to‑back in the same session** (never compare to an old JSON across machine states):
   - `cd craftdriver-perf/suites/craftdriver && CHROMEDRIVER_PATH=… HEADLESS=true PERF_BASE_URL=http://127.0.0.1:8081 ../../node_modules/.bin/vitest run --config vitest.config.ts`
   - Also run `bench:craftdriver:optimized` (classic) and `bench:wdio` in the same session for a live 3‑way.
   - Reduce iterations while iterating: `PERF_ITERATIONS=12 PERF_WARMUP=2 PERF_STARTUP_ITERATIONS=6`.
5. Record `loadavg` (harness already stores it in the JSON `env`); discard runs where loadavg > ~3.5.
6. Full suite runs >2min — run it **backgrounded** and poll the written `results/*.json`, don't foreground it.

Add a **round‑trip counter** before you start (single most useful instrument):
wrap `HttpClient.send` in `craftdriver/src/lib/http.ts` (or `Driver`'s per‑call `new HttpClient`) to
increment a global counter, and count BiDi frames in `bidi/connection.ts`. Print `#classicRT` and
`#bidiFrames` per scenario. Every hypothesis below is ultimately "reduce round trips"; measure them directly.

> **✅ Implemented** — `src/lib/instrument.ts` exports `roundTrips` (`classicRT` / `bidiSent` /
> `bidiRecv`) plus `resetRoundTrips()` / `snapshotRoundTrips()`. `http.ts:send` increments
> `classicRT`; `bidi/connection.ts` increments `bidiSent` (per command) and `bidiRecv` (per frame).
> It's diagnostic, kept **off** the public API — deep-import it from a measurement script:
> `import { snapshotRoundTrips } from 'craftdriver/dist/lib/instrument.js'`. Reset before a timed
> block, snapshot after, diff. Cost is one integer increment per round trip — always on.

---

## 2. Gap C (do first — highest ROII, confirmed root cause): visibility wait re‑finds every poll

**Symptom:** `wait for visible` +15ms (1.17×) and the bulk of `heavy network` +41ms. Present in **both**
`cd-opt` and `cd-bidi` (101 vs 101) → this is **not** BiDi‑specific; it's a Classic round‑trip inefficiency.

**Confirmed root cause (from code, not hypothesis):**
`craftdriver/src/lib/wait.ts:95‑103` — `until.elementIsVisible` calls `resolveElement` (a fresh
`driver.findElement`, `wait.ts:67‑70`) **and** `el.isDisplayed()` **on every poll iteration**.
`WebDriverWait.until` (`wait.ts:35‑49`) polls at `DEFAULT_POLL_INTERVAL_MS = 25` (`timing.ts:21`).
→ **2 Classic HTTP round trips every 25ms** while waiting. The `expect().toBeVisible()` path
(`expect.ts` `toBeVisible` → `driver.wait(until.elementIsVisible(by))`) and `locator.ts:_waitForVisible`
(`locator.ts:138‑175`, re‑runs `_findFinal()` each loop) have the same shape.

**What WDIO does (faster):**
- `webdriverio/src/commands/element/waitForDisplayed.ts` polls `isDisplayed()` at `waitforInterval = 100ms`
  (`wdio-config/src/constants.ts:18`) — 4× fewer polls.
- The element ref is **resolved once** and cached on the `$` object; polls do **not** re‑find.
- `webdriverio/src/commands/element/isDisplayed.ts` runs a **single in‑browser script**
  (`webdriverio/src/scripts/isElementDisplayed.ts`) that computes visibility (viewport/opacity/
  content‑visibility) in one round trip, instead of the Classic `/displayed` endpoint.

**Experiments:**
1. With the round‑trip counter, log `#classicRT` for the `wait for visible` scenario, current vs each fix.
2. A/B three visibility‑wait strategies in `until.elementIsVisible` / a new helper:
   - (a) **cache the element**: resolve once, re‑check `isDisplayed()` each poll, re‑find only on stale/`no such element`.
   - (b) **single round trip**: one `executeScript`/BiDi `script.callFunction` that locates *and* checks visibility, returning `{found, visible}`.
   - (c) keep 25ms but only when close to reveal; otherwise back off. (Least important — interval isn't the main cost, round‑trips are.)

**Fix sketch:** implement (a) first (small, safe); measure; if still short of WDIO, add (b). Keep the 25ms
responsiveness (it's a craftdriver strength — do not regress to 100ms unless round‑trips are the proven cost).

**Files to change:** `wait.ts` (`until.elementIsVisible`, `elementIsNotVisible`), `locator.ts`
(`_waitForVisible`/`_waitForAny`), `expect.ts` (`pollElement`, `toBeVisible`). Keep behavior identical; only cut round trips.

**Success:** `wait for visible` median ≤ 87 (wdio); `heavy network` drops by the same delta.

### Measured outcome (2026-07-05, strategy (a) measured then reverted on review)

Round-trip counter added (`src/lib/instrument.ts`, wired into `http.ts` + `bidi/connection.ts`).
Strategy (a) — cache the element in `until.elementIsVisible`/`elementIsNotVisible`, re-check
`isDisplayed()` each poll, re-find only on stale — implemented and measured.

- **RT counter confirms the fix:** `heavy network` toBeVisible poll loop **4–8 → 2–3 classicRT**;
  `wait for visible` **7 → 6 classicRT**. The redundant per-poll `findElement` is gone.
- **Same-session wall-clock A/B** (before = no cache, after = cache; both keep the counter):
  `wait for visible` **100 → 96**, `heavy network` **201 → 192**. Winning scenarios unregressed
  (locate 125→125, click 476→467, combo 360→359, screenshot 51→52). Note the *after* run
  executed under **higher load** (loadavg 3.27 vs 2.49) yet still came out lower on both target
  scenarios — the win overcame a load handicap, so it's real, but small (~4–9ms).
- **Did NOT reach wdio parity** (wait-visible 96 vs 87; heavy-network 192 vs 170). The counter
  explains why: these waits make only **2–3 round trips** and are dominated by genuine browser
  wait time (the 96 fetches + render), not protocol overhead. **Strategy (b)** (single in-browser
  script that locates *and* checks visibility) would save only the remaining ~1 RT (~2–4ms) at real
  cross-browser correctness risk — **not worth it on this evidence; do not implement (b).**
- **Conclusion:** **reverted (a).** The premise that it was "small, safe, behavior-identical" was
  wrong: the win lives entirely on the `By` path, where caching the first-resolved element changes
  `findElement`'s "current first match in document order" semantics into "fixed identity until
  stale". Under dynamic DOM (coexisting old/new nodes during a transition, a matching node prepended
  ahead of the cached one) the cached node can stay **attached but hidden** while the real target is
  a *different* current match — and stale-invalidation does **not** cover that (the node isn't
  removed). That's a nondeterministic flake source (race between DOM mutation and the 25ms poll),
  traded for a sub-10ms win in a spot the counter itself proves is **browser-bound, not
  round-trip-bound** — a bad trade under the flake policy. The `WebElement` path never did a round
  trip, so there was no safe subset to keep. Kept the round-trip counter (it earned its place). The
  residual gap to wdio lives in **navigate (Gap B)** and **startup (Gap A)**, not in the visibility
  poll — pursue those next.

---

## 3. Gap B: navigation is slower under the mapper because craftdriver navigates Classic

**Symptom:** `navigate` cd-opt 23 → cd-bidi 33 (+10 from being in BiDi mode) vs wdio-bidi **25**.
i.e. WDIO's BiDi navigate ≈ craftdriver's *classic* navigate, while craftdriver's *bidi‑mode* navigate is +10.

**Hypothesis (validate):** in BiDi mode the chromium‑bidi mapper adds latency to the **Classic**
`POST /url` navigate (mapper observes the navigation, fires lifecycle events); doing the navigation via
**BiDi `browsingContext.navigate`** avoids that and is net faster. craftdriver deliberately chose
"Classic‑first for `waitUntil:'load'`" (`browser.ts:navigateTo` ~654‑686; `needsBiDi = waitUntil!=='load' || hasInitScripts`).
The perf data suggests that decision is wrong *when the BiDi socket is already connected*.

**What WDIO does:** `webdriverio/src/commands/browser/url.ts:159‑279` — always uses
`this.browsingContextNavigate({ context, url, wait })` in BiDi mode (maps `pageLoadStrategy`/`wait` to a
BiDi wait state), with a Classic `navigateTo` **fallback** only on the concurrent‑navigation error.

**Experiment:** add a craftdriver navigate variant that routes through `browsingContext.navigate` (wait:
`complete` for `'load'`) whenever `bidiSession.isConnected()`, and A/B the `navigate` + `heavy network`
scenarios. Count round trips + measure.

**Risk / why it was Classic‑first:** mixing Classic navigate with an immediately following BiDi
`script.callFunction` can hit "execution contexts cleared" (see the retry loop in `browser.ts:evaluate`
~1272‑1293). Navigating via BiDi should *reduce* that race, but verify the `navigate`→`find` handoff and
the `waitForLoadState` path still pass. Run `tests/` navigation + load‑state specs.

**Files to change:** `browser.ts:navigateTo`, `page.ts:navigateTo` (already has a BiDi branch — check why
the default‑context `'load'` path prefers Classic and flip it when connected). Keep the Classic fallback.

**Success:** `navigate` median ≤ 25 (wdio); contributes to `heavy network`.

### Measured outcome (2026-07-05, Gap B REFUTED — do not route `'load'` via BiDi)

Implemented the change (BiDi-first `browsingContext.navigate` for all navigations when the socket is
connected, Classic fallback on the concurrent-navigation race, in both `Browser.navigateTo` and
`Page.navigateTo`), gated behind a temporary `CRAFTDRIVER_NAV_CLASSIC` env so both paths run from one
build. A/B'd it four ways. Every measurement says **BiDi navigate is slower on Chrome**; the change was
reverted.

**1. The premise was a misread of the reference.** The perf suite's wdio numbers (navigate 25,
heavy-network 170) are **Classic** navigation, not BiDi. `suites/wdio/capabilities.ts` sets
`'wdio:enforceWebDriverClassic': true`, which stops wdio from requesting `webSocketUrl`
(`webdriver/src/utils.ts:84`) → no BiDi socket → `browser.url()` takes the Classic `else` branch
(`url.ts:289`), never `browsingContextNavigate`. So "wdio's BiDi navigate ≈ craftdriver's classic
navigate" is trivially true — *both are Classic*. There is no faster BiDi navigate to match. Appendix B's
`url.ts:159-279` BiDi path is dead code under this benchmark's config.

**2. Same-session wall-clock A/B** (one build; `CRAFTDRIVER_NAV_CLASSIC=1` = old Classic-first =
committed, unset = new BiDi-first; `PERF_ITERATIONS=12`):

| scenario | BiDi-first (new) | Classic-first (committed) | delta |
|---|---:|---:|---:|
| **navigate** | **57** | **28** | **+29** |
| **heavy network: navigate+wait-visible** | **1326** | **184** | **+1142 (7×)** |
| keyboard | 107 | 96 | +11 |
| combo | 379 | 371 | +8 |
| startup / screenshot / locate / click / wait-visible | ~equal | ~equal | ~0 |

Nothing improved; navigate and heavy-network regressed hard. (Both runs' loadavg was elevated ~4.5–6.5,
above §1's 3.5 bar — but a 7× heavy-network gap dwarfs any load effect and is corroborated below.)

**3. Round-trip counter (deep-imported) pins the mechanism.** navigate: BiDi = `classicRT=0 bidiSent=1`
(~49–72ms) vs Classic = `classicRT=1 bidiSent=0` (~30–61ms) — *same one round trip*, but the BiDi
navigate round trip is simply slower on Chrome. The Classic `POST /url` is observed by the mapper
regardless, so BiDi transport saves nothing and adds its own cost (matches the repo's prior finding that
BiDi navigate is ~50ms slower than Classic on Chrome). heavy-network: the `browsingContext.navigate
{ wait:'complete' }` **command itself blocks 1268–1497ms**; Classic navigate 67–157ms.

**4. Wait-state probe = root cause of the heavy-network block.** BiDi `wait:'complete'` blocks ~1300ms
**only on heavy→heavy transitions** (navigating from one network-heavy page directly to another). With a
light page in between, light→heavy is ~180ms. Classic navigate never blocks. **Bench scenario 8 navigates
`heavy-network.html` repeatedly (`run++`), so every sample is heavy→heavy** — BiDi-first hits the block on
every iteration. `wait:'none'`/`'interactive'` sidestep the block but change load semantics (return before
`load`) — there is no variant that is both correct-for-`'load'` and faster.

**5. Handoff is fine — the refutation is purely about speed.** navigate→find→evaluate under BiDi-first
completed correctly (title read back, **no "execution contexts cleared" thrown**). So the risk the plan
flagged didn't materialize; BiDi-first is *correct*, just slower. (The "execution contexts cleared" race
lives on the *Classic-navigate → BiDi-evaluate* seam the committed code deliberately keeps, covered by the
`evaluate()` retry loop — that seam is unchanged.)

**Conclusion:** keep the committed **Classic-first-for-`'load'`** routing. It already matches how wdio
navigates in this benchmark (both Classic) and already wins or ties every scenario. The residual cd-bidi
navigate tax (+8–10 vs cd-opt) is the mapper *observing* the Classic navigate — inherent to running in
BiDi mode — and routing via BiDi makes it worse. The only lever that could erase it is not running the
mapper at all (the Gap A "do we even request BiDi at launch?" question), **not** a navigate change. Gap B
is closed. Reverted to baseline; guardrails 25/25 green. The temp `CRAFTDRIVER_NAV_CLASSIC` gate and
BiDi-first code were removed; the round-trip counter (§1) is kept.

---

## 4. Gap A: BiDi connect adds ~463ms to startup (vs classic); WDIO's is lighter

**Symptom:** startup cd-opt 1731 → cd-bidi **2194** (+463 for BiDi bring‑up) vs wdio **2052** (+142 over cd‑bidi target).

**Hypotheses (instrument, in priority order):**
- **H‑A1 (highest suspicion): connect retry backoff is firing.** `browser.ts:initBiDi` (~520‑550) retries
  `session.connect` up to `BIDI_CONNECT_MAX_ATTEMPTS` with `BIDI_CONNECT_BACKOFF_STEP_MS = 300` (`timing.ts:107`)
  ×attempt. If the WS isn't ready on attempt 1 (common immediately after `POST /session` on Chrome), craftdriver
  sleeps **300ms** before retrying → could be most of the 463. **Add a log/timer around each attempt** and see
  if attempt 1 fails. Fix: poll WS readiness on a short cadence (e.g. 20–50ms) instead of a 300ms first backoff,
  or connect the WS eagerly right after the session response exposes `webSocketUrl`.
- **H‑A2: eager `getTree` + `subscribe(5 events)` at connect.** `bidi/index.ts:connect` does a `getTree` +
  a 5‑event `session.subscribe` before returning. WDIO (`webdriver/src/index.ts:newSession` 55‑86) connects the
  socket and attaches a message handler but **subscribes to nothing** (lazy managers arm later —
  `webdriverio/src/session/networkManager.ts`, `session.ts`). Consider deferring the lifecycle subscribe/getTree
  to first `activePage`/navigate. Note the tradeoff: `activePage`/dialogs/`waitForLoadState` need those events,
  so measure that it doesn't just move the 142ms into the first navigation.

**Experiment:** instrument `initBiDi`/`connect` with phase timers: `POST /session`, WS‑open, getTree, subscribe.
Print the breakdown for 10 launches. That single number tells you whether it's H‑A1 (a 300ms step) or H‑A2 (round trips).

**Files to change:** `browser.ts:initBiDi` + `launch`, `bidi/connection.ts:connect` (~46‑89), `bidi/index.ts:connect`.

**Success:** startup median ≤ 2052 (wdio); if H‑A1 is real, expect ≤ ~1900 (beating WDIO).

### Measured outcome (2026-07-05, H-A1 REFUTED)

Env-gated phase timers (`CRAFTDRIVER_LAUNCH_TRACE`) around `initBiDi` / BiDi `connect` / `builder.build`,
profiled over **8 back-to-back Chrome launches**:

| phase | median | note |
|---|---:|---|
| `session-create` (`builder.build` = `POST /session`) | **~2230ms** | dominates every launch |
| ws-open | ~1–2ms | |
| getTree + subscribe (5 events, one parallel batch) | ~30ms | H-A2 is small |
| **initBiDi total** | **~33ms** | connect succeeds on **attempt 1, every time** |

- **H-A1 is refuted:** the 300ms connect backoff **never fires** — `attempt=1` succeeded on all 8
  launches. There is no retry sleep to eliminate. Do not chase the backoff.
- **H-A2 is minor:** getTree+subscribe is ~30ms total; deferring it could save at most that, and it
  would move dialog/`activePage`/`waitForLoadState` cost into the first navigation (the tradeoff the
  plan already flagged). Not worth it.
- **Where the BiDi startup tax actually is:** `POST /session` itself. Requesting `webSocketUrl:true`
  (+ `unhandledPromptBehavior`) makes chromedriver spin up the chromium-bidi **mapper** as part of
  session creation — that is the ~+463ms vs Classic, and it is **inside chromedriver/Chrome, not in
  craftdriver's connect path**. craftdriver has little leverage here without changing *whether* it
  asks for BiDi at launch.
- **Open question for whoever picks up Gap A next** (needs a same-session A/B, not yet run): does
  wdio's session-create measure faster than craftdriver's *with BiDi requested*? If yes, the +142
  vs wdio is in capabilities/mapper flags, not connect. If they're equal, the +142 is noise/machine
  variance and Gap A is effectively closed. **Instrument `startWebDriverSession` in wdio the same
  way and compare `POST /session` wall time before spending more here.**
- **Instrumentation status:** the `CRAFTDRIVER_LAUNCH_TRACE` timers were **removed** after this
  measurement (temporary debug `console.error`s — not shipped). Re-add if resuming Gap A. The
  round-trip counter (§1) is kept.

---

## 5. Execution order & success criteria

Order by ROI / confidence:
1. ~~**Gap C**~~ ↩️ **Reverted** — strategy (a) cut RT as designed but only ~4–9ms wall-clock, and the
   `By`-path caching that produced the win changes visibility-wait semantics (fixed identity vs.
   current first-match) — a flakiness risk under dynamic DOM not worth a sub-10ms, non-bottleneck win.
   The measured lesson stands: `wait for visible` / `heavy network` are **browser-bound, not
   round-trip-bound**, so the remaining wdio gap is *not* here. See §2.
2. **Gap A / H‑A1** (potential ~300ms quick win on `startup` if the backoff is firing — cheap to
   check first) — **do this next.** Now the largest confirmed gap (+142) and cheapest to instrument.
3. ~~**Gap B**~~ ❌ **Refuted** — routing `'load'` via BiDi navigate measured 7× *slower* on heavy-network
   and +29ms on navigate; the wdio reference numbers were Classic navigation all along
   (`enforceWebDriverClassic`). Reverted. No craftdriver-side navigate lever exists — see §3.
Re‑measure the full 3‑way (cd-bidi / cd-opt / wdio) after **each** change; keep only changes that move the needle without regressing the scenarios craftdriver already wins.

**Definition of done:** `cd-bidi` median ≤ `wdio` median on all 9 scenarios (same‑session run, loadavg matched),
with **no** regression on locate/keyboard/click/combo/screenshot. Stretch: `cd-bidi` within ~10% of `cd-opt`
on navigate + wait‑visible (i.e. the BiDi tax on the hot commands ≈ eliminated).

**Guardrails:** after each change run craftdriver's own tests — `HEADLESS=true EXAMPLES_BASE_URL=http://127.0.0.1:8080 vitest run tests/network.test.ts tests/wait-for-network.test.ts tests/tracing.test.ts tests/waiting.test.ts` (start `npm run serve` for the examples server on :8080 first). All must stay green.

---

## Appendix A — craftdriver code map (the hot paths)

- Launch / BiDi bring‑up: `src/lib/browser.ts` `launch` (~388‑515), `initBiDi` (~520‑550).
- BiDi connection: `src/lib/bidi/connection.ts` `connect` (~46‑89), `send`/`subscribe`.
- BiDi session batch: `src/lib/bidi/index.ts` `connect` (getTree + lifecycle subscribe; network now lazy).
- Navigation: `src/lib/browser.ts` `navigateTo` (~654‑686), `src/lib/page.ts` `navigateTo` (~127‑160).
- Visibility waits: `src/lib/wait.ts` (`WebDriverWait`, `until.elementIsVisible` 95‑103), `src/lib/locator.ts`
  (`_waitForVisible` 138‑175), `src/lib/expect.ts` (`pollElement` 73‑93, `toBeVisible`).
- Classic transport: `src/lib/driver.ts` (each method makes `new HttpClient(...).send`), `src/lib/http.ts`.
- Timing constants: `src/lib/timing.ts` (`DEFAULT_POLL_INTERVAL_MS=25`, `BIDI_CONNECT_BACKOFF_STEP_MS=300`, …).

## Appendix B — WebdriverIO reference map

- Session init (eager connect, **no** subscribe): `packages/webdriver/src/index.ts` `newSession` (55‑86).
- Auto‑BiDi opt‑in + `unhandledPromptBehavior`: `packages/webdriver/src/utils.ts` `startWebDriverSession` (60‑99).
- BiDi socket/core: `packages/webdriver/src/bidi/{core,handler,socket}.ts`.
- Lazy per‑concern managers (the pattern): `packages/webdriverio/src/session/session.ts` (`SessionManager`
  singleton + teardown), `networkManager.ts`, `context.ts`, `dialog.ts`.
- Navigate via BiDi: `packages/webdriverio/src/commands/browser/url.ts` (159‑279).
- Visibility: `packages/webdriverio/src/commands/element/waitForDisplayed.ts`, `isDisplayed.ts`,
  `packages/webdriverio/src/scripts/isElementDisplayed.ts`.
- Defaults: `packages/wdio-config/src/constants.ts` (`waitforInterval:100`, `waitforTimeout:5000`).

## Appendix C — what NOT to do (already ruled out with evidence)

- **Lazy network‑event subscription** is already implemented (this working tree) and is correct/zero‑risk,
  but it does **not** move `heavy network` (0 vs 45 events, same wall clock — events overlap I/O). Keep it for
  hygiene/very‑heavy real sites, but it is **not** a perf lever for this suite. Don't re‑investigate it.
- Don't "fix" locate/keyboard/click/combo — craftdriver already beats WDIO there; protect those.
