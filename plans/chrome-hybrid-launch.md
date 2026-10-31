# Plan A: hybrid Chrome launch (chromedriver attached for Classic + BiDi mapper in-process)

Status: proposed (2026-10-31). Owner decision needed at gates G0 and G3.
Companion: [chrome-driverless.md](chrome-driverless.md) (Plan B, the bigger
alternative). Plans A and B share the foundation tasks A2.1–A2.3.

## Read this first (agents)

- Load the `craftdriver-engineering` skill before touching `src/`. Its
  evidence rules are binding here, because this whole plan is a performance
  change:
  - no perf claim without paired before/after numbers;
  - run focused tests, not the full suite, except where this plan says
    otherwise;
  - no retries to hide flakes.
- Each task lists **Files**, **Do**, **Done when**, and **Gates**. Do not
  start a task until its dependencies are merged. Research tasks (`R`) produce
  a written answer appended to the "Research log" at the bottom of this file.
  Don't write production code in an R task.
- Evidence this plan is built on:
  `dtopuzov/driver-perf` → `docs/RESEARCH-2026-10-31-mapper-in-node.md`, plus
  benchmarks `bench/mapper-startup.mjs`, `bench/mapper-commands.mjs` and
  `bench/hybrid-interop.mjs`. Its `lib/chrome-direct.mjs` and `lib/modes.mjs`
  (`hybrid` mode) are a working, minimal reference implementation of
  everything in A2.

## Why

Today a default local Chrome launch (`enableBiDi` defaults to true) goes
through chromedriver's BiDi path. chromedriver builds the chromium-bidi
"BiDi-CDP Mapper" in a hidden tab during New Session. Measured on an Intel Mac,
Chrome 156, paired, against chromedriver Classic:

| mode | warm (n=20) | cold (n=10) |
|---|---:|---:|
| chromedriver BiDi (today's default) | +252 ms | +258 ms |
| **hybrid** (this plan) | **−160 ms** | **−30 ms** |
| driverless (Plan B) | −485 ms | −251 ms |

Warm means a later session in the same Node process; cold means a fresh Node
process, including the mapper module import (~143 ms).

So against today's default, hybrid saves **~410 ms warm / ~290 ms cold per
launch**, keeps every Classic command exactly as it is, and leaves Electron,
Firefox, Safari and remote untouched. Per-command cost is unchanged (measured:
Classic commands through an attached chromedriver equal plain Classic within
jitter).

Two facts shape the design:

- The mapper costs ~120 ms over raw CDP **wherever it runs**. The win comes
  from not making chromedriver launch Chrome and build the mapper tab.
- In hybrid, the remaining bottleneck is chromedriver's attach, ~900 ms after
  Chrome prints its DevTools URL, against ~500 ms for a raw CDP client.
  Task R5 investigates hiding it.

## Target architecture

```
today (BiDi on):
  craftdriver ──HTTP──▶ chromedriver ──launch──▶ Chrome
  craftdriver ──WS────▶ chromedriver ──CDP──▶ mapper tab ──CDP──▶ Chrome

hybrid:
  craftdriver ──spawn──────────────────────────────────▶ Chrome (--remote-debugging-port=0)
  craftdriver ──HTTP──▶ chromedriver ──CDP (attach via debuggerAddress)──▶ Chrome
  craftdriver ⟷ in-process chromium-bidi BidiServer ──CDP (ws)──▶ Chrome
```

Timeline: Chrome spawn and chromedriver spawn start together. When Chrome
prints `DevTools listening on ws://…`, the chromedriver attach
(`POST /session` with `goog:chromeOptions.debuggerAddress`) and the mapper
start (`MapperCdpConnection` → `BidiServer.createAndStart` → `session.new`)
also run concurrently.

Scope of the new path: **local, chrome-family, non-Electron, BiDi requested**.
Everything else keeps today's path unchanged.

## Gates

- **G0 (before any craftdriver code).** A1.1 shows a hybrid saving of at least
  **150 ms median paired** against chromedriver BiDi on `ubuntu-latest`, cold,
  with the same sign in ≥ 75% of pairs. If it doesn't, stop: on fast Linux
  boxes chromedriver's overhead may be small (David Burns' Chrome 147 numbers:
  chromedriver Classic only +142 ms over raw CDP).
- **G1 (after Phase 1 research).** No research item returns "blocker without a
  workaround". Blockers listed under each R task.
