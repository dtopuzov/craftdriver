# Plan B: driverless Chrome (no chromedriver; craftdriver speaks BiDi to its own in-process mapper)

Status: proposed (2026-10-31). Owner decision needed at gates G0, G1 and G4.
Companion: [chrome-hybrid-launch.md](chrome-hybrid-launch.md) (Plan A). This
plan **reuses Plan A's foundation tasks A2.1–A2.3 and research A1.3–A1.7
unchanged**. Where this file says "do A2.2", the spec is in Plan A.

## Read this first (agents)

- Load the `craftdriver-engineering` skill before touching `src/`. It is
  binding here:
  - evidence for every perf claim;
  - focused tests per task (Phase 4 is the explicit exception: a full-suite
    parity run);
  - root-cause every flake, never retry it away;
  - run the API-review checklist on any public-surface change.
- Task format: **Files**, **Do**, **Done when**. Research tasks (`R`) append
  their findings to "Research log" at the bottom and write no production
  code.
- Reference implementation of the startup path: `dtopuzov/driver-perf` →
  `lib/chrome-direct.mjs` and `lib/modes.mjs` (`node-mapper` mode). Evidence:
  `docs/RESEARCH-2026-10-31-mapper-in-node.md`.

## Why (and what it costs)

Measured on an Intel Mac, Chrome 156, paired (warm = a later session in the
same Node process; cold = a fresh process, including the ~143 ms mapper
import):

