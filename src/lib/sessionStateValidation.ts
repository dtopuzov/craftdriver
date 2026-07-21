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
import type { SessionState } from './bidi/types.js';

const KNOWN_SECTIONS = new Set(['cookies', 'localStorage', 'sessionStorage']);

function invalid(message: string): never {
  throw new CraftdriverError(ErrorCode.INVALID_ARGUMENT, message);
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

function validateOriginMap(section: string, map: unknown): void {
  if (map === undefined) return;
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    invalid(`state.${section} must be an object keyed by origin`);
  }
  for (const [origin, entries] of Object.entries(map as Record<string, unknown>)) {
    if (!isHttpOrigin(origin)) {
      invalid(`state.${section} origin must be a canonical http(s) origin: got ${JSON.stringify(origin)}`);
    }
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
      invalid(`state.${section}[${origin}] must be a map of string keys to string values`);
    }
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        invalid(`state.${section}[${origin}].${key} must be a string`);
      }
    }
  }
}

function validateCookies(cookies: unknown): void {
  if (cookies === undefined) return;
  if (!Array.isArray(cookies)) invalid('state.cookies must be an array');
  for (const entry of cookies as unknown[]) {
    if (typeof entry !== 'object' || entry === null) invalid('state.cookies[] entries must be objects');
    const cookie = entry as Record<string, unknown>;
    if (typeof cookie.name !== 'string' || cookie.name.length === 0) {
      invalid('each cookie needs a non-empty string name');
    }
    if (typeof cookie.value !== 'string') {
      invalid(`cookie ${cookie.name} value must be a string`);
    }
    if (cookie.domain !== undefined && typeof cookie.domain !== 'string') {
      invalid(`cookie ${String(cookie.name)} domain must be a string`);
    }
    if (
      cookie.expiry !== undefined &&
      (typeof cookie.expiry !== 'number' || !Number.isFinite(cookie.expiry))
    ) {
      invalid(`cookie ${String(cookie.name)} expiry must be a finite number`);
    }
  }
}

/**
 * Parse `source` (a path or an in-memory object) into a validated
 * {@link SessionState}. Malformed shapes throw `INVALID_ARGUMENT`; unknown or
 * legacy sections throw `UNSUPPORTED`.
 */
export async function parseSessionState(source: SessionState | string): Promise<SessionState> {
  let raw: unknown;
  if (typeof source === 'string') {
    let text: string;
    try {
      text = await fs.readFile(source, 'utf-8');
    } catch (err) {
      invalid(`could not read state file ${source}: ${(err as Error).message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch {
      invalid(`state file ${source} is not valid JSON`);
    }
  } else {
    raw = source;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid('session state must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_SECTIONS.has(key)) {
      throw new CraftdriverError(
        ErrorCode.UNSUPPORTED,
        `unsupported state section ${JSON.stringify(key)} — craftdriver restores ` +
          `cookies, localStorage, and sessionStorage only`
      );
    }
  }

  validateCookies(obj.cookies);
  validateOriginMap('localStorage', obj.localStorage);
  validateOriginMap('sessionStorage', obj.sessionStorage);

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
