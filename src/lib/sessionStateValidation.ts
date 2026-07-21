/**
 * Parsing and validation for saved session state, shared by every restore entry
 * point. The whole state is validated *before* any browser mutation, so a
 * malformed or unsupported file fails loudly and leaves the browser untouched.
 *
 * Unknown or unsupported sections (including the legacy Playwright `origins`
 * field) are rejected rather than silently ignored — a saved snapshot must mean
 * exactly what it says.
 */
import fs from 'fs/promises';
import { CraftdriverError, ErrorCode } from './errors.js';
import type { CookieInput, SessionState } from './bidi/types.js';

const KNOWN_SECTIONS = new Set(['cookies', 'localStorage', 'sessionStorage']);
const COOKIE_FIELDS = new Set([
  'name', 'value', 'domain', 'path', 'httpOnly', 'secure', 'sameSite', 'expiry', 'size',
]);
const SAME_SITE_VALUES = new Set(['strict', 'lax', 'none', 'default']);

export interface StorageStateErrorContext {
  operation?: string;
  browserName?: string;
  protocol?: 'bidi' | 'classic' | string;
}

export function storageStateDetail(
  context: StorageStateErrorContext | undefined,
  phase: string,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    feature: 'storageState',
    operation: context?.operation ?? 'restore',
    browserName: context?.browserName ?? 'unknown',
    protocol: context?.protocol ?? 'unknown',
    phase,
    ...extra,
  };
}

/** True for an error already carrying this feature's structured contract. */
export function isStorageStateError(error: unknown): error is CraftdriverError {
  return CraftdriverError.is(error) && error.detail?.feature === 'storageState';
}

function invalid(
  message: string,
  context?: StorageStateErrorContext,
  extra?: Record<string, unknown>
): never {
  throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, message, {
    detail: storageStateDetail(context, 'validation', extra),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A canonical http(s) origin: `scheme://host[:port]`, no path or trailing slash. */
export function isHttpOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === origin;
  } catch {
    return false;
  }
}

function validateOriginMap(
  section: 'localStorage' | 'sessionStorage',
  map: unknown,
  context?: StorageStateErrorContext
): void {
  if (map === undefined) return;
  if (!isPlainObject(map)) {
    invalid(`state.${section} must be an object keyed by origin`, context, { section });
  }
  for (const [origin, entries] of Object.entries(map as Record<string, unknown>)) {
    if (!isHttpOrigin(origin)) {
      invalid(`state.${section} contains a non-canonical HTTP(S) origin`, context, {
        section,
        origin,
      });
    }
    if (!isPlainObject(entries)) {
      invalid(`state.${section} entries must be maps of string keys to string values`, context, {
        section,
        origin,
      });
    }
    for (const value of Object.values(entries as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        invalid(`state.${section} values must be strings`, context, { section, origin });
      }
    }
  }
}

