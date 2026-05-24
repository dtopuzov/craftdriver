// Public entrypoint: expose the simplified Browser API only
export {
  Browser,
  devices,
  type LaunchOptions,
  type LoadState,
  type Dialog,
  type DialogType,
  type MobileEmulation,
  type DeviceMetrics,
  type DeviceName,
  type Download,
} from './lib/browser.js';
export { Key } from './lib/keys.js';
export { By } from './lib/by.js';
export { Locator } from './lib/locator.js';
export { Frame } from './lib/frame.js';
export { Page } from './lib/page.js';
export { BrowserContext } from './lib/browserContext.js';
export { Keyboard } from './lib/keyboard.js';
export { Mouse } from './lib/mouse.js';
export {
  type TraceStartOptions,
  type TraceEvent,
  type TraceBundle,
} from './lib/tracing.js';

// BiDi features - network interception, logging, session state
export {
  NetworkInterceptor,
  LogMonitor,
  SessionStateManager,
  type Cookie,
  type CookieInput,
  type SessionState,
  type StorageStateOptions,
  type MockResponse,
  type InterceptedRequest,
  type InterceptedResponse,
  type ConsoleMessage,
  type JavaScriptError,
  type LogMessage,
} from './lib/bidi/index.js';

// Driver services — expose for users who need custom binary paths / ports
export { ChromeService, type ChromeServiceOptions } from './lib/chrome.js';
export { FirefoxService, type FirefoxServiceOptions } from './lib/firefox.js';

// Virtual clock control
export {
  Clock,
  type ClockTime,
  type ClockInstallOptions,
} from './lib/clock.js';

// Accessibility audits (axe-core wrapper — axe-core ships with craftdriver)
export {
  A11y,
  A11yError,
  type A11yOptions,
  type A11yResult,
  type A11yViolation,
  type A11yViolationNode,
  type A11yImpact,
} from './lib/a11y.js';
