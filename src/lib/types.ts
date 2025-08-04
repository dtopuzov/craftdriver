export type Capabilities = Record<string, unknown> & {
  browserName?: string;
  'goog:chromeOptions'?: Record<string, unknown>;
};

export interface SessionResponse {
  sessionId: string;
  capabilities: Capabilities;
}

export interface CommandResponse<T = any> {
  value: T;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface WebDriverEndpoint {
  protocol: 'http' | 'https';
  hostname: string;
  port: number;
  path?: string;
}
