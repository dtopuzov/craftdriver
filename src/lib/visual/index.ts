/**
 * Controlled exports for the visual-testing feature. The public entrypoint
 * (`src/index.ts`) re-exports from here; pngjs and other codec internals are
 * never surfaced.
 */

export { compareScreenshots } from './compare.js';
export { VisualMismatchError } from './visualError.js';
export {
  runExpectScreenshot,
  shouldUpdateVisualBaselines,
  type CaptureFn,
} from './expectScreenshot.js';
export type {
  ScreenshotCompareOptions,
  ExpectScreenshotOptions,
  VisualScreenshotOptions,
  VisualComparisonResult,
  ScreenshotMatchResult,
} from './types.js';
