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
| `INVALID_ARGUMENT` | Caller passed an invalid value (bad enum, wrong shape, unparseable duration…). | Read the message; it lists the accepted forms. |
| `UNSUPPORTED` | Feature exists but is unavailable on this browser/transport (e.g. Chromium-only over Firefox, or a BiDi-only feature with BiDi disabled). | Enable BiDi (`enableBiDi: true`) or switch browser. |
| `STATE_INVALID` | Method called in the wrong state (e.g. `stopTrace()` without `startTrace()`). | Call the prerequisite first. |
| `DRIVER_ERROR` | Driver-level / transport-level failure surfaced to the caller. | Inspect `error.cause`. |

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