function validateCookies(cookies: unknown, context?: StorageStateErrorContext): void {
  if (cookies === undefined) return;
  if (!Array.isArray(cookies)) invalid('state.cookies must be an array', context, { section: 'cookies' });
  for (const entry of cookies as unknown[]) {
    if (!isPlainObject(entry)) {
      invalid('state.cookies entries must be plain objects', context, { section: 'cookies' });
    }
    const cookie = entry as Record<string, unknown>;
    // BiDi implementations may attach namespaced, capture-only metadata
    // (`goog:priority`, etc.). Preserve compatibility with files CraftDriver
    // previously emitted; normalization drops these fields before mutation.
    const unknown = Object.keys(cookie).find(
      (key) => !COOKIE_FIELDS.has(key) && !key.includes(':')
    );
    if (unknown) {
      invalid('state.cookies contains an unsupported cookie field', context, {
        section: 'cookies',
        field: unknown,
      });
    }
    if (typeof cookie.name !== 'string' || cookie.name.length === 0) {
      invalid('each cookie needs a non-empty string name', context, { section: 'cookies' });
    }
    if (/[^\u0021-\u007E]|[()<>@,;:\\"/\[\]?={}]/.test(cookie.name as string)) {
      invalid('cookie name contains characters WebDriver cannot set', context, { section: 'cookies' });
    }
    if (typeof cookie.value !== 'string') {
      invalid('each cookie value must be a string', context, { section: 'cookies' });
    }
    if (typeof cookie.domain !== 'string' || cookie.domain.trim().length === 0) {
      invalid('each cookie needs a non-empty string domain', context, { section: 'cookies' });
    }
    if (
      typeof cookie.domain === 'string' &&
      (/\s/.test(cookie.domain) || cookie.domain.includes('/') || cookie.domain.endsWith('.'))
    ) {
      invalid('cookie domain is not a valid host or domain suffix', context, { section: 'cookies' });
    }
    if (
      cookie.path !== undefined &&
      (typeof cookie.path !== 'string' || !cookie.path.startsWith('/'))
    ) {
      invalid('cookie path must be a string beginning with "/"', context, { section: 'cookies' });
    }
    for (const field of ['httpOnly', 'secure'] as const) {
      if (cookie[field] !== undefined && typeof cookie[field] !== 'boolean') {
        invalid(`cookie ${field} must be a boolean`, context, { section: 'cookies', field });
      }
    }
    if (
      cookie.sameSite !== undefined &&
      (typeof cookie.sameSite !== 'string' || !SAME_SITE_VALUES.has(cookie.sameSite))
    ) {
      invalid('cookie sameSite must be strict, lax, none, or default', context, {
        section: 'cookies',
      });
    }
    if (
      cookie.expiry !== undefined &&
      (typeof cookie.expiry !== 'number' || !Number.isFinite(cookie.expiry))
    ) {
      invalid('cookie expiry must be a finite number', context, { section: 'cookies' });
    }
    if (
      cookie.size !== undefined &&
      (typeof cookie.size !== 'number' || !Number.isInteger(cookie.size) || cookie.size < 0)
    ) {
      invalid('cookie size must be a non-negative integer', context, { section: 'cookies' });
    }
  }
}

/**
 * Parse `source` (a path or an in-memory object) into a validated
 * {@link SessionState}. Malformed shapes throw `INVALID_ARGUMENT`; unknown or
 * legacy sections throw `UNSUPPORTED`.
 */
export async function parseSessionState(
  source: SessionState | string,
  context?: StorageStateErrorContext
): Promise<SessionState> {
  let raw: unknown;
  if (typeof source === 'string') {
    let text: string;
    try {
      text = await fs.readFile(source, 'utf-8');
    } catch (err) {
      invalid(`could not read state file ${source}: ${(err as Error).message}`, context);
    }
    try {
      raw = JSON.parse(text);
    } catch {
      invalid(`state file ${source} is not valid JSON`, context);
    }
  } else {
    raw = source;
  }

  if (!isPlainObject(raw)) {
    invalid('session state must be a plain JSON object', context);
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_SECTIONS.has(key)) {
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        `unsupported state section ${JSON.stringify(key)} — craftdriver restores ` +
          `cookies, localStorage, and sessionStorage only`,
        { detail: storageStateDetail(context, 'validation', { section: key }) }
      );
    }
  }

  validateCookies(obj.cookies, context);
  validateOriginMap('localStorage', obj.localStorage, context);
  validateOriginMap('sessionStorage', obj.sessionStorage, context);

  return obj as SessionState;
}

/** Origins in `map` that actually carry at least one entry. */
export function nonEmptyOrigins(map?: Record<string, Record<string, string>>): string[] {
  if (!map) return [];
  return Object.keys(map).filter((origin) => map[origin] && Object.keys(map[origin]).length > 0);
}

/** True when the state carries at least one origin with ≥1 sessionStorage entry. */
export function hasNonEmptySessionStorage(state: SessionState): boolean {
  return nonEmptyOrigins(state.sessionStorage).length > 0;
}

/** True when a valid state has no cookie or storage mutations to apply. */
export function isSessionStateEmpty(state: SessionState): boolean {
  return (
    (state.cookies?.length ?? 0) === 0 &&
    nonEmptyOrigins(state.localStorage).length === 0 &&
    nonEmptyOrigins(state.sessionStorage).length === 0
  );
}

/**
 * Convert a captured cookie into the one canonical restore shape used by every
 * protocol path. Browser read APIs may report `sameSite: 'default'`, and some
 * engines report insecure `sameSite: 'none'`; neither can be replayed literally
 * through all WebDriver cookie commands, so omit sameSite and let the engine
 * apply its default consistently. `size` is capture-only and is never written.
 */
export function normalizeCookieForRestore(cookie: CookieInput & { size?: number }): CookieInput {
  const normalized: CookieInput = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
  };
  if (cookie.path !== undefined) normalized.path = cookie.path;
  if (cookie.httpOnly !== undefined) normalized.httpOnly = cookie.httpOnly;
  if (cookie.secure !== undefined) normalized.secure = cookie.secure;
  if (cookie.expiry !== undefined) normalized.expiry = cookie.expiry;
  if (
    cookie.sameSite !== undefined &&
    cookie.sameSite !== 'default' &&
    !(cookie.sameSite === 'none' && !cookie.secure)
  ) {
    normalized.sameSite = cookie.sameSite;
  }
  return normalized;
}
