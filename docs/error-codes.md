# Error codes

Nearly every error thrown from the public craftdriver API is a
[`CraftdriverError`](../src/lib/errors.ts), carrying:

- `code` — a stable, machine-readable identifier from the table below.
- `message` — human-readable summary.
- `detail` — JSON-serializable structured context (selector, timeout,
  candidates, etc.). Safe to log or send to an LLM.
- `hint` — one-line remediation when there is an obvious next step.

`CraftdriverError extends Error`, so `instanceof Error` keeps working
and stack traces are preserved.

> A few edge cases still throw a plain `Error` instead — e.g. calling
> `startTrace()` again while a trace is already running, or without
> `outDir`. Guard against these with normal usage (don't call `startTrace()`
> twice without `stopTrace()`) rather than a `code` check.

```ts
import { CraftdriverError, ErrorCode } from 'craftdriver';

try {
  await browser.locator('#missing').click();
} catch (err) {
  if (CraftdriverError.is(err, ErrorCode.NO_MATCH)) {
    // Selector matched zero elements — fix the selector.
    console.error(err.detail);
  }
}
```

## Codes

| Code | When it fires | Typical recovery |
|---|---|---|
| `NO_MATCH` | Selector matched zero elements within the timeout. | Fix the selector. Prefer `By.testId` / `By.role` / `By.labelText` over CSS for resilience. |
| `TIMEOUT_WAITING_VISIBLE` | Selector matched an element, but it never became visible within the timeout. | Open the containing view first (modal, accordion, tab). The element is in the DOM but not displayed. |
| `TIMEOUT_WAITING_STATE` | Element visible but never reached the requested state (`enabled`, `checked`, `attached`, `detached`, `hidden`). | Wait for the precondition that drives the state transition. |
| `TIMEOUT_WAITING_LOAD` | Page never reached the requested load state (`load` / `domcontentloaded` / `networkidle`). | Bump the navigation timeout, or wait on a stable DOM signal instead. |
| `TIMEOUT_WAITING_NETWORK` | A specific request / response / network-idle predicate did not resolve. | Verify the predicate matches the real traffic; widen with a regex. |
| `TIMEOUT_WAITING_DIALOG` | `waitForDialog()` did not see a dialog of the expected type. | Confirm the action under test actually opens the dialog. |
| `TIMEOUT` | Generic `WebDriverWait.until(...)` timeout with no more specific code. | Same as above — check the condition. |
| `EXPECT_MISMATCH` | An `expect(locator).to…()` assertion failed after auto-waiting. | Inspect `error.detail` for the selector and observed value. |
| `A11Y_VIOLATIONS` | `browser.a11y.check()` (or scoped variants) found axe-core violations. | Iterate over `error.violations` — each has an `id`, `impact`, and `helpUrl`. |
| `EVAL_THREW` | The function passed to `evaluate()` threw inside the page. Also fires for `browser.clock` methods (`tick()`, `setSystemTime()`, `runFor()`) called before `install()` — they run as in-page scripts under the hood. | The page-side exception text is in `error.detail.exception`. |
| `EVAL_BAD_ARG` | `evaluate()` / `addInitScript()` received a non-JSON-serializable argument (function, Symbol, DOM node…). | Pass plain JSON values. |
| `INVALID_ARGUMENT` | Caller passed an invalid value (bad enum, wrong shape, unparseable duration…). For storage-state restore this includes malformed JSON/native schema, invalid cookies/origins, or multi-origin sessionStorage. | Read the message; it lists the accepted forms. Re-save a corrupt or hand-edited state file. |
| `UNSUPPORTED` | Feature exists but is unavailable on this browser/transport (e.g. Chromium-only over Firefox, or a BiDi-only feature with BiDi disabled). Storage-state launch/context APIs also reject non-empty sessionStorage rather than silently dropping it, and Classic launch rejects non-empty state. | Enable BiDi (`enableBiDi: true`) or switch browser. For sessionStorage or Classic, launch without state, navigate to its sole origin, then call `browser.loadState()`. |
| `NO_OPEN_SHADOW_ROOT` | A shadow host resolved, but its public `shadowRoot` getter returned `null`. This intentionally covers both an unattached root and a closed root. | Verify the host is correct and the component uses `mode: "open"`. |
| `DETACHED_SHADOW_ROOT` | A shadow root detached while resolving a query and full-plan retries could not recover. | Recreate the component or use a stable host locator; inspect `detail.queryPath` and `detail.attempts`. |
| `STATE_INVALID` | Method called in the wrong state (e.g. `stopTrace()` without `startTrace()`). A Classic/active-page state restore also uses this when there is no active HTTP(S) origin or its origin cannot accept every requested storage entry and cookie. | Call the prerequisite first. For active-page restore, navigate to the state’s sole origin before loading it. |
| `STALE_REF` | An agent-surface snapshot ref (`ref=eN`) no longer identifies one live registry element. | Take a fresh `snapshot` and use the new ref. `error.detail.reason` says which case fired: `detached` (element removed), `document-changed` (page navigated or reloaded), `unknown-ref` (never issued for this document), `ambiguous` (corrupt/legacy identity registry), `no-snapshot` (none taken yet). Diagnostic marker attributes do not resolve refs, so cloning one cannot redirect or invalidate a live ref. |
| `DRIVER_ERROR` | A WebDriver command returned a protocol error (non-200 response) — e.g. `stale element reference`, `element click intercepted`, `invalid selector` — or a transport-level failure. A live-context state overlay can also fail after some entries were applied. | `error.detail.webDriverError` carries the W3C JSON error code and `error.detail.webDriverMessage` the driver's message; recovery loops match on `webDriverError`. For storage restore inspect `phase` and `partialApplied`; use a fresh context when failure isolation matters. Also inspect `error.cause`. |
| `ELECTRON_DRIVER_MISMATCH` | The resolved chromedriver can't drive the Electron app, caught **before** a session is created. | `error.detail.kind` is `'chromium-major'` (driver major ≠ the app's bundled Chromium; see `driverMajor` / `expectedChromiumMajor` / `electronVersion`) or `'arch'` (`driverArch` ≠ `runtimeArch`). The `hint` names the fix. |
| `ELECTRON_LAUNCH_FAILED` | The Electron app process exited during session creation ("Chrome instance exited"). | `error.detail` carries the diagnosed cause (`macSigning: 'unsigned'`/`'adhoc'` on macOS, `sandboxDisabled: false` on Linux); `hint` is the top remediation; the message appends the chromedriver output tail; `error.cause` is the original driver error. |
| `ELECTRON_MAIN_UNAVAILABLE` | `browser.electron.executeMain(...)` couldn't reach the app's main process. | Launch with `electron: { mainProcess: true }`; ensure the app build keeps the `EnableNodeCliInspectArguments` fuse enabled (default). `hint` names the fix. |
| `ELECTRON_MAIN_THREW` | The `executeMain(...)` callback threw inside the Electron main process. | The main-process exception text is in the message; treat like a failed assertion about main-process state. |
| `ELECTRON_DEEPLINK_FAILED` | `browser.electron.triggerDeeplink(url)` could not open the custom-protocol URL. | An unsupported platform, a missing `appBinaryPath` on Windows, or the OS `open`/`gio`/`rundll32` launcher failed (`error.detail.command`, `error.cause`). An invalid or `http(s)`/`file` URL throws `INVALID_ARGUMENT` instead. |
| `VISUAL_MISMATCH` | `browser.expectScreenshot()` never matched the baseline within its timeout. | Thrown as `VisualMismatchError` (a `CraftdriverError` subclass). Read `error.actual` and `error.diff` (PNG `Buffer`s) to see the regression; `error.detail` carries JSON-safe path/dimensions/`diffPixels`/`diffPercentage`/`attempts`. If the change is intentional, re-run with `CRAFTDRIVER_UPDATE_VISUAL_BASELINES=true` to overwrite the baseline. See [visual-testing.md](./visual-testing.md). |

## Stability

- Codes are **append-only**. New ones may be added; existing ones are
  never renamed or repurposed.
- `code` strings are case-sensitive and stable across patch releases.
- `detail` keys are additive: new keys may appear; existing keys keep
  their meaning.

## Distinguishing the three common probe failures

This is the highest-leverage distinction for agents:

- **`NO_MATCH`** — your selector is wrong.
- **`TIMEOUT_WAITING_VISIBLE`** — the element is there; you opened the
  page too early or skipped a UI step that reveals it.
- **`TIMEOUT_WAITING_STATE`** — the element is visible; you tried to
  act on it before it was ready (still disabled, still loading…).

Each one points at a different fix. Today's prose-only error collapses
all three, which is exactly why naive recovery loops loop.
