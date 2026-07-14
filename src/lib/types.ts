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
  /** Abort the request and reject if no response arrives within this many ms. Unbounded when omitted. */
  timeoutMs?: number;
}

export interface WebDriverEndpoint {
  protocol: 'http' | 'https';
  hostname: string;
  port: number;
  path?: string;
}

/**
 * A cookie as serialized by the W3C WebDriver **Classic** cookie endpoints
 * (`GET /session/{id}/cookie` and `/cookie/{name}`).
 *
 * This is intentionally kept in the transport-layer `types.ts` (not
 * `bidi/types.ts`) so `Driver` stays BiDi-agnostic — `bidi/` depends on
 * `driver.ts`, never the reverse. It mirrors the WebDriver spec's "cookie"
 * JSON object. Unlike BiDi's `RawNetworkCookie`, the Classic wire object
 * carries no `size` field; callers that need one compute it.
 *
 * `sameSite` is typed loosely on read because driver casing varies in practice
 * (Chromedriver/geckodriver return capitalized `Lax`/`Strict`/`None`).
 */
export interface ClassicCookie {
  name: string;
  value: string;
  path: string;
  domain: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since the Unix epoch (W3C uses seconds, not milliseconds). */
  expiry?: number;
  sameSite?: string;
}

/**
 * The cookie object accepted by `POST /session/{id}/cookie` (`addCookie`).
 * Only `name` and `value` are required; the driver fills `domain`/`path` from
 * the current document when omitted. `sameSite` must be the spec's capitalized
 * form (`None` | `Lax` | `Strict`).
 */
export interface ClassicCookieInput {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  /** Seconds since the Unix epoch. */
  expiry?: number;
  sameSite?: 'None' | 'Lax' | 'Strict';
}