- **G2 (after Phase 3).** The full Chrome suite is green in hybrid mode on
  Linux, macOS and Windows CI, and `launch-critical-path.perf.ts` shows the
  saving in this repo (not just in driver-perf).
- **G3 (owner).** Flip the default, or keep hybrid opt-in. Decide after
  ≥ 2 weeks of the opt-in on CI with no hybrid-specific failures.

## Dependency decision (owner, before A2.3)

chromium-bidi is not small as an npm dependency. Measured install sizes:

| package | size |
|---|---:|
| chromium-bidi 157.0.8090-0 | 9.7 MB |
| zod (its dependency) | 8.1 MB |
| devtools-protocol (peer; types only) | 3.7 MB |
| **total** | **~21.5 MB** |

craftdriver's four runtime dependencies total ~4.3 MB today (ws 196 KB,
axe-core 3.3 MB, pngjs 704 KB, yazl 68 KB). Options:

1. **`optionalDependencies` + runtime detection (recommended).** Hybrid
   activates only if `import('chromium-bidi/...')` resolves, and otherwise
   falls back silently to today's path. Install-size-sensitive users can use
   `--omit=optional`.
2. **`peerDependencies` (optional peer).** Users who want hybrid run
   `npm i chromium-bidi`. Clean, but the speedup becomes opt-in by
   installation and most users never get it.
3. **Plain `dependencies`.** Simplest, and everyone pays the 21 MB.

A2.3 is written for option 1. If you pick another, only the loader in A2.3
changes.

---

## Phase 1: measure and de-risk

### A1.1 Linux/Windows CI measurement (gate G0)

- **Repo:** `dtopuzov/driver-perf` (not craftdriver).
- **Files:** new `.github/workflows/bench.yml`, and `lib/chrome-direct.mjs`
  (Chrome path per OS).
- **Do:**
  1. Workflow triggers: `workflow_dispatch` and `push` to `main`.
  2. Matrix: `ubuntu-latest`, `macos-latest`, `windows-latest`.
  3. Steps: `actions/setup-node` (Node 24), `npm ci`, then:
     - Set `CHROMEDRIVER` from the runner's `CHROMEWEBDRIVER` directory
       (`$CHROMEWEBDRIVER/chromedriver`, or `chromedriver.exe` on Windows).
     - Set `CHROME_BINARY` to the runner's Chrome (`which google-chrome` on
       Linux; the standard paths on macOS and Windows).
  4. Run `MODES=classic,cd-bidi,node-mapper,hybrid,raw-cdp ITERS=20 COLD_ITERS=10 node bench/mapper-startup.mjs`,
     then `node bench/hybrid-interop.mjs`.
  5. Upload stdout as an artifact.
  6. Fix whatever breaks on Linux or Windows, e.g. the stderr DevTools-URL
     parsing or `SIGKILL` on Windows (use `proc.kill()` there).
- **Done when:** three green runs exist, with numbers copied into the Research
  log, including the per-OS hybrid-vs-cd-bidi delta, same-sign count and
  jitter.
- **Gates:** G0 is evaluated on `ubuntu-latest`. Record macOS and Windows
  numbers too; they decide whether the default flip (G3) is per-OS.

### A1.2 (R1) What chromedriver does when it attaches

Answer each question with a scripted check: extend
`driver-perf/bench/hybrid-interop.mjs` or write a scratch script. Quote the
evidence.

1. Which `goog:chromeOptions` fields are honored with `debuggerAddress`?
   Specifically `prefs`, `mobileEmulation`, `args`, `binary`,
   `excludeSwitches`, `windowTypes`. Expected: only `mobileEmulation` and
   `windowTypes` (prefs and args are launch-time).
2. Does `DELETE /session` leave Chrome running? (Expected: yes; craftdriver
   must close Chrome itself.)
3. Are `unhandledPromptBehavior` and `pageLoadStrategy` honored on attach?
4. Do `/window/handles`, `/window` (switch) and new-window commands behave
   with the mapper's own CDP sessions present? The mapper attaches to every
   target with `Target.setAutoAttach`.
5. Does chromedriver's version-mismatch check still fire on attach? (The
   existing retry in `src/lib/builder.ts` depends on the error text.)

- **Blocker if:** attach mishandles windows or tabs in a way craftdriver's
  multi-page API (`openPage`, `activePage`, contexts) relies on.

### A1.3 (R2) Downloads

