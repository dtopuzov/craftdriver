/**
 * Centralized timing constants: poll intervals, timeouts, fixed delays, and
 * retry policy. Kept in one place so they are easy to find and tune rather than
 * scattered as magic numbers across the codebase. All values are milliseconds.
 *
 * This module intentionally has no imports so any file can depend on it without
 * risking an import cycle.
 */

// ── Auto-wait / retry poll intervals ─────────────────────────────────────────

/**
 * Base cadence for all auto-wait retry loops. Kept short so a condition that
 * flips true mid-interval is noticed quickly rather than up to a full interval
 * late. The first check of every loop runs immediately, so conditions that are
 * already satisfied never pay it — it only affects genuine waits. Round trips
 * to a local driver are cheap (~a few ms), so polling this often is fine.
 *
 * Used for element visibility/existence waits and `Locator` resolution.
 */
export const DEFAULT_POLL_INTERVAL_MS = 25;

/**
 * How often `expect(...)` assertion retries re-check their matcher (text,
 * value, class, …). Same responsive cadence as {@link DEFAULT_POLL_INTERVAL_MS}
 * so an assertion that becomes true shortly after a failed check passes almost
 * immediately instead of waiting out a long interval.
 */
export const ASSERTION_POLL_INTERVAL_MS = 25;

/** Poll interval for the driver service's `/status` readiness check. */
export const DRIVER_READINESS_POLL_INTERVAL_MS = 25;

/**
 * Poll interval for state that changes at process/OS speed rather than DOM
 * speed: Classic `document.readyState`, the Classic `waitForPage`
 * window-handle fallback, and download-file polling. Kept at the same 25ms
 * cadence for responsiveness — these checks (a script eval, a window-handle
 * list, an `fs.stat`) are cheap enough to run this often.
 */
export const STATE_POLL_INTERVAL_MS = 25;

/**
 * Per-attempt cap on how long one `expect(...)` retry waits for the element to
 * *exist* before looping back to re-run the whole matcher. This does NOT govern
 * how fast an assertion re-checks — the matcher is re-evaluated every
 * {@link ASSERTION_POLL_INTERVAL_MS}, and an element that already exists returns
 * from the existence wait immediately. Existence itself is polled at
 * {@link DEFAULT_POLL_INTERVAL_MS} inside this window, so a slow-to-appear
 * element is still caught within ~25ms; the cap only bounds a single attempt so
 * the outer loop keeps its cadence and honours the overall timeout.
 */
export const ASSERTION_INNER_WAIT_CAP_MS = 250;

// ── Default timeouts ─────────────────────────────────────────────────────────

/** Default timeout for element interactions and waits (click, fill, find, …). */
export const DEFAULT_ELEMENT_TIMEOUT_MS = 5_000;

/**
 * Default timeout for navigation and network/event waits (navigateTo,
 * waitForRequest/Response, log waits, download waits).
 */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

/** Default timeout for the BiDi WebSocket connect and for each BiDi command. */
export const BIDI_TIMEOUT_MS = 30_000;

/** How long to wait for the driver service to report ready after spawning. */
export const DRIVER_READINESS_TIMEOUT_MS = 5_000;

/**
 * Readiness deadline for geckodriver specifically — it takes longer than
 * chromedriver to spin up Marionette and start listening.
 */
export const FIREFOX_READINESS_TIMEOUT_MS = 15_000;

/** Timeout for the `<driver|browser> --version` capability probe spawn. */
export const VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Timeout for the `which` / `where` PATH-probe spawn. */
export const PATH_PROBE_TIMEOUT_MS = 2_000;

// ── Fixed delays ─────────────────────────────────────────────────────────────

/** Best-effort settle used as the Classic fallback for `networkidle`. */
export const NETWORK_IDLE_SETTLE_MS = 500;

/**
 * Pause between `driver.quit()` and stopping the driver service, giving the
 * browser time to release its ports (notably Firefox's BiDi WebSocket) before a
 * subsequent launch reuses them; without it a fresh launch can hit a 404.
 */
export const PORT_RELEASE_DELAY_MS = 500;

/** Delay before a BiDi connection auto-reconnect attempt. */
export const BIDI_RECONNECT_DELAY_MS = 1_000;

// ── Retry policy ─────────────────────────────────────────────────────────────

/**
 * BiDi connect retries. Firefox may not have finished binding its BiDi
 * WebSocket right after the session is created; back off linearly between
 * attempts (delay = {@link BIDI_CONNECT_BACKOFF_STEP_MS} × attempt).
 */
export const BIDI_CONNECT_MAX_ATTEMPTS = 8;
export const BIDI_CONNECT_BACKOFF_STEP_MS = 300;

/**
 * WebDriver session-creation retries. Firefox's Marionette interface can lag
 * geckodriver reporting healthy, so retry with linear backoff (delay =
 * {@link SESSION_CREATE_BACKOFF_STEP_MS} × attempt); Chrome is reliable enough
 * to need a single attempt.
 */
export const FIREFOX_SESSION_MAX_ATTEMPTS = 4;
export const CHROME_SESSION_MAX_ATTEMPTS = 1;
export const SESSION_CREATE_BACKOFF_STEP_MS = 500;

/**
 * `evaluate()` retries on a transient "execution contexts cleared" BiDi error.
 * A Classic-first navigate returns at `readyState === 'complete'`, which is not
 * a barrier the BiDi side respects — an immediately following `{ context }`
 * script call can land while BiDi is still swapping the old realm for the new
 * one. The error is pre-execution (the script never ran, no side effects), so a
 * short retry that re-resolves the context is safe. See
 * plans/TODO-bidi-first-navigation.md (Option A).
 */
export const EVAL_REALM_RETRY_ATTEMPTS = 3;
export const EVAL_REALM_RETRY_DELAY_MS = 25;
