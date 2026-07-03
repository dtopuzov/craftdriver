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
 * How often the element auto-wait machinery re-checks its condition: element
 * visibility/existence waits and `Locator` resolution loops. The first check
 * always runs immediately, so a condition that is already satisfied never pays
 * this interval — it only affects genuine waits on dynamically-appearing state.
 */
export const DEFAULT_POLL_INTERVAL_MS = 25;

/**
 * How often `expect(...)` assertion retries re-check their matcher. Coarser
 * than {@link DEFAULT_POLL_INTERVAL_MS} because each attempt does more work
 * (resolve element + read a property + evaluate the matcher), so polling it as
 * aggressively as bare visibility buys little and adds load.
 */
export const ASSERTION_POLL_INTERVAL_MS = 100;

/** Poll interval for the driver service's `/status` readiness check. */
export const DRIVER_READINESS_POLL_INTERVAL_MS = 25;

/**
 * Poll interval for state that changes at process/OS speed rather than DOM
 * speed: Classic `document.readyState`, the Classic `waitForPage`
 * window-handle fallback, and download-file polling. Deliberately coarser than
 * {@link DEFAULT_POLL_INTERVAL_MS} — polling these faster buys nothing.
 */
export const STATE_POLL_INTERVAL_MS = 100;

/**
 * Upper bound on the inner `elementExists` wait inside an `expect(...)`
 * assertion, so a single attempt cannot consume the whole assertion budget
 * before the outer retry loop gets to re-evaluate the matcher.
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
