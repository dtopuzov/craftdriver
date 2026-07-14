export const EXAMPLES_BASE_URL = process.env.EXAMPLES_BASE_URL || 'http://127.0.0.1:8080';

export type BrowserName = 'chrome' | 'chromium' | 'firefox' | 'safari';

export const BROWSER_NAME: BrowserName = (process.env.BROWSER_NAME as BrowserName) || 'chrome';

/** Chromium-family browsers (chrome, chromium, edge). Useful for gating
 *  assertions that depend on Chromium-only BiDi behaviour, e.g. stack
 *  traces being attached to non-error console messages. */
export const IS_CHROMIUM = BROWSER_NAME === 'chrome' || BROWSER_NAME === 'chromium';
