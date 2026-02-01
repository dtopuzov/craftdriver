export const EXAMPLES_BASE_URL = process.env.EXAMPLES_BASE_URL || 'http://127.0.0.1:8080';

export type BrowserName = 'chrome' | 'chromium' | 'firefox' | 'edge' | 'safari';

export const BROWSER_NAME: BrowserName = (process.env.BROWSER_NAME as BrowserName) || 'chrome';
