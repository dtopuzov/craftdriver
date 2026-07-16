import { randomUUID } from 'crypto';
import type { Capabilities, WebDriverEndpoint } from './types.js';
import { applyBidiDefaults } from './capabilities.js';
import { CraftdriverError, ErrorCode } from './errors.js';

export interface RemoteAuth {
  username: string;
  password: string;
}

/**
 * Options for connecting to any W3C-compatible remote WebDriver endpoint —
 * a self-hosted Selenium Grid, BrowserStack, or another cloud provider.
 * Provider-specific detail (BrowserStack's `bstack:options`, etc.) is
 * forwarded through `capabilities` without schema conversion.
 */
export interface RemoteWebDriverOptions {
  /** The remote endpoint's WebDriver base URL, e.g. `https://hub.browserstack.com/wd/hub`. */
  url: string;
  /**
   * Basic auth credentials. Mutually exclusive with URL-embedded user-info
   * (`https://user:pass@host/...`) — set one, not both.
   */
  auth?: RemoteAuth;
  /** W3C capabilities merged under `alwaysMatch`; vendor namespaces are not schema-checked. */
  capabilities?: Record<string, unknown>;
  /** Timeout for the initial `POST /session` call. Defaults to craftdriver's local session-create timeout. */
  sessionTimeoutMs?: number;
  /** Default timeout applied to every WebDriver command after the session is created, unless overridden per call. */
  commandTimeoutMs?: number;
}

function invalidArgument(message: string, detail?: Record<string, unknown>): CraftdriverError {
  return new CraftdriverError(ErrorCode.INVALID_ARGUMENT, message, detail ? { detail } : undefined);
}

function positiveNumber(value: unknown, optionName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalidArgument(`remote.${optionName} must be a positive number of milliseconds.`);
  }
  return value;
}

export interface ParsedRemoteEndpoint {
  endpoint: WebDriverEndpoint;
  /** Timeout for the one `POST /session` call only — not stored on the endpoint, which is per-command. */
  sessionTimeoutMs?: number;
}

/** Parse and runtime-validate remote launch options without exposing credentials. */
export function parseRemoteEndpoint(options: RemoteWebDriverOptions): ParsedRemoteEndpoint {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidArgument('remote must be an object containing a url.');
  }
  if (typeof options.url !== 'string' || options.url.trim() === '') {
    throw invalidArgument('remote.url must be a non-empty string.');
  }

  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    // The invalid URL may contain credentials, so do not echo it.
    throw invalidArgument(
      'remote.url is not a valid URL (check the scheme, host, and any embedded credentials).'
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidArgument(
      `remote.url must use http or https (got "${parsed.protocol.replace(/:$/, '')}").`
    );
  }
  if (parsed.search) {
    throw invalidArgument('remote.url must not include a query string.');
  }
  if (parsed.hash) {
    throw invalidArgument('remote.url must not include a fragment.');
  }

  // Extract URL credentials so downstream URLs remain safe to log.
  const userInfoPresent = parsed.username !== '' || parsed.password !== '';
  if (userInfoPresent && options.auth) {
    throw invalidArgument(
      'remote.url embeds credentials and remote.auth is also set — provide credentials one way, not both.'
    );
  }

  let auth: RemoteAuth | undefined;
  if (userInfoPresent) {
    auth = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  } else if (options.auth !== undefined) {
    if (typeof options.auth !== 'object' || options.auth === null || Array.isArray(options.auth)) {
      throw invalidArgument('remote.auth must be an object with username and password.');
    }
    const candidate = options.auth as unknown as Record<string, unknown>;
    if (typeof candidate.username !== 'string' || typeof candidate.password !== 'string') {
      throw invalidArgument('remote.auth.username and remote.auth.password must be strings.');
    }
    auth = { username: candidate.username, password: candidate.password };
  }

  if (auth && (auth.username === '' || auth.password === '')) {
    throw invalidArgument('remote.auth requires a non-empty username and password.');
  }

  if (
    options.capabilities !== undefined &&
    (typeof options.capabilities !== 'object' ||
      options.capabilities === null ||
      Array.isArray(options.capabilities))
  ) {
    throw invalidArgument('remote.capabilities must be an object.');
  }

  const sessionTimeoutMs = positiveNumber(options.sessionTimeoutMs, 'sessionTimeoutMs');
  const commandTimeoutMs = positiveNumber(options.commandTimeoutMs, 'commandTimeoutMs');

  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  const rawPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');

  return {
    endpoint: {
      protocol: parsed.protocol === 'https:' ? 'https' : 'http',
      hostname: parsed.hostname,
      port,
      path: rawPath,
      auth,
      // Unique per session so quitting one never tears down another's
      // keep-alive sockets — concurrent sessions often share one hub host:port.
      poolKey: randomUUID(),
      commandTimeoutMs,
    },
    sessionTimeoutMs,
  };
}

/**
 * Build W3C capabilities for a remote session. Mirrors
 * `buildLaunchCapabilities()`'s shape but never injects anything local-only
 * (download prefs, `--headless`, binary paths) — remote users pass those
 * through `remote.capabilities` themselves (e.g.
 * `capabilities['goog:chromeOptions']`).
 */
export function buildRemoteCapabilities(input: {
  browserName: string;
  bidiRequested: boolean;
  userCapabilities?: Record<string, unknown>;
}): Capabilities {
  const caps: Capabilities = { ...(input.userCapabilities ?? {}) };
  if (caps.browserName === undefined) {
    caps.browserName = input.browserName;
  }
  // Strict remote hubs require the Classic string prompt behavior.
  applyBidiDefaults(caps, input.bidiRequested, 'string');
  return caps;
}

/**
 * Strip query string, fragment, and embedded user-info from a URL before
 * it goes into a log line. Some remote providers proxy the BiDi
 * `webSocketUrl` through tokens embedded in the query string or user-info —
 * this must never end up in the Classic-fallback warning. Falls back to a
 * fixed placeholder if the string isn't a parseable URL at all (safer than
 * logging it verbatim).
 */
export function redactUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '<unparseable-url-redacted>';
  }
}
