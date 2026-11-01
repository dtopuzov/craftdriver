# Progress: bundled mapper + hybrid Chrome launch (lazy attach)

Single source of truth for where the implementation stands. Update it in the
same commit as the work it describes.

- **Branch:** `feat/chrome-hybrid-launch` (off `plans/chrome-mapper-in-node`, local).
- **Plans:** [chrome-mapper-bundle.md](chrome-mapper-bundle.md) (Plan M),
  [chrome-hybrid-launch.md](chrome-hybrid-launch.md) (Plan A).
- **Owner decisions (2026-11-01):**
  - Skip all measurement gates. Plan A G0/A1.1 and Plan M M2.2 are **not done
    by decision**, not pending. Don't add perf claims to docs/CHANGELOG
    without numbers (engineering skill); describe behaviour only.
  - Build the bundle (Plan M), then ship hybrid **with lazy attach** (A3.3
    is in scope, not optional).

## How to resume

1. `git checkout feat/chrome-hybrid-launch && git log --oneline main..`
2. Find the first unchecked box below; read its "Notes" line.
3. Load the `craftdriver-engineering` skill before touching `src/`.

## Status

Legend: `[x]` done, `[ ]` todo, `[~]` in progress, `[-]` skipped by decision.

### Plan M: bundle

- [x] M1.1 `scripts/mapper/lib.mjs` temp toolchain
- [x] M1.2 `scripts/mapper/build.mjs` + guards + `--check`
- [x] M1.3 `.d.ts` + `src/lib/bidi/mapperBundle.ts`
- [x] M1.4 ship in `dist/` (postbuild copy, `.prettierignore`)
- [x] M1.5 `mapper:check` in CI
- [x] M1.6 first import commit
- [x] M2.1 `tests/mapper-bundle.test.ts`
- [-] M2.2 re-measure cold (owner: no measuring)
- [~] R-M1 no-op parser error parity
- [x] R-M2 version policy / `chromeSupport.minMajor`
- [x] R-M3 changelog source
- [x] M3.1 `scripts/mapper/update.mjs`
- [x] M3.2 `mapper-update` skill
- [x] M3.3 `mapper-watch.yml`
- [~] M3.4 deps-bump note

### Plan A: hybrid + lazy attach

- [-] A1.1 CI measurement / G0 (owner: no measuring)
- [x] A1.2 R1 attach semantics
- [x] A1.3 R2 downloads
- [x] A1.4 R3 launch-time caps
- [x] A1.6 R5 lazy attach (design only; no measuring)
- [x] A1.7 R6 process lifecycle
- [x] A2.1 BiDi transport seam
- [x] A2.2 `ChromeLauncher`
- [x] A2.3 in-process mapper transport
- [x] A2.4 hybrid launch path + routing + `chromeLaunchMode`
- [x] A2.5 downloads / emulation / prefs
- [x] A3.3 lazy attach
- [x] A3.1 CI matrix leg
- [-] A3.2 perf arm (owner: no measuring)
- [x] A4.1 docs

## Log

(Newest last. Date, task, what changed, commit, anything the next session
must know.)

- 2026-11-01 M1.1–M1.6: bundle pipeline landed. `npm run mapper:build` /
  `mapper:check` (scripts/mapper/{lib,build,copy-to-dist}.mjs), vendor dir
  `src/lib/bidi/vendor/`, loader `src/lib/bidi/mapperBundle.ts`, unit tests
  `tests/mapper-build.test.ts` (guards a–d, integrity, 1-byte tamper).
  chromium-bidi 157.0.8090-0 (= puppeteer-core@25.16.0 pin), esbuild 0.28.2:
  422,476 bytes, 78 modules, packages chromium-bidi + mitt only.
  Notes: `--ignore-scripts` works for esbuild (M1.1 research answer: its
  binary comes via optionalDependencies). Added `chromium-bidi-mapper.api.txt`
  (normalized upstream .d.ts) so `update.mjs` can diff API changes; the
  fingerprint is its sha256. `.gitattributes` marks the vendor dir `-text`
  so Windows checkouts keep LF. CI runs `mapper:check` on ubuntu + macOS +
  Windows (drop the non-Linux ones once green twice).
  `chromeSupport.minMajor` = 156 (only Chrome verified so far; R-M2 may lower it).