craftdriver sets `download.default_directory` through `goog:chromeOptions.prefs`
([src/lib/capabilities.ts](../src/lib/capabilities.ts)). In hybrid, nobody
sends those prefs. On top of that, the mapper's `BidiServer.createAndStart`
sends `Browser.setDownloadBehavior {behavior:'default', eventsEnabled:true}`,
which may override any directory set earlier.

- Test three options against `tests/file-transfer.test.ts`'s download
  scenario:
  1. Write `<userDataDir>/Default/Preferences` JSON with the same prefs before
     spawn.
  2. After the mapper starts, send `Browser.setDownloadBehavior
     {behavior:'allow', downloadPath, eventsEnabled:true}` on the browser CDP
     session.
  3. Use BiDi `browser.setDownloadBehavior`, if chromium-bidi 157 supports it.
- **Done when:** the Research log names the option that makes downloads land
  in `downloadsDir` and keeps `waitForDownload()` events working, with the
  check that proves it.

### A1.4 (R3) `mobileEmulation` and other launch-time capabilities

- List every capability `buildLaunchCapabilities` emits for chrome-family, and
  every `LaunchOptions` field that ends up in caps (`args`, `browserPath`,
  `mobileEmulation`, `downloadsDir`, headless). For each, state where it goes
  in hybrid: a Chrome CLI flag at spawn, the Preferences file, the attach
  caps, or a BiDi/CDP call after start.
- `mobileEmulation`:
  - If R1 shows chromedriver applies it on attach, keep sending it there.
  - Otherwise, choose between BiDi `browsingContext.setViewport` plus
    `emulation.*`, and CDP `Emulation.setDeviceMetricsOverride` plus
    `Emulation.setUserAgentOverride` plus touch.
  - `tests/mobile-emulation.test.ts` is the acceptance test.