| against | warm (n=20) | cold (n=10) |
|---|---:|---:|
| chromedriver Classic | −485 ms | −251 ms |
| chromedriver BiDi (today's default) | ≈ −740 ms | ≈ −510 ms |
| hybrid (Plan A) | ≈ −325 ms | ≈ −220 ms |

Derived rows subtract the paired deltas against Classic. They are estimates;
A1.1 re-measures them directly.

What else it gives:
- **No chromedriver for local Chrome.** That removes driver download, version
  matching, the `driverManager` cache, and the chromedriver version-mismatch
  retry in `builder.ts`. A whole failure class goes away for the most common
  target.
- **One protocol for local Chrome** instead of the Classic + BiDi split.
- **A path to geckodriver-less Firefox.** Firefox implements BiDi natively
  behind `--remote-debugging-port`, so the BiDi `Driver` from this plan could
  later drive Firefox without geckodriver (out of scope here; see "Follow-ups").

What it costs:
- **Port every Classic call to BiDi.** That is 38 distinct endpoints, all in
  [src/lib/driver.ts](../src/lib/driver.ts) and
  [src/lib/webelement.ts](../src/lib/webelement.ts) (inventory in B1.1).
- **Reproduce Classic semantics in script** where BiDi has no 1:1 command:
  element click checks, `sendKeys`, `getText`, `clear`, `isEnabled`,
  attribute semantics.
- **Keep two Chrome paths alive indefinitely.** Electron, remote/Grid,
  `enableBiDi: false` and any unroutable option must keep the chromedriver
  path.
- **The same 21 MB chromium-bidi dependency question as Plan A** (see its
  "Dependency decision").

Per-command speed is **not** a reason to do this. driver-perf measured
navigate, evaluate and locate within a few ms across all architectures.

## Gates

- **G0** Same as Plan A's G0, but driverless must also beat **hybrid** by
  ≥ 150 ms median paired on `ubuntu-latest`, cold. Otherwise Plan A gives most
  of the benefit at a fraction of the cost: stop here and do Plan A.
- **G1 (after B1, owner).** The port inventory has no row marked "no
  equivalent", or every such row has an owner-accepted degradation written
  into the plan.
- **G2 (after each B3 family).** That family's focused tests pass in
  driverless mode.
- **G3 (after B4).** The full Chrome suite is green in driverless mode on
  Linux, macOS and Windows for 3 consecutive runs. The perf numbers are
  reproduced in this repo.
- **G4 (owner).** Default flip. Decide after ≥ 2 weeks opt-in on CI.

---

## Phase B0: foundation (shared with Plan A)

Do these from Plan A, unchanged. If Plan A already landed, skip them.

| task | what | note for driverless |
|---|---|---|
| A1.1 | CI measurement in driver-perf | Also report `node-mapper` vs `hybrid` paired; that's G0 here |
| A1.3 (R2) | downloads | No chromedriver here, so a CDP/BiDi or Preferences-file answer is mandatory |
| A1.4 (R3) | launch-time capabilities | `mobileEmulation` must be BiDi/CDP. There's no attach to delegate to |
| A1.5 (R4) | depending on chromium-bidi | Unchanged |
| A1.7 (R6) | process lifecycle | Unchanged; driverless owns Chrome exactly like hybrid |
| A2.1 | BiDi transport seam | Unchanged |
| A2.2 | `ChromeLauncher` | Unchanged |
| A2.3 | in-process mapper transport | Unchanged |

A1.2 (attach semantics) and A1.6 (lazy attach) don't apply: there is no
chromedriver to attach.

---

## Phase B1: research the port

### B1.1 (R) Classic → BiDi inventory

Verify and complete the table below, one row per endpoint. For each row:
- confirm the BiDi equivalent works on the pinned chromium-bidi by running
  it, through driver-perf's `node-mapper` mode or a scratch script;
- record the exact Classic semantics craftdriver relies on: read the callers;
- set the risk level.

Endpoints come from `grep 'path: \`/session' src/lib/driver.ts src/lib/webelement.ts`
(38 distinct). Draft:

| Classic endpoint | craftdriver API | BiDi / script equivalent | risk |
|---|---|---|---|
| `POST /url` | `navigateTo` | `browsingContext.navigate {wait:'complete'}`, plus net-error → error mapping | low |
| `GET /url` | `getCurrentUrl` | `browsingContext.getTree {root, maxDepth:0}` → `url` | low |
| `GET /title` | `getTitle` | `script.evaluate 'document.title'` | low |
| `POST /back`, `/forward` | `back`/`forward` | `browsingContext.traverseHistory {delta:±1}`, then wait for `browsingContext.load` (or `navigationCommitted` for same-document) | **medium**: Classic waits for the load |
| `POST /refresh` | `refresh` | `browsingContext.reload {wait:'complete'}` | low |
| `POST /element`, `/elements`, `/element/{id}/elements` | `findElement(s)` | `browsingContext.locateNodes` (+`startNodes`). css/xpath are native; id/name/class/tag → CSS; linkText/partialLinkText → `innerText` locator `matchType: full/partial` restricted to `a`, or XPath | **medium**: document order, link-text whitespace rules |
| `GET /element/{id}/shadow`, `/shadow/{id}/element(s)` | shadow roots | Reuse `query.ts`'s existing `bidiShadow` path (`script.callFunction` → `shadowRoot`, `locateNodes` with `startNodes`) | low |
| `POST /element/{id}/click` | `WebElement.click` | WebDriver **element click** algorithm in script plus `input.performActions` (see B3.4) | **high** |
| `POST /element/{id}/value` | `sendKeys` | Focus plus `input.performActions` key sequence; file inputs → `input.setFiles` (B3.5) | **high** |
| `POST /element/{id}/clear` | `clear` | WebDriver **element clear** algorithm in script | medium |
| `GET /element/{id}/text` | `getText` | Selenium `bot.dom.getVisibleText` atom via `script.callFunction` (B3.3) | **high** |
| `GET /element/{id}/attribute/{n}` | `getAttribute` | Selenium `getAttribute` atom (boolean-attribute and property fallbacks) | medium |
| `GET /element/{id}/property/{n}` | `getProperty` | `script.callFunction (el,n)=>el[n]` | low |
| `GET /element/{id}/enabled` | `isEnabled` | Spec "is element enabled" (disabled controls, fieldset/legend, optgroup) | medium |
| `GET /element/{id}/selected` | `isSelected` | `checked` / `selected` per spec | low |
| `GET /element/{id}/name` | `getTagName` | `el.localName` | low |
| `GET /element/{id}/rect` | `getRect` | `getBoundingClientRect()` + `scrollX/Y` | low |
| `GET /element/{id}/screenshot`, `GET /screenshot` | screenshots | `browsingContext.captureScreenshot` (+`clip: {type:'element'}`) | low; check scroll-into-view parity |
| `POST /actions` (12 call sites) | keyboard/mouse/wheel/touch | `input.performActions` (same action model; `origin: {type:'element', element:{sharedId}}`) + `input.releaseActions` | low–medium: check touch pointerType and pinch in the mapper |
| `POST /execute/sync`, `/execute/async` | `executeScript` | `script.callFunction {awaitPromise}`, async via a Promise wrapper around the callback; **serialization layer needed** (B3.2) | **medium** |
| `POST /timeouts` | `setScriptTimeout` | Client-side timeout around `script.callFunction` | low |
| `GET /window/handles`, `POST /window`, `DELETE /window`, `GET /window` | windows | `browsingContext.getTree` / `activate` / `close`; "current" context tracked client-side | medium |
| `POST /window/rect` | `setWindowRect` | BiDi `browser.setClientWindowState` (check mapper support) or CDP `Browser.setWindowBounds` | medium |
| `POST /frame` | `switchToFrame` | Child contexts from `getTree`; current frame tracked client-side | medium |
| `GET /alert/text`, `POST /alert/accept`, `/dismiss`, `/alert/text` | alerts | `browsingContext.handleUserPrompt {accept, userText}`; text from the last `userPromptOpened` (already subscribed) | low |
| `GET/POST/DELETE /cookie[...]` | cookies | `storage.getCookies` / `setCookie` / `deleteCookies` with `partition:{type:'context'}`; map sameSite and expiry | low–medium |
| `POST /se/file` | `uploadFile` | Remote only; not on the local driverless path | n/a |
| `DELETE /session` | `quit` | `session.end`, then `LaunchedChrome.close()` | low |

**Done when:** every row is verified (✅ works / ⚠ works with a stated
difference / ❌ no equivalent), each ⚠ and ❌ has a proposal, and the table
is pasted into the Research log. That's gate G1.

### B1.2 (R) Error-code parity

- Recovery loops depend on Classic error strings in
  `CraftdriverError.detail.webDriverError` (parsed in
  [src/lib/http.ts](../src/lib/http.ts)). Example:
  [src/lib/clickFastPath.ts](../src/lib/clickFastPath.ts) retries on
  `no such element`, `stale element reference`, `element not interactable`,
  `element click intercepted` and `move target out of bounds`.
- `grep -rn "webDriverError" src/` lists every consumer.
- Produce a table: Classic error string → when it fires → the BiDi error or
  script condition that must produce the same string. Examples:
  - BiDi `no such node`, and a detached sharedId → `stale element reference`;
  - the B3.4 click algorithm's "obscured" outcome → `element click intercepted`.
- **Done when:** the table covers every string any `src/` consumer matches
  on.

### B1.3 (R) Selenium atoms

- `getText` and `getAttribute` need Selenium's compiled atoms
  (`bot.dom.getVisibleText`, `webdriver.atoms.element.attribute.get`):
  - chromedriver embeds them;
  - craftdriver's `isDisplayed` already mirrors `bot.dom.isShown_` in
    [src/lib/webelement.ts](../src/lib/webelement.ts).
- Decide: vendor the compiled atoms (Apache-2.0; NOTICE obligations if
  vendored, which must be checked) or reimplement. Recommendation: vendor
  them. Text whitespace rules are where reimplementations drift.
- **Done when:** the source URL, pinned commit, licence handling, size and
  loading mechanism are written down: a `script.callFunction` with the atom
  source, cached per realm via `script.addPreloadScript` or sent per call.
  Measure both.

### B1.4 (R) Class shape: how the BiDi driver plugs in

- Today `Driver` is a concrete Classic HTTP class used by `browser.ts` (~44
  call sites), `page.ts` (~23), `query.ts` (~10), `elementHandle.ts` (~7) and
  `wait.ts` (~4). `WebElement` talks HTTP directly.
- Propose the seam:
  - extract `interface WebDriverPort` (every public `Driver` method) and
    `interface ElementPort` (every `WebElement` method);
  - `Driver` and `WebElement` become the Classic implementations;
  - new `BidiDriver` and `BidiElement` implement the same ports over a
    `BiDiConnection`.
  - Element identity: in driverless mode element ids are BiDi `sharedId`s
    (the format driver-perf verified as identical to chromedriver's), so
    `query.ts`'s sharedId interop keeps working.
- **Done when:** a short design note (in this file) shows the interfaces as
  TypeScript signatures, the construction site in `Browser.launch`, and how
  `Browser`, `Page`, `Frame` and `ElementHandle` reach the port without
  `instanceof` checks.
- Run the `craftdriver-engineering` API-review checklist: the ports must stay
  internal, not exported from `src/index.ts`.

---

## Phase B2: skeleton

### B2.1 Port extraction (no behavior change)

- **Files:** `src/lib/driver.ts`, `src/lib/webelement.ts`, new
  `src/lib/ports.ts`, and every call site found in B1.4.
- **Do:** introduce the interfaces from B1.4; make `Driver` and `WebElement`
  implement them; change consumers to depend on the interfaces.
- **Done when:** `lint`, `build` and the focused suites (`locator`,
  `element-handle`, `iframes`, `dialogs`, `keyboard`, `browser-context`) pass.
  The perf check `npm run bench -- bidi-vs-classic` is within jitter.

### B2.2 Driverless launch path behind a switch

- **Files:** `src/lib/browser.ts`, `src/lib/types.ts`, new
  `src/lib/bidiDriver.ts` (empty port implementation that throws
  `CraftdriverError(UNSUPPORTED, 'not yet ported: <method>')`).
- **Do:**
  - Add `LaunchOptions.chromeLaunchMode` with the value `'driverless'` (same
    option as Plan A; add the value if Plan A landed) and
    `CRAFTDRIVER_CHROME_LAUNCH_MODE=driverless`.
  - Routing conditions: Plan A's A2.4 list. **Also require
    `bidiRequested`**, since `enableBiDi: false` has no meaning without
    Classic.
  - Explicit `'driverless'` that can't be honored throws `UNSUPPORTED`.
  - Launch: `ChromeLauncher.launch` → in-process mapper → `session.new` with
    craftdriver's capabilities (`unhandledPromptBehavior` map from
    `applyBidiDefaults`, `acceptInsecureCerts`) → `initBiDi` over the
    in-process transport → `new BidiDriver(connection, initialContext)`.
  - Quit: `session.end` → mapper close → `LaunchedChrome.close()`.
- **Done when:** a driverless launch, a BiDi-only operation (`evaluate`) and
  quit work, and calling a not-yet-ported method throws the clear
  `UNSUPPORTED` error. Leak test as in Plan A A2.4.

---

## Phase B3: port by family

Each family is one PR. Its focused tests must pass with
`CRAFTDRIVER_CHROME_LAUNCH_MODE=driverless` **and** unchanged in default
mode. Order follows dependency and risk: cheap families first, so the test
suite becomes usable in driverless mode early.

### B3.1 Navigation, session info, timeouts

- `navigateTo`, `back`, `forward`, `refresh`, `getCurrentUrl`, `getTitle`,
  `setScriptTimeout`.
- `back` and `forward` must resolve only after the target page's `load`, as
  Classic does. Handle bfcache and same-document history entries, where no
  `load` fires: use `browsingContext.navigationCommitted` /
  `fragmentNavigated`.
- **Tests:** `tests/navigation.test.ts`, `tests/load-state.test.ts`,
  `tests/login.test.ts`.

### B3.2 Script execution and serialization

- `executeScript` and `executeAsyncScript` via `script.callFunction`.
- **Do:**
  1. Arguments: JS values → BiDi `LocalValue`; `WebElement` args → `{sharedId}`.
  2. Results: BiDi `RemoteValue` → Classic-shaped JSON. Nodes → element ids
     (sharedId); Arrays and Objects recursively; Dates, RegExp, Map, Set and
     NaN/Infinity as Classic would surface them; cycles → error.
  3. Async scripts: wrap them so the last argument is a resolve callback, and
     reject on a client-side timeout from `setScriptTimeout`.
- Write the deserializer as a pure function with exhaustive unit tests over
  every `RemoteValue` type.
- **Tests:** `tests/evaluate.test.ts`, plus the new unit tests.

### B3.3 Element finding and reads

- `findElement(s)` (all `By` strategies; see
  [src/lib/by.ts](../src/lib/by.ts)), element-scoped find, shadow root.
- Reads: `getText` (atom), `getAttribute` (atom), `getProperty`,
  `getTagName`, `getRect`, `isSelected`, `isEnabled`, `isDisplayed` (existing
  script, reused), `isFocused`, `getComputedCssValue`, `isInViewport`.
- Errors per B1.2: unknown or detached sharedId → `stale element reference`.
- **Tests:** `tests/locator.test.ts`, `tests/get-by-role.test.ts`,
  `tests/element-handle.test.ts`, `tests/shadow-dom.test.ts`,
  `tests/shadow-dom-protocol.test.ts`.

### B3.4 Click (highest risk)

- Implement WebDriver §12.4.1 "Element Click" **in order**:
  1. element is a file input → `invalid argument`;
  2. scroll into view (`block: 'end', inline: 'nearest'`, as chromedriver
     does; verify);
  3. compute the in-view center point; if none → `element not interactable`;
  4. pointer-interactable check: `elementsFromPoint(center)[0]` is the element
     or a descendant, else `element click intercepted` with the obscuring
     element described the way chromedriver words it;
  5. `<option>` special case (select via its parent select, fire
     input/change);
  6. `input.performActions` pointer move/down/up at the center point;
  7. wait for any navigation the click started (Classic's
     "try to run the post-navigation checks").
- Steps 1–5 are a single `script.callFunction`, so one round trip. Step 6 is
  BiDi.
- **Tests:**
  - `tests/locator.test.ts` click cases, `tests/dialogs.test.ts` (click opens
    alert), `tests/iframes.test.ts`;
  - new `tests/click-parity.test.ts` with fixtures for: obscured button,
    zero-size element, off-screen element, `<option>`, a link that navigates,
    and an element moved by a scroll handler. Each fixture asserts the
    **same outcome and error string** in default and driverless mode.

### B3.5 Typing and clear

- `sendKeys`:
  1. Focus the element: script, move the caret to the end per spec.
  2. For `input[type=file]` → `input.setFiles` (local paths; the remote
     `/se/file` path stays Classic-only).
  3. Otherwise `input.performActions` key actions. Map craftdriver's `Keys`
     PUA codepoints, which BiDi uses unchanged.
  4. `element not interactable` when the element can't take focus.
- `clear`: the spec's clear algorithm (editable / content-editable checks,
  set value, fire `input` and `change` as Chrome's chromedriver does; verify).
- **Tests:** `tests/keyboard.test.ts`, `tests/login.test.ts`,
  `tests/file-transfer.test.ts` (upload half), plus a new
  `tests/type-parity.test.ts` (contenteditable, maxlength, readonly,
  disabled, number input, IME-free unicode).

### B3.6 Actions

- `keyPressCode`, `keyDownCode`, `keyUpCode`, `typeText`, `pointerMoveTo`,
  `mouseDown`, `mouseUp`, `pointerClick`, `wheelScroll`, `performTouchSwipe`,
  `performTouchPinch`.
- Same action model, so mostly translation. Verify touch actions in the
  mapper; pinch needs two touch pointers.
- **Tests:** `tests/keyboard.test.ts`, `tests/mouse.test.ts`.
- **Gap:** there is no local Chrome test for `performTouchSwipe` or
  `performTouchPinch`; only remote and Safari tests exercise them. Add
  `tests/touch-actions.test.ts` (with a fixture page that records touch
  events) and get it passing in **default** mode *before* porting, so there's
  a baseline to compare against.

### B3.7 Windows, frames, alerts, cookies, window rect

- Windows and frames: a client-side "current context" pointer replaces
  Classic's server-side one. `switchToFrame(null)` returns to top.
- Detached-context errors map to `no such window` / `no such frame`.
- Alerts via `handleUserPrompt`.
- Cookies via `storage.*`. Map `sameSite` (`Lax`/`Strict`/`None` →
  lowercase in BiDi), `expiry` seconds and `httpOnly`/`secure`.
- `setWindowRect` per B1.1's verified row.
- **Tests:** `tests/iframes.test.ts`, `tests/active-page.test.ts`,
  `tests/dialogs.test.ts`, `tests/storage.test.ts`,
  `tests/browser-context-storage.test.ts`, `tests/emulate.test.ts`.

### B3.8 Screenshots and launch-time capabilities

- Page and element screenshots via `captureScreenshot`.
- Downloads (R2 answer) and `mobileEmulation` (R3 answer: BiDi
  `browsingContext.setViewport` + `emulation.*` or CDP) implemented on the
  driverless path.
- **Tests:** `tests/screenshots.test.ts`, `tests/visual-*.test.ts`,
  `tests/file-transfer.test.ts` (download half),
  `tests/mobile-emulation.test.ts`.

---

## Phase B4: parity and performance

### B4.1 Full-suite parity in CI

- **Files:** `.github/workflows/ci.yml`.
- **Do:** add a job running `npm test` with
  `CRAFTDRIVER_CHROME_LAUNCH_MODE=driverless` on ubuntu-latest, plus
  chrome-smoke on macOS and Windows.
  - Non-blocking for one week, then blocking.
- **Done when:** 3 consecutive green runs (gate G3). Every driverless-only
  failure gets a root cause and a parity test before it's fixed.

### B4.2 Perf evidence

- **Files:** `tests/perf/launch-critical-path.perf.ts` (add a `driverless`
  arm; paired with BiDi, Classic and hybrid if Plan A landed);
  `tests/perf/bidi-vs-classic.perf.ts` (per-command flow, driverless arm).
- **Done when:**
  - The launch saving is reproduced in this repo.
  - Per-command flow is within jitter of today's default. If any op
    regresses, root-cause it before G4: the atoms and the click script are
    the likely suspects.

### B4.3 CLI and MCP

- The CLI daemon and MCP server launch browsers through `Browser.launch`, so
  they inherit the mode.
- Run `npm run test:cli` in driverless mode once. Add it to the CI job if
  it's green.

---

## Phase B5: rollout

- **B5.1 Docs.**
  - `docs/driver-configuration.md`: the modes, what driverless doesn't cover
    (Electron, remote, `enableBiDi:false`, Firefox, Safari), troubleshooting,
    and Chrome-version compatibility with the pinned mapper.
  - `docs/zero-config-drivers.md`: no chromedriver needed for local Chrome in
    driverless mode.
  - CHANGELOG with the B4.2 numbers.
- **B5.2 Default flip (G4, owner).** `'auto'` → driverless when routable,
  else hybrid (if Plan A landed), else chromedriver.
  - Keep both escape hatches.
  - Driver auto-download only happens when a launch actually needs
    chromedriver.

## Risks

| risk | mitigation |
|---|---|
| Classic semantics drift (click, typing, text) silently changes test outcomes | Parity test files that run every fixture in both modes and diff the outcome and error string; vendored Selenium atoms |
| The 38-endpoint port is larger than estimated | B1.1 verifies every row before G1; families are separate PRs, and the skeleton throws a clear `UNSUPPORTED` for unported methods, so partial progress is safe to merge behind the switch |
| Two Chrome paths to maintain forever | The `WebDriverPort` seam keeps the paths separate; CI runs both |
| Mapper/Chrome version skew | Plan A's R4 version window; fall back to the chromedriver path outside it |
| Gain over hybrid is small on fast Linux | Gate G0 measures driverless vs hybrid directly before any port work |

## Follow-ups (out of scope)

- **geckodriver-less Firefox.** Launch Firefox with `--remote-debugging-port`
  and connect its native BiDi directly to `BidiDriver`. No mapper is needed.
  The July 2026 data showed Firefox pays ~0 BiDi tax but ~4.5 s New Session
  through geckodriver; measure how much of that geckodriver accounts for.
- Electron through the same path (Electron is Chromium + CDP). It needs
  separate research because of the fuses, packaging and the main-process
  bridge.

## Research log

(Append findings here: date, task id, evidence, decision.)
