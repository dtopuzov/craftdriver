// Public entrypoint: expose the simplified Browser API only
export {
  Browser,
  devices,
  type LaunchOptions,
  type MobileEmulation,
  type DeviceMetrics,
  type DeviceName,
} from './lib/browser.js';
export { Key } from './lib/keys.js';
export { By } from './lib/by.js';

// BiDi features - network interception, logging, session state
export {
  BiDiSession,
  BiDiConnection,
  NetworkInterceptor,
  LogMonitor,
  SessionStateManager,
  type SessionState,
  type StorageStateOptions,
  type MockResponse,
  type InterceptedRequest,
  type ConsoleMessage,
  type JavaScriptError,
  type LogMessage,
} from './lib/bidi/index.js';