- **Blocker if:** a documented LaunchOptions feature has no hybrid
  equivalent. (Fallback: that option forces today's path; see A2.4 routing.)

### A1.5 (R4) Depending on chromium-bidi safely

1. **Entry points.** The deep-import paths used in driver-perf
   (`chromium-bidi/out/Default/gen/src/{bidiMapper/BidiMapper.js,cdp/CdpConnection.js,bidiTab/BidiParser.js}`)
   are not a documented API. Check what Puppeteer imports: it uses the package
   root `BidiMapper` export, and `MapperCdpConnection` is not exported there.
   Decide between:
   - (a) Puppeteer's approach: use `BidiMapper.BidiServer` with our own
     `CdpConnection` adapter (≈120 lines; see
     `puppeteer-core/src/bidi/BidiOverCdp.ts`).
   - (b) Deep imports pinned to an exact version.

   Recommendation: (a). It only uses the root export, so a chromium-bidi
   restructure can't break it silently.
2. **Version policy.** Since September 2026 chromium-bidi versions follow
   Chromium's (`157.0.8090-0`). Find out which Chrome versions a given mapper
   supports: read the chromium-bidi README/CHANGELOG and how Puppeteer pairs
   them.
   - Define: craftdriver pins one exact chromium-bidi; hybrid runs only when
     the detected Chrome major is within the supported window; otherwise it
     falls back to today's path with a one-line debug note.
   - Write the window as a constant with its source.
3. **Parser.** Choose `BidiParser` (validating; what chromedriver's tab uses)
   or the no-op parser (Puppeteer's default). Requirement: error messages and
   error codes for malformed commands must match today's, because
   craftdriver's error mapping parses them.
4. **Licence.** chromium-bidi is Apache-2.0. Confirm no NOTICE obligation
   applies when depending on it (not bundling it).

### A1.6 (R5) Lazy attach: can the attach leave the critical path?

- **Idea.** `Browser.launch()` resolves as soon as BiDi is ready (the mapper
  plus `initBiDi`). The chromedriver attach keeps running, and every Classic
  call awaits a shared `attachReady` promise first.
- **Measure in driver-perf** (new mode `hybrid-lazy`): the time to
  "`Browser.launch` resolved", and the time to "first Classic command
  returned" when the first command is (a) a BiDi command and (b) a Classic
  navigate.
- **Survey in craftdriver** which commands a typical test issues first after
  launch. `navigateTo` is Classic-first today: in July 2026, BiDi-first
  navigation was rejected because BiDi `browsingContext.navigate` through
  chromedriver measured ~50 ms slower than Classic on Chrome. The driver-perf
  data shows BiDi navigate through the in-process mapper is *not* slower than
  Classic (−3.8 ms ±2.1), and chromedriver BiDi only +1.2 ms ±3.6. So the old
  50 ms is likely craftdriver-side overhead; find it before routing the first
  navigate through BiDi.
- **Done when:** the Research log has the numbers and a recommendation.
  Implementation is A3.3 and is optional.

### A1.7 (R6) Process lifecycle on every OS

- Killing Chrome must leave no orphans on macOS, Linux or Windows, including
  helper processes. Options:
  - graceful `Browser.close` over CDP first, then kill after a timeout;
  - on Windows, `taskkill /T /F /PID`;
  - on Linux, a process group via `detached: true` plus `process.kill(-pid)`.
- The user-data-dir must be removed after exit. Helpers keep writing briefly,
  which driver-perf hit as `ENOTEMPTY`; use `rmSync` with `maxRetries`.
- Crash safety: if the Node process dies, chromedriver today dies with it and
  takes Chrome along. In hybrid we own Chrome. Check
  `process.on('exit')`-time cleanup, and whether Chrome exits by itself when
  its stdio pipes close.
- **Done when:** the Research log has the recipe per OS, plus a script that
  launches 20 sessions, kills them through every path (normal quit, thrown
  error mid-launch, `SIGINT` to the parent), and counts leftover Chrome
  processes and temp dirs: the count must be 0.

---

## Phase 2: implementation (craftdriver)

Order: A2.1 → A2.2 ∥ A2.3 → A2.4 → A2.5. Each task is one PR with its own
focused tests.

### A2.1 BiDi transport seam (no behavior change)

- **Files:**
  - new `src/lib/bidi/transport.ts`;
  - `src/lib/bidi/connection.ts`;
  - `src/lib/bidi/index.ts` (the only `new BiDiConnection()` site, line ~51).
- **Do:**
  1. Define
     `interface BiDiTransport { send(message: string): void; onMessage(cb: (data: string) => void): void; onClose(cb: () => void): void; close(): Promise<void>; isOpen(): boolean }`.
  2. Move the `ws` code out of `BiDiConnection.connect()` into
     `WebSocketTransport` (keep the timeout, autoReconnect and close
     semantics byte-for-byte).
  3. `BiDiConnection` gets `connectTransport(t: BiDiTransport)`;
     `connect(wsUrl)` becomes `connectTransport(await WebSocketTransport.open(wsUrl, opts))`.
  4. `BiDiSession` gets an optional `transport` factory. Default: WebSocket.
- **Done when:** no public API change; `npm run lint` and `npm run build`
  pass; focused tests pass: `tests/evaluate.test.ts`, `tests/network.test.ts`,
  `tests/logs.test.ts`, `tests/dialogs.test.ts`, `tests/browser-context.test.ts`.
  The perf check `npm run bench -- bidi-vs-classic` shows no regression
  (paired; must be within jitter).

### A2.2 `ChromeLauncher`: spawn Chrome directly

- **Files:**
  - new `src/lib/chromeLauncher.ts`;
  - `src/lib/driverManager.ts` (export a `findChromeBinary()` built on
    `CHROME_CANDIDATES` and `resolveBrowserBinaryPath`);
  - `src/lib/timing.ts` (new constants);
  - new `tests/chrome-launcher.test.ts`.
- **Do:**
  1. `ChromeLauncher.launch(opts): Promise<LaunchedChrome>`, where `opts` is
     `{ binary, headless, args, userDataDir?, prefs?, env? }`.
  2. Default flags: **exactly** chromedriver 156's list from the research
     doc, `--remote-debugging-port=0`, plus `--headless=new` when headless,
     plus the user's `args` last, plus the `data:,` start URL.
     - Capture the list in a single exported constant with a comment naming
       its source: the `chromedriver --verbose` "Launching chrome:" line.
     - Add a unit test asserting user args come after the defaults.
  3. Create a temp `userDataDir` when none is given. Write the Preferences
     file from `prefs` per R2's outcome.
  4. Resolve the DevTools ws URL by parsing stderr for
     `DevTools listening on (ws://\S+)`, with a timeout
     (`CHROME_DEVTOOLS_READY_TIMEOUT_MS`, start at 30 s).
     - On timeout or early exit, throw `CraftdriverError(DRIVER_ERROR)`
       carrying the stderr tail, reusing the bounded-tail approach from
       `src/lib/service.ts`.
     - Keep draining stderr after the match, or Chrome can block on a full
       pipe.
  5. `LaunchedChrome.close()` follows the R6 recipe and is idempotent. It also
     exposes `wsUrl`, `debuggerAddress` (`host:port`), `pid`, and
     `getOutputTail()`.
- **Done when:** the unit tests (with a fake Chrome script printing a DevTools
  line, exiting early, or hanging) cover URL parsing, timeout, early exit,
  arg order and idempotent close. One real-Chrome test launches, connects a
  raw CDP `Target.getTargets`, closes, and asserts no process or dir is left.

### A2.3 In-process mapper transport

- **Files:**
  - new `src/lib/bidi/inProcessMapper.ts`;
  - `package.json` (dependency per the decision above);
  - new `tests/bidi-in-process-mapper.test.ts`.
- **Do:**
  1. Load chromium-bidi lazily with a dynamic `import()` behind a cached
     `loadMapper()`. If the import fails, return `undefined`; the caller falls
     back (option 1).
  2. Connect to `wsUrl` with `ws` (already a dependency). Build the CDP
     adapter per R4's choice: the root-export adapter (recommended) or
     `MapperCdpConnection`.
  3. Start the server with
     `BidiServer.createAndStart(bidiTransport, cdpConnection, browserClient, '', parser)`.
  4. Implement `BiDiTransport` from A2.1 over it. Commands go to the mapper as
     objects; responses and events come back through `sendMessage`.
     `BiDiConnection` still sees strings, so `send()` stringifies and
     `onMessage` gets `JSON.stringify(message)`. Measure whether that
     round-trip shows up; if it does, add an object fast path later. Don't
     pre-optimize.
  5. Send `session.new` with
     `capabilities.alwaysMatch.unhandledPromptBehavior` set to the same map
     `applyBidiDefaults` builds (alert/confirm/prompt/beforeUnload: 'ignore').
     **This is load-bearing:** without it the mapper dismisses dialogs before
     Classic or `onDialog` can see them (driver-perf's
     `hybrid-interop.mjs` reproduces it). Also forward `acceptInsecureCerts`
     when the user set it.
  6. Close order: `server.close()`, then the CDP socket close.
- **Done when:** a test launches Chrome via A2.2, starts the mapper, and runs
  `session.new`, `browsingContext.getTree`, `browsingContext.navigate`,
  `script.evaluate`, a subscribed `browsingContext.load` event and an alert
  `userPromptOpened` event. A second test with the import forced to fail
  asserts `undefined` (no throw).

### A2.4 Hybrid launch path in `Browser.launch`

- **Files:**
  - `src/lib/browser.ts` (`launch`, `initBiDi`, `quit`);
  - `src/lib/builder.ts` (add `attachTo(debuggerAddress)`, or a sibling
    `buildAttached()`);
  - `src/lib/capabilities.ts` (new `buildAttachCapabilities`);
  - `src/lib/types.ts` (the option);
  - `docs/driver-configuration.md`.
- **Routing.** Use hybrid iff **all** of these hold:
  - `target.kind === 'browser'`, chrome-family, not remote, not Electron;
  - `bidiRequested`;
  - the mode is enabled;
  - chromium-bidi loads;
  - the Chrome major is in R4's window;
  - no option outside R3's supported list is in use.

  Otherwise use today's path. Record the chosen path and the reason on the
  Browser instance (internal) so tests and `--debug` can assert it.
- **Mode switch:** `LaunchOptions.chromeLaunchMode?: 'auto' | 'chromedriver' | 'hybrid'`
  plus the env var `CRAFTDRIVER_CHROME_LAUNCH_MODE`.
  - Until G3, `'auto'` means `'chromedriver'`.
  - `'hybrid'` when it can't be honored throws
    `CraftdriverError(UNSUPPORTED)` with the reason. Never silently ignore an
    explicit request.
- **Launch sequence:**
  1. `Promise.all([ChromeLauncher.launch(...), chromeService.start()])`.
     Driver resolution and caching are unchanged; the user's `chromeService`
     option is still honored.
  2. `Promise.all([Driver.create(endpoint, buildAttachCapabilities({debuggerAddress, mobileEmulation?, unhandledPromptBehavior})), startInProcessMapper(wsUrl, caps)])`.
     Keep `builder.ts`'s chromedriver version-mismatch retry working for
     attach (R1 Q5).
  3. `initBiDi` with the in-process transport. Its 8-attempt WebSocket retry
     loop is pointless here: one attempt, then fail loud (no fallback to
     Classic-only, since the user asked for BiDi).
  4. Apply the post-start settings from R2 and R3 (downloads, emulation if
     needed).
- **Quit:**
  - Order: BiDi/mapper close → `DELETE /session` (it no longer closes Chrome)
    → `chromeService.stop()` → `LaunchedChrome.close()`.
  - The `PORT_RELEASE_DELAY_MS` branch is untouched (it's Firefox-only).
- **Errors mid-launch:** close everything started so far, in reverse order.
  Attach the Chrome stderr tail and the chromedriver output tail to the
  thrown error, mirroring `augmentLocalSessionError`.
- **Done when:**
  - Unit test: routing table (every condition above → expected path).
  - Integration test: hybrid launch → navigate → BiDi evaluate → Classic
    click on a BiDi-located element. This is the `query.ts:549` sharedId
    interop that driver-perf verified.
  - Integration test: `onDialog` and a Classic alert API both work.
  - Leak test: 10× launch/quit leaves no Chrome or chromedriver processes and
    no temp dirs.
  - Explicit `'hybrid'` with Electron throws `UNSUPPORTED`.

### A2.5 Downloads, emulation, prefs (from R2/R3)

- **Files:** `src/lib/chromeLauncher.ts` and/or `src/lib/browser.ts`.
- **Do:** implement exactly the option the Research log selected for each
  launch-time capability. Anything R3 marked unsupported goes into the A2.4
  routing exclusions with a test.
- **Done when:** `tests/file-transfer.test.ts` (download half),
  `tests/mobile-emulation.test.ts` and `tests/launch-options.test.ts` pass
  under `CRAFTDRIVER_CHROME_LAUNCH_MODE=hybrid`.

---

## Phase 3: verify (core change, so the full suite is justified)

### A3.1 CI matrix leg

- **Files:** `.github/workflows/ci.yml`.
- **Do:** add a job running the default Chrome suite (`npm test`) with
  `CRAFTDRIVER_CHROME_LAUNCH_MODE=hybrid` on ubuntu-latest, plus
  `chrome-smoke` on macos-latest and windows-latest.
  - Non-blocking (`continue-on-error`) for its first week.
  - Then blocking.
- **Done when:** three consecutive green runs. Every failure is root-caused
  per the skill's flake policy, never retried away.

### A3.2 Perf evidence in this repo

- **Files:** `tests/perf/launch-critical-path.perf.ts`.
- **Do:** add a `hybrid` arm next to BiDi and Classic. Paired, interleaved,
  ≥ 10 measured iterations.
- **Done when:** the numbers are in the PR description and in
  `docs/driver-configuration.md` → Performance, stating machine, OS and
  Chrome version. This is the number that may be quoted publicly, not the
  driver-perf one.

### A3.3 (optional, from R5) Lazy attach

Only if R5 recommends it.
- Make `Browser.launch()` resolve on BiDi-ready.
- Wrap the `Driver` HTTP client so every Classic call awaits `attachReady`.
- An attach failure surfaces on the first Classic call with the full
  diagnostics, and `quit()` still cleans up.

Tests:
- A delayed fake attach proves Classic calls wait.
- An attach failure proves the first Classic call throws the stored error.
- Perf: re-run A3.2.

---

## Phase 4: rollout

- **A4.1 Docs:**
  - `docs/driver-configuration.md`: what hybrid is, when it's used, how to
    force either path, what it doesn't cover (Electron, remote, Firefox,
    Safari), and troubleshooting.
  - CHANGELOG entry with the A3.2 numbers.
- **A4.2 Default flip (G3, owner):**
  - `'auto'` → hybrid when routable.
  - Keep `'chromedriver'` as the escape hatch.
  - Announce in release notes.

## Risks

| risk | mitigation |
|---|---|
| Two CDP clients disagree (dialogs, emulation, focus) | Prompt behavior pinned to 'ignore' on both sides; R1 and R3 probe the rest; full-suite matrix in A3.1 |
| chromium-bidi internals change between pinned bumps | Root-export adapter (R4), exact pin, Chrome-version window, bumps go through the deps-bump skill plus `bidi-in-process-mapper.test.ts` |
| Orphaned Chrome processes (we now own the process) | R6 recipe, plus the A2.2 and A2.4 leak tests |
| Gain is small on fast Linux | Gate G0 measured on ubuntu-latest before any code |
| 21 MB install | optionalDependency; falls back cleanly when omitted |

## Research log

(Append findings here: date, task id, evidence, decision.)
