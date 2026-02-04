/**
 * WebDriver BiDi protocol types
 * Based on W3C WebDriver BiDi specification
 */

// Base protocol types
export interface BiDiCommand {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface BiDiResponse {
  id: number;
  type: 'success' | 'error';
  result?: unknown;
  error?: string;
  message?: string;
  stacktrace?: string;
}

export interface BiDiEvent {
  type: 'event';
  method: string;
  params: Record<string, unknown>;
}

export type BiDiMessage = BiDiResponse | BiDiEvent;

// Session types
export interface SessionCapabilities {
  browserName: string;
  browserVersion: string;
  platformName: string;
  webSocketUrl?: string;
}

export interface SessionNewResult {
  sessionId: string;
  capabilities: SessionCapabilities;
}

// Browsing Context types
export type BrowsingContext = string;
export type Navigation = string;

export interface BrowsingContextInfo {
  context: BrowsingContext;
  url: string;
  userContext: string;
  children: BrowsingContextInfo[] | null;
  parent?: BrowsingContext | null;
  originalOpener?: BrowsingContext | null;
}

export type ReadinessState = 'none' | 'interactive' | 'complete';

export interface NavigationResult {
  navigation: Navigation | null;
  url: string;
}

// Script types
export type ScriptRealm = string;

export interface ScriptTarget {
  context?: BrowsingContext;
  realm?: ScriptRealm;
  sandbox?: string;
}

export interface ScriptEvaluateResult {
  type: 'success' | 'exception';
  realm: ScriptRealm;
  result?: RemoteValue;
  exceptionDetails?: ExceptionDetails;
}

export interface ExceptionDetails {
  columnNumber: number;
  exception: RemoteValue;
  lineNumber: number;
  stackTrace: StackTrace;
  text: string;
}

export interface StackTrace {
  callFrames: StackFrame[];
}

export interface StackFrame {
  columnNumber: number;
  functionName: string;
  lineNumber: number;
  url: string;
}

export type RemoteValue =
  | { type: 'undefined' }
  | { type: 'null' }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number | 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { type: 'boolean'; value: boolean }
  | { type: 'bigint'; value: string }
  | { type: 'array'; value?: RemoteValue[] }
  | { type: 'object'; value?: [string | RemoteValue, RemoteValue][] }
  | { type: 'function' }
  | { type: 'regexp'; value: { pattern: string; flags?: string } }
  | { type: 'date'; value: string }
  | { type: 'map'; value?: [RemoteValue, RemoteValue][] }
  | { type: 'set'; value?: RemoteValue[] }
  | { type: 'node'; value: NodeProperties }
  | { type: 'window'; value: { context: BrowsingContext } };

export interface NodeProperties {
  nodeType: number;
  childNodeCount: number;
  nodeName?: string;
  nodeValue?: string;
  localName?: string;
  namespaceURI?: string;
  attributes?: Record<string, string>;
  children?: RemoteValue[];
  shadowRoot?: RemoteValue | null;
}

// Network types
export type NetworkIntercept = string;
export type NetworkRequest = string;

export type InterceptPhase = 'beforeRequestSent' | 'responseStarted' | 'authRequired';

export interface NetworkInterceptResult {
  intercept: NetworkIntercept;
}

export type BytesValue = { type: 'string'; value: string } | { type: 'base64'; value: string };

export interface NetworkCookie {
  name: string;
  value: BytesValue;
  domain: string;
  path: string;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none' | 'default';
  expiry?: number;
}

export interface NetworkHeader {
  name: string;
  value: BytesValue;
}

export interface NetworkRequestData {
  request: NetworkRequest;
  url: string;
  method: string;
  headers: NetworkHeader[];
  cookies: NetworkCookie[];
  headersSize: number;
  bodySize: number | null;
  timings?: FetchTimingInfo;
}

export interface FetchTimingInfo {
  timeOrigin: number;
  requestTime: number;
  redirectStart: number;
  redirectEnd: number;
  fetchStart: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  tlsStart: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
}

export interface NetworkResponseData {
  url: string;
  protocol: string;
  status: number;
  statusText: string;
  fromCache: boolean;
  headers: NetworkHeader[];
  mimeType: string;
  bytesReceived: number;
  headersSize: number;
  bodySize: number | null;
  content: { size: number };
}

export interface NetworkBaseEvent {
  context: BrowsingContext | null;
  isBlocked: boolean;
  navigation: Navigation | null;
  redirectCount: number;
  request: NetworkRequestData;
  timestamp: number;
  intercepts?: NetworkIntercept[];
}

export interface NetworkBeforeRequestSentEvent extends NetworkBaseEvent {
  initiator: NetworkInitiator;
}

export interface NetworkResponseEvent extends NetworkBaseEvent {
  response: NetworkResponseData;
}

export interface NetworkInitiator {
  type?: 'parser' | 'script' | 'preflight' | 'other';
  columnNumber?: number;
  lineNumber?: number;
  stackTrace?: StackTrace;
  request?: NetworkRequest;
}

export interface UrlPattern {
  type: 'string' | 'pattern';
  pattern?: string;
  protocol?: string;
  hostname?: string;
  port?: string;
  pathname?: string;
  search?: string;
}

// Log types
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  source: LogSource;
  text: string;
  timestamp: number;
  stackTrace?: StackTrace;
  type: 'console' | 'javascript';
  method?: string; // For console entries: log, warn, error, info, debug, etc.
  args?: RemoteValue[];
}

export interface LogSource {
  realm: ScriptRealm;
  context?: BrowsingContext;
}

// Storage types
export interface CookieFilter {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  expiry?: number;
}

export interface PartitionDescriptor {
  type: 'context' | 'storageKey';
  context?: BrowsingContext;
  userContext?: string;
  sourceOrigin?: string;
}

export interface SetCookieParams {
  cookie: PartialCookie;
  partition?: PartitionDescriptor;
}

export interface PartialCookie {
  name: string;
  value: BytesValue;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none' | 'default';
  expiry?: number;
}

export interface GetCookiesResult {
  cookies: NetworkCookie[];
  partitionKey: {
    userContext?: string;
    sourceOrigin?: string;
  };
}

// Browser User Context (for session isolation)
export type UserContext = string;

export interface UserContextInfo {
  userContext: UserContext;
}

// Event subscription
export interface SubscriptionRequest {
  events: string[];
  contexts?: BrowsingContext[];
}

// Serialized session state for Playwright-style persistence
export interface SessionState {
  cookies?: NetworkCookie[];
  localStorage?: Record<string, Record<string, string>>; // origin -> key/value
  sessionStorage?: Record<string, Record<string, string>>;
  origins?: string[];
}
