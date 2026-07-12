# Electron testing — V2 (deferred)

Post-V1 backlog for Electron capabilities that are valuable but deliberately
outside the V1 production-renderer scope. Keep it updated as decisions land.

## Maintainer recommendation (updated 2026-07-13)

Shipped so far: native-dialog mocking (real-flow verified), **general API mocking**
(`mock()`), **deep links** (`triggerDeeplink()`), and **proactive fuse detection**
(dependency-free reader that names a disabled `EnableNodeCliInspectArguments` fuse).
Plus a **shell/clipboard mocking recipe** over `mock()`. Together these cover the
common "my Electron app talks to the OS" testing needs.

What's left, weighted toward real-world value over surface area:

1. **#7 packaged-app discovery** and **#6 dev-server recipe** — convenience, no new
   risk; do when a user actually asks. (See the questions below for what these
   actually are.)
2. **Class-API mocks** (`Notification`, `Menu`) — the gap object-namespace `mock()`
   doesn't cover. Only if a real need appears; today you mock the app code that
   constructs them.

Hold (evidence-gated, no proven need): #11 auto window-switching, #12 concurrent
sessions, #10 visual/video. The "Decided NOT to build" section still stands.

## The dividing line: the inspector fuse

V1's promise is: **drive the renderer of a real, un-instrumented, code-signed
release build** (start it, handle splash → main window, find/click/assert). That
path needs no main-process access and no fuses.

Almost everything in V2 needs to **run code in the app's main process** — and that
requires the Electron `EnableNodeCliInspectArguments` fuse to be **enabled**.
Electron enables it by default; code signing does not disable it. Security-hardened
build pipelines may deliberately disable it before signing.

> Native-dialog mocking works against an unchanged production artifact when the
> fuse remains enabled. If the production pipeline disables it, use an internal
> test build with the fuse enabled before signing. CraftDriver never patches a
> packaged executable or bypasses that boundary.

So V2 is framed as: _for teams testing their own Electron app or a production
artifact whose inspector fuse remains enabled._

## Post-V1 hardening moved from V1

These are still useful, but not required for the V1 production-renderer promise.
They moved here when V1 was finalized:

- **Compatibility matrix expansion** — publish/maintain a table with Electron,
  bundled Chromium, driver source, OS, arch, Classic status, and BiDi status. Seed
  data: fixture 43.1.0 → Chromium 150 on Linux x64 / Windows x64; Fiddler 39.8.6
  → Chromium 142 on macOS manual verification.
- **Release note / supported-version statement** — keep the public claim narrow:
  Classic renderer automation is the supported path for the tested matrix; other
  Electron versions are best-effort until added to the matrix.
- **CI hardening** — run the hosted Electron job repeatedly, record
  startup/runtime distributions, and treat intermittent failures as bugs or
  quarantine candidates rather than retry targets.
- **macOS arm64 hosted coverage** — add when the fixture and driver signing path is
  repeatable on hosted macOS arm64.
- **Ubuntu AppArmor diagnostics** — diagnose restrictions only; do not auto-install
  privileged profiles without a separate security review.
- **Linux/Windows packaged-app version detection** — macOS production apps can read
  Electron from the app bundle today; find similarly cheap, robust sources for
  Linux/Windows packaged apps, or keep requiring explicit `electron.version`.
- **Driver mismatch audit** — the pre-session arch and known Electron/Chromium-major
  checks exist; keep expanding coverage around newly discovered driver sources.

## Already shipped (the V2 foundation, built during V1 work)

These main-process primitives already exist on `feat/electron-support` and are the
base the V2 features extend. They are opt-in (`electron: { mainProcess: true }`),
never affect the renderer path, and are **verified only against fuse-enabled builds**
(the example fixture) — they do **not** work on hardened production apps:

