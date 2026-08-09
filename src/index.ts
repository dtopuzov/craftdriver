// Public entrypoint: expose the simplified Browser API only
export {
  CraftdriverError,
  ErrorCode,
  type ErrorCodeName,
  type ErrorCodeValue,
  type CraftdriverErrorOptions,
} from './lib/errors.js';
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
  type EmulateOptions,
  type ElectronLaunchOptions,
  type PageMatcher,
} from './lib/browser.js';
export { type RemoteWebDriverOptions, type RemoteAuth } from './lib/remote.js';
export { Key } from './lib/keys.js';
export { By } from './lib/by.js';
export { Locator } from './lib/locator.js';
export {
  type AssertionOptions,
  type DocumentExpectApi,
  type ElementExpectApi,
  type LocatorExpectApi,
} from './lib/expect.js';
export { ShadowRootLocator } from './lib/shadowRootLocator.js';
export { Frame } from './lib/frame.js';
export { Page } from './lib/page.js';
export {
  BrowserContext,
  type ClearCookiesFilter,
  type ContextStorageStateOptions,
  type BrowserContextConfig,
  type BrowserContextHooks,
  type InitScriptHandle,
  type RoutePattern,
} from './lib/browserContext.js';
export { Keyboard } from './lib/keyboard.js';
export { Mouse } from './lib/mouse.js';
export {
  type TraceStartOptions,
  type TraceStopOptions,
  type TraceScreenshotMode,
  type TraceEvent,
} from './lib/tracing.js';

// BiDi features - network interception, logging, session state
export {
  NetworkInterceptor,
  LogMonitor,
  SessionStateManager,
  type Cookie,
  type CookieInput,
  type SessionState,
  type SessionStateCookie,
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
export {
  inspectChromeDriverResolution,
  type ChromeDriverResolutionInfo,
} from './lib/driverManager.js';
export { ElectronService, type ElectronServiceOptions } from './lib/electron.js';
export { FirefoxService, type FirefoxServiceOptions } from './lib/firefox.js';
export { SafariService, type SafariServiceOptions } from './lib/safari.js';

// Electron main-process access (browser.electron)
export {
  ElectronRemote,
  type MainProcessCallback,
  type ElectronRemoteOptions,
  type ElectronMainConnectInfo,
} from './lib/electronRemote.js';
export {
  type ElectronDialogMock,
  type ElectronDialogMethod,
  type ElectronDialogCall,
  type ElectronDialogResult,
  type ElectronOpenDialogResult,
  type ElectronSaveDialogResult,
  type ElectronMessageBoxResult,
} from './lib/electronDialogMock.js';
export { type ElectronMock, type ElectronMockCall } from './lib/electronMock.js';
export {
  ElectronMainLogMonitor,
  type ElectronMainLog,
  type ElectronMainLogLevel,
  type ElectronMainLogHandler,
} from './lib/electronMainLogs.js';

// Virtual clock control
export {
  Clock,
  type ClockTime,
  type ClockInstallOptions,
} from './lib/clock.js';

// Visual screenshot assertions (expectScreenshot / compareScreenshots)
export {
  compareScreenshots,
  VisualMismatchError,
  type ScreenshotCompareOptions,
  type ExpectScreenshotOptions,
  type VisualScreenshotOptions,
  type VisualComparisonResult,
  type ScreenshotMatchResult,
} from './lib/visual/index.js';

// Accessibility audits (axe-core wrapper — axe-core ships with craftdriver)
export {
  A11y,
  A11yError,
  type A11yOptions,
  type A11yResult,
  type A11yViolation,
  type A11yViolationNode,
  type A11yImpact,
  type A11yShadowSelector,
  type A11yTarget,
} from './lib/a11y.js';