- 2026-11-01 A2.1–A2.3 + M2.1: `src/lib/bidi/transport.ts` (BiDiTransport +
  WebSocketTransport; BiDiConnection.connectTransport, BiDiSession.connect
  accepts a transport), `src/lib/chromeLauncher.ts` (launchChrome, chromedriver
  156's exact switch list, Preferences-file prefs, exit-hook kill, temp profile
  removal), `driverManager.findChromeBinary()`, `src/lib/bidi/inProcessMapper.ts`
  (startInProcessMapper → BiDiTransport; session.new sent internally as id 0).
  Tests: `tests/chrome-launcher.test.ts` (9), `tests/mapper-bundle.test.ts` (6;
  merges M2.1 and A2.3's planned test — it is the update gate). No-regression
  gate for the seam: evaluate/network/logs/dialogs/browser-context/chrome-smoke
  62/62 on the chromedriver path. Flag capture: chromedriver adds NO
  `--window-size` (driver-perf's list had one; the craftdriver constant doesn't).

- 2026-11-01 research (scratch probes against chromedriver 156 + Chrome 156,
  scripts in the session scratchpad, results here):
  - R1 attach: with `goog:chromeOptions.debuggerAddress`, chromedriver
    ACCEPTS args/prefs/binary/windowTypes (and ignores the launch-time ones) and
    REJECTS mobileEmulation, excludeSwitches, detach ("unrecognized chrome
    option"). `unhandledPromptBehavior` + `pageLoadStrategy` are honored.
    Windows: new tab via Classic shows up in BiDi getTree with the same id;
    switching works with the mapper attached. Alert opened via BiDi is read and
    accepted via Classic. `DELETE /session` leaves Chrome running. Version
    mismatch on attach: not reproducible locally; hybridLaunch retries once
    after invalidating the driver cache (same as Builder).
  - R2 downloads: prefs written to `<profile>/Default/Preferences` before spawn
    make downloads land in downloadsDir even though the mapper sends
    `Browser.setDownloadBehavior default` at start. Without it they go to
    ~/Downloads. → option 1 implemented (chromeLauncher prefs).
  - R3 caps: args → Chrome CLI (after defaults), browserPath → spawn binary,
    downloadsDir → Preferences, headless → `--headless=new`, mobileEmulation →
    NOT supported (routes to chromedriver; explicit hybrid throws). Args with
    `--remote-debugging-*` also route to chromedriver.
  - R5 lazy attach (no measuring by owner decision): implemented as
    `WebDriverEndpoint.pendingSession` — HttpClient awaits it and swaps the
    placeholder session id; one choke point, no Driver/WebElement changes.
  - R6 lifecycle: SIGKILL of the main Chrome process left helpers alive long
    enough to re-create `chrome_debug.log` in the removed profile (5/5 leaks in
    vitest). Fix: CDP `Browser.close` first (as chromedriver does), kill after
    3 s (`CHROME_GRACEFUL_CLOSE_TIMEOUT_MS`), then rm with retries; plus a
    process 'exit' hook that SIGKILLs any live Chrome. Leak test passes.
    Windows: proc.kill() (TerminateProcess) — untested locally; CI smoke runs it.
  - R-M3 changelog: `gh api repos/GoogleChromeLabs/chromium-bidi/commits?since&until`
    with the two npm publish times works (update.mjs prints it).
  - R-M2: policy implemented (eligible = puppeteer-core@latest pin, ≤ Stable+2).
    NEW FACT: npm now also publishes release-branch patches, e.g.
    `157.0.8103-0 … 157.0.8103-35` (Chrome 157 branch) and `158.0.8127-N`; so a
    Stable-branch-matching release DOES exist from 157 on. Not used yet (policy
    still follows Puppeteer). Old-Chrome matrix (Stable−1..−3) NOT run;
    minMajor stays 156 (only version verified).
  - R-M1: no dedicated error-diff table. Coverage instead: the full default
    Chrome suite in hybrid mode (see below) exercises craftdriver's real error
    paths through the no-op parser.

- 2026-11-01 A2.4/A2.5/A3.3: `src/lib/hybridLaunch.ts` (routing
  `chooseChromeLaunchPath`, `launchHybridChrome`), `LaunchOptions.chromeLaunchMode`
  ('auto'|'chromedriver'|'hybrid', 'auto' = chromedriver until the owner flips
  it), env `CRAFTDRIVER_CHROME_LAUNCH_MODE` (best-effort: unroutable launches
  fall back; explicit option is strict → UNSUPPORTED). Lazy attach is the only
  hybrid behaviour (launch resolves on BiDi-ready). Quit order: BiDi → DELETE
  /session (awaits attach) → chromedriver stop → Chrome graceful close.
  Tests: `tests/hybrid-launch.test.ts` (routing table, pending-session HTTP
  contract incl. failure, Classic+BiDi interop, onDialog + Classic alert,
  downloads, 5× launch/quit leak check, env fallback with mobileEmulation).

- 2026-11-01 IMPORTANT design change: the mapper leaves internal promise
  rejections unhandled (e.g. `Fetch domain is not enabled`,
  `Page.removeScriptToEvaluateOnNewDocument … connection has been closed`).
  In-process they surfaced as Node unhandled rejections (would crash user
  processes by default). The mapper now runs in a worker_thread
  (`inProcessMapper.ts`, eval'd WORKER_SOURCE, Node's built-in WebSocket),
  whose own `process.on('unhandledRejection')` contains them; the caller's
  process semantics are untouched (verified). `mapperBundle.ts` now only
  exports `mapperBundleUrl()`; the .d.ts documents the API the worker uses.
  Follow-up idea (needs measuring, owner said no measuring now): one shared
  worker per process instead of one per session.

- 2026-11-01 M3: `scripts/mapper/update.mjs` (--status/--to/--check-only,
  exits 0/1/10/20/30/40/50, fixture + fault-injection seams),
  `tests/mapper-update.test.ts`, `.claude/skills/mapper-update/SKILL.md`,
  `.github/workflows/mapper-watch.yml`. M3.4: the deps-bump skill lives on
  `chore/halloween-deps` (PR #87), not on this branch — add the one-line
  "vendored mapper is updated by mapper-update" note there after #87 merges.
  A3.1: ci.yml gets a non-blocking `chrome-hybrid` job (full suite, env
  hybrid) and a non-blocking hybrid smoke step on macOS + Windows.
  A4.1: docs/driver-configuration.md "Chrome launch mode (experimental)" +
  env var row. No CHANGELOG perf entry (no numbers, by decision).

- 2026-11-01 full-suite parity (macOS Intel, Chrome 156, local, HEADLESS):
  - Run 1 (mapper on main thread): 15 failed / 1620 passed + 5 unhandled
    rejections from the mapper → moved the mapper to a worker.
  - Run 2 (worker): 12 failed / 1635, no unhandled errors. Root causes, fixed in
    e19351a: (1) fake grids echo `webSocketUrl: true`, which my
    `typeof !== 'string'` check routed to the transport path → separate
    `initInProcessBiDi()`; (2) late attach picked a different "current window"
    when launch-time storageState restore had opened tabs → attach now switches
    to Chrome's initial tab (read from /json/list right after launch);
    (3) tracer pre-action screenshots raced Classic navigation (chromedriver
    orders Classic behind in-flight BiDi; hybrid doesn't), and the mapper fails
    or HANGS a captureScreenshot whose page navigates mid-capture (reproduced
    with 157.0.8090-0, 157.0.8103-35 and 17.0.2 → not version-specific,
    upstream robustness bug) → on hybrid launches a traced action awaits its
    pre-action screenshot.
  - Run 3: 3 failed / 1644 = 2 popup tests (pre-existing, see below) + my
    fake-Chrome 300ms timeout test under load (bumped to 2000ms).
  - Default chromedriver path after all changes: 5 failed / 1642, all popup
    tests (`pages.test.ts` ×4, `browser-context-hooks` on('page') popups) —
    the SAME failures reproduce on the pre-branch commit d9369be on this
    machine, so they're environmental/pre-existing, not from this branch.
    Hybrid passes more of them (on('page') + 2 of 4 pages tests).
  - Known gap (document if it bites): a user-issued `browser.screenshot()`
    racing a Classic navigation can stall up to the BiDi timeout (30 s) in
    hybrid mode (upstream mapper). Tracing is protected; plain concurrent
    screenshot+navigate is not.
  - Flake seen once under parallel load: hybrid cleanup test found the temp
    profile/process after quit; cause unconfirmed (likely graceful close >3 s
    → kill → helper re-creates chrome_debug.log). Added a second profile sweep
    after a forced kill; not reproduced since (2 parallel runs + full suite).

## Next steps (owner decides)

1. Push the branch / open a PR; watch the non-blocking `chrome-hybrid` CI job
   and the macOS/Windows hybrid smoke (Windows close path is untested locally).
2. Decide G3: flip `'auto'` to hybrid (currently chromedriver).
3. Optional, needs measuring (deferred by owner): shared mapper worker per
   process; A3.2 perf arm; Plan M M2.2.
4. (done 2026-11-01, see log) Chrome version matrix; minMajor = 140.
5. After PR #87 merges: one-line note in the deps-bump skill (M3.4).

- 2026-11-01 R-M2 Chrome version matrix (owner: "craftdriver must work for any
  recent Chrome"). Chrome for Testing mac-x64 140, 145, 150, 155, 157, 158 +
  system 156, gate = mapper-bundle + hybrid-launch + chrome-smoke + dialogs +
  evaluate + network in hybrid mode (57 tests). ALL PASS after two fixes:
  - Chrome 140: evaluate failed every parallel run with CDP's "Cannot find
    context with specified id" (same pre-execution realm race as "execution
    contexts cleared"; chromedriver path on 140 was clean) → added to
    `withRealmRetry` (src/lib/bidi/evaluate.ts) + test case.
  - Chrome 158: cleanup test saw a helper still exiting right after quit
    (gone moments later) → test polls up to 3 s; close() schedules an unref'd
    late profile sweep.
  `chromeSupport.minMajor` = 140 (oldest tested; older untested, not known bad).
  New `.github/workflows/chrome-compat.yml`: weekly + on mapper changes, runs
  the gate on ubuntu against CfT {minMajor, Stable, Beta, Dev}; disables the
  runner's preinstalled chromedriver so a matching one is downloaded.
  Untested: the workflow itself has not run yet (needs a push).