- `browser.electron.executeMain(fn, ...args)` — run code in the main process. The
  capability-namespace design is settled: no `ElectronApp` class; `executeMain` (not
  WDIO's `execute`) for a loud main-vs-renderer boundary; injects the `electron`
  module as the callback's first arg (WDIO-compatible). Security: inspector binds
  `127.0.0.1` only and lives for the session.
- `browser.electron.mainLogs` — main-process console/error capture.

## V2 backlog

### Shipped: native OS dialog mocking

`browser.electron.mockDialog()` mocks the asynchronous
`electron.dialog.showOpenDialog`, `showSaveDialog`, and `showMessageBox` methods.
It returns a handle with call inspection, clearing, and restore semantics; active
mocks are restored on quit. The separate example app contains a full renderer →
preload → IPC → native file-dialog flow.

**Verified end-to-end** (craftdriver-examples `v0.1.4`): the e2e suite drives the
real user flow — click `open-native-file-btn` → preload `craftdriverExample.openFile()`
→ IPC `native-dialog:open-file` → main-process `dialog.showOpenDialog` (mocked) →
renderer renders the returned path — plus the cancel path and the recorded-call
assertion. No OS dialog ever opens. See `tests/electron/electron-main-process.test.ts`
and `docs/recipes/electron-native-dialog.md` (both share the example's exact hooks).

### Shipped: general Electron API mocking

`browser.electron.mock(api, fn, returnValue?)` replaces any `electron.<api>.<fn>`
main-process method with a scripted return and a call recorder — the general
primitive `mockDialog()` is now a typed convenience over. Deliberately **lean**
(the existing dialog-mock ergonomics: `getCalls` / `getCallCount` / `clearCalls` /
`mockReturnValue` / `restore`, restored on quit) rather than porting WDIO's
`@wdio/native-spy` + IPC-interceptor machinery, which would break craftdriver's
two-runtime-dep stance. Class mocks (WDIO's `mockAll` / class-mock) are **not**
built — no proven need; revisit if one appears.

**Verified end-to-end** against the v0.1.4 fixture: mocks `app.getName` and
`shell.beep` — records args, re-scripts via `mockReturnValue`, clears, restores,
and rejects double-mock / bad-target. See `src/lib/electronMock.ts`,
`tests/electron/electron-main-process.test.ts`, and `docs/electron.md`
("Mock Any Electron API"). Needs the fuse.

### Shipped: proactive fuse detection

The **dependency-free reader** route was taken (`src/lib/electronFuses.ts`): when the
main-process inspector is unreachable, parse the `@electron/fuses` wire straight from
the packaged binary (32-byte sentinel → version → count → per-fuse ASCII byte;
`EnableNodeCliInspectArguments` is index 3; on macOS the wire lives in the **Electron
Framework**, read with a chunked sentinel scan). If the fuse is provably
disabled/removed, `ELECTRON_MAIN_UNAVAILABLE` upgrades from "inspector unreachable"
to a precise message with `detail.fuseStatus` and the before-signing fix; otherwise
the original error stands. Best-effort (`'unknown'` on any read issue) and only on
the failure path, so the happy path pays nothing. The optional-`@electron/fuses`
route was rejected — keeps the two-runtime-dep stance.

**Verified**: 9 unit tests (enabled/disabled/removed, chunk-boundary, path
resolution) + a live read of the real app (`'enabled'`) + an end-to-end run against
a build with the fuse flipped off (`executeMain` throws the enriched error while
renderer automation still works).

### Shipped: deeplink / protocol-handler testing

`browser.electron.triggerDeeplink(url)` opens a custom-protocol URL against the
running app through the real OS launcher (macOS `open`, Linux `gio open`, Windows
`rundll32`), so the app's real `open-url` / `second-instance` handler fires —
matching WDIO's `triggerDeeplink`, adapted to craftdriver's error model. Pure
routing logic (URL validation, per-platform command, Windows/Linux `userData`
routing via the single-instance lock, auto-detected from the main process) lives
in `electronDeeplink.ts` and is 14-case unit-tested. New `ELECTRON_DEEPLINK_FAILED`
code. Docs: `docs/electron.md` ("Test Deep Links") + `docs/recipes/electron-deep-link.md`.

**Verified end-to-end** against the released `craftdriver-examples v0.1.5` fixture
(which ships the `craftdriver-example://` handler): the URL reaches both the renderer
element and a main-process global. The e2e (`tests/electron/electron-deeplink.test.ts`)
runs **automatically on macOS** (bundle registered at runtime with `lsregister`) and
skips on Linux/Windows, where the zip fixtures aren't OS-registered protocol handlers
(force with `CRAFTDRIVER_ELECTRON_DEEPLINK=1` against an installed app). Note: CI
runs the Electron e2e on Linux + Windows only, so the deep-link e2e is exercised by
local macOS runs, not CI — it auto-activates if/when macOS Electron CI is added.

### 5. Native shell helpers

Menus, tray, clipboard, notifications, app lifecycle — where automation is reliable
across OSes, each with a cross-platform fixture and a clear unsupported-platform story.

### 6. Renderer-only dev-server recipe

Document driving the renderer in a dev server with IPC-boundary mocks, reusing
ordinary `Browser.launch` rather than inventing a second Electron browser mode. Also
covers the **unpackaged `appEntryPoint`** dev-build case (Electron's `--app=<entry>`),
which is a development convenience, not "production mode".

### 7. Packaged-app discovery

Optional convenience for finding packaged outputs from common build tools:
electron-builder and Electron Forge. Keep explicit `appBinaryPath` authoritative,
define deterministic precedence when more than one source is valid, and cover path
edge cases: spaces, Unicode, symlinks, monorepos, pnpm, Yarn PnP, and a test repo
separate from the app repo.

### 8. Typed main-process helpers

Convenience wrappers over `executeMain` (e.g. app version, window enumeration) — only
after the generic execution primitive proves stable, so the typed surface can't
outrun the thing it wraps.

### 9. Security-boundary documentation

Spell out that a **test build may enable a fuse deliberately disabled in production**,
and define the boundary clearly: main-process access is opt-in, `127.0.0.1`-only,
session-scoped, and never a default.

### 10. Visual / video integrations

Only through generic craftdriver artifact APIs (screenshots, tracing) — no
Electron-private capture paths.

### 11. WDIO-style automatic window switching

WDIO auto-switches the active window handle **before every command**. V1 deliberately
does not: it keeps explicit, deterministic selection (`waitForPage({ title | url })`
returns a handle-bound `Page`; in Classic it also makes that window current). Revisit
only if evidence shows Electron routinely invalidates the active handle during normal
lifecycle — per-command auto-switch otherwise masks bugs and races.

### 12. Concurrent Electron sessions

Multiple apps driven at once, with isolated user-data dirs and debugger ports. Not
needed to drive a single production app; add with a multi-session fixture and teardown
guarantees.

## Decided NOT to build (parity, evidence-based)

- **Crash diagnostics as a bespoke signal** — vanilla Selenium Java and WDIO's
  electron-service both do **zero** Electron crash detection; a crash already
  surfaces as the next WebDriver command error (verified live). Building a custom
  crash API would exceed both references with no proven need.
  - Narrow robustness follow-up (a normal bug, not a feature): don't let a polling
    wait (e.g. visibility) mask a fatal `target crashed` / `no such window` driver
    error — surface it immediately instead of burning the whole timeout.
