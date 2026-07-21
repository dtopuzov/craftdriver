/**
 * Session State Manager
 * Playwright-style session persistence - save login state, cookies, localStorage
 */

import fs from 'fs/promises';
import type { BiDiConnection } from './connection.js';
import type { Driver } from '../driver.js';
import { CraftdriverError, ErrorCode } from '../errors.js';
import { writeSecureFile } from '../secureFile.js';
import type { ClassicCookie, ClassicCookieInput } from '../types.js';
import type {
  BrowsingContext,
  Cookie,
  CookieInput,
  SessionState,
  RawPartialCookie,
  RawNetworkCookie,
  GetCookiesResult,
  BytesValue,
} from './types.js';

export interface StorageStateOptions {
  /** Include cookies in saved state (default: true) */
  includeCookies?: boolean;
  /** Include localStorage in saved state (default: true) */
  includeLocalStorage?: boolean;
  /** Include sessionStorage in saved state (default: false) */
  includeSessionStorage?: boolean;
  /** Specific origins to capture (default: all) */
  origins?: string[];
}

export class SessionStateManager {
  private connection: BiDiConnection | null;
  private driver: Driver;
  private context?: BrowsingContext;

  constructor(driver: Driver, connection: BiDiConnection | null, context?: BrowsingContext) {
    this.driver = driver;
    this.connection = connection;
    this.context = context;
  }

  /**
   * Save current session state to a file (Playwright-style)
   * Captures cookies and optionally localStorage/sessionStorage
   */
  async saveState(path: string, options: StorageStateOptions = {}): Promise<SessionState> {
    const state = await this.getState(options);
    await writeSecureFile(path, JSON.stringify(state, null, 2));
    return state;
  }

  /**
   * Load session state from a file
   */
  async loadState(path: string): Promise<void> {
    const data = await fs.readFile(path, 'utf-8');
    const state = JSON.parse(data) as SessionState;
    await this.setState(state);
  }

  /**
   * Get current session state
   */
  async getState(options: StorageStateOptions = {}): Promise<SessionState> {
    const state: SessionState = {};

    // Get cookies if requested (default: true)
    if (options.includeCookies !== false) {
      state.cookies = await this.getCookies();
    }

    // Get localStorage if requested (default: true)
    if (options.includeLocalStorage !== false) {
      try {
        state.localStorage = await this.getLocalStorage(options.origins);
      } catch {
        // localStorage might not be available
      }
    }

    // Get sessionStorage if requested (default: false)
    if (options.includeSessionStorage) {
      try {
        state.sessionStorage = await this.getSessionStorage(options.origins);
      } catch {
        // sessionStorage might not be available
      }
    }

    return state;
  }

  /**
   * Set session state (cookies + storage)
   */
  async setState(state: SessionState): Promise<void> {
    // Set cookies
    if (state.cookies?.length) {
      await this.setCookies(state.cookies);
    }

    // Set localStorage
    if (state.localStorage) {
      await this.setLocalStorage(state.localStorage);
    }

    // Set sessionStorage
    if (state.sessionStorage) {
      await this.setSessionStorage(state.sessionStorage);
    }
  }

  /**
   * Get all cookies using BiDi or fallback to Classic
   */
  async getCookies(filter?: { domain?: string; name?: string }): Promise<Cookie[]> {
    if (this.connection?.isConnected()) {
      return this.getCookiesBiDi(filter);
    }
    return this.getCookiesClassic();
  }

  /**
   * Set cookies using BiDi or fallback to Classic
   */
  async setCookies(cookies: Cookie[] | CookieInput[]): Promise<void> {
    if (this.connection?.isConnected()) {
      await this.setCookiesBiDi(cookies);
    } else {
      await this.setCookiesClassic(cookies);
    }
  }

  /**
   * Clear all cookies
   */
  async clearCookies(filter?: { domain?: string; name?: string }): Promise<void> {
    if (this.connection?.isConnected()) {
      await this.connection.send('storage.deleteCookies', {
        filter: filter || {},
        ...(this.context ? { partition: { type: 'context', context: this.context } } : {}),
      });
    } else {
      // Classic WebDriver — delete cookies via the native cookie store, which
      // (unlike `document.cookie = "...expires=..."`) can also remove HttpOnly
      // cookies. No filter → clear everything in one call.
      if (!filter?.domain && !filter?.name) {
        await this.driver.deleteAllCookies();
        return;
      }
      const cookies = await this.getCookiesClassic();
      for (const cookie of cookies) {
        if (filter?.domain && cookie.domain !== filter.domain) continue;
        if (filter?.name && cookie.name !== filter.name) continue;
        await this.driver.deleteCookie(cookie.name);
      }
    }
  }

  /**
   * Add a single cookie
   */
  async addCookie(cookie: {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    expiry?: number | Date;
  }): Promise<void> {
    const expiry =
      cookie.expiry instanceof Date
        ? Math.floor(cookie.expiry.getTime() / 1000)
        : cookie.expiry;

    const partialCookie: CookieInput = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || (await this.getCurrentDomain()),
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite?.toLowerCase() as 'strict' | 'lax' | 'none',
      expiry,
    };

    await this.setCookies([partialCookie]);
  }

  // === Private Methods ===

  private async getCookiesBiDi(filter?: {
    domain?: string;
    name?: string;
  }): Promise<Cookie[]> {
    const params: Record<string, unknown> = {};
    if (filter) {
      params.filter = filter;
    }
    if (this.context) {
      params.partition = { type: 'context', context: this.context };
    }

    const result = await this.connection!.send<GetCookiesResult>('storage.getCookies', params);
    return result.cookies.map((cookie) => this.normalizeCookie(cookie));
  }

  private async getCookiesClassic(): Promise<Cookie[]> {
    // Read from the browser's native cookie store via the W3C Classic cookie
    // endpoint (not `document.cookie`), so HttpOnly cookies are included and
    // secure/sameSite/path/expiry reflect the real stored values.
    const cookies = await this.driver.getCookies();
    return (cookies || []).map((c) => this.classicCookieToCookie(c));
  }

  /**
   * Map a W3C Classic cookie object onto the `Cookie` shape this module's
   * callers expect. The Classic endpoint carries no `size`, so we compute it
   * the same way the old JS-based path did — `(name + value).length` — to keep
   * the return shape backward compatible.
   */
  private classicCookieToCookie(c: ClassicCookie): Cookie {
    const raw = (c.sameSite || '').toLowerCase();
    const sameSite: Cookie['sameSite'] =
      raw === 'strict' || raw === 'lax' || raw === 'none'
        ? raw
        : c.sameSite
          ? 'default'
          : 'lax';
    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      size: (c.name + c.value).length,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite,
      expiry: c.expiry,
    };
  }

  private async setCookiesBiDi(cookies: Cookie[] | CookieInput[]): Promise<void> {
    for (const cookie of cookies) {
      // Note: sameSite: 'none' requires secure: true, so adjust if needed
      let sameSite = cookie.sameSite;
      let secure = cookie.secure;
      if (sameSite === 'none' && !secure) {
        // Invalid combo - either set secure to true or change sameSite
        sameSite = 'lax'; // Default to lax for non-secure cookies
      }

      const partialCookie: RawPartialCookie = {
        name: cookie.name,
        value: { type: 'string', value: this.normalizeCookieValue(cookie.value) },
        domain: cookie.domain,
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        secure: secure,
        sameSite: sameSite,
        expiry: cookie.expiry,
      };

      try {
        await this.connection!.send('storage.setCookie', {
          cookie: partialCookie,
          ...(this.context ? { partition: { type: 'context', context: this.context } } : {}),
        });
      } catch (error) {
        // Propagate errors - cookie might be rejected for security reasons
        throw error;
      }
    }
  }

  private async setCookiesClassic(cookies: Cookie[] | CookieInput[]): Promise<void> {
    for (const cookie of cookies) {
      const input: ClassicCookieInput = {
        name: cookie.name,
        value: this.normalizeCookieValue(cookie.value),
      };
      if (cookie.domain) input.domain = cookie.domain;
      if (cookie.path) input.path = cookie.path;
      if (cookie.secure !== undefined) input.secure = cookie.secure;
      if (cookie.httpOnly !== undefined) input.httpOnly = cookie.httpOnly;
      if (cookie.expiry !== undefined) input.expiry = cookie.expiry;
      const sameSite = this.toClassicSameSite(cookie.sameSite);
      if (sameSite) input.sameSite = sameSite;

      // Native `POST /cookie` — sets HttpOnly and the real sameSite/secure
      // flags, which a `document.cookie = "..."` assignment cannot do.
      try {
        await this.driver.addCookie(input);
      } catch (err) {
        // The W3C cookie endpoint rejects a cookie whose domain doesn't match
        // the current document with `invalid cookie domain`. The previous
        // `document.cookie = "..."` path silently ignored such cookies (the
        // browser refuses cross-origin document.cookie writes without error),
        // so preserve that best-effort behavior for state restore — skip the
        // unsettable cookie rather than aborting the whole restore. Any other
        // addCookie failure still propagates.
        if (
          CraftdriverError.is(err, ErrorCode.DRIVER_ERROR) &&
          err.detail?.webDriverError === 'invalid cookie domain'
        ) {
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Convert this module's lowercase sameSite (`strict`/`lax`/`none`/`default`)
   * to the W3C Classic capitalized form. `default`/undefined is dropped so the
   * driver applies the browser's own default.
   */
  private toClassicSameSite(
    sameSite?: 'strict' | 'lax' | 'none' | 'default'
  ): 'Strict' | 'Lax' | 'None' | undefined {
    switch (sameSite) {
      case 'strict':
        return 'Strict';
      case 'lax':
        return 'Lax';
      case 'none':
        return 'None';
      default:
        return undefined;
    }
  }

  private normalizeCookie(cookie: RawNetworkCookie): Cookie {
    return {
      ...cookie,
      value: this.normalizeCookieValue(cookie.value),
    };
  }

  private normalizeCookieValue(value: string | BytesValue): string {
    return typeof value === 'string' ? value : value.value;
  }

  private async getLocalStorage(origins?: string[]): Promise<Record<string, Record<string, string>>> {
    const result: Record<string, Record<string, string>> = {};

    const currentOrigin = await this.driver.executeScript<string>('return location.origin');

    if (!origins || origins.includes(currentOrigin)) {
      const storage = await this.driver.executeScript<Record<string, string>>(`
        const result = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          result[key] = localStorage.getItem(key);
        }
        return result;
      `);

      if (storage && Object.keys(storage).length > 0) {
        result[currentOrigin] = storage;
      }
    }

    return result;
  }

  private async getSessionStorage(origins?: string[]): Promise<Record<string, Record<string, string>>> {
    const result: Record<string, Record<string, string>> = {};

    const currentOrigin = await this.driver.executeScript<string>('return location.origin');

    if (!origins || origins.includes(currentOrigin)) {
      const storage = await this.driver.executeScript<Record<string, string>>(`
        const result = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          result[key] = sessionStorage.getItem(key);
        }
        return result;
      `);

      if (storage && Object.keys(storage).length > 0) {
        result[currentOrigin] = storage;
      }
    }

    return result;
  }

  private async setLocalStorage(storage: Record<string, Record<string, string>>): Promise<void> {
    const currentOrigin = await this.driver.executeScript<string>('return location.origin');

    for (const [origin, data] of Object.entries(storage)) {
      if (origin === currentOrigin) {
        for (const [key, value] of Object.entries(data)) {
          await this.driver.executeScript(
            `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`
          );
        }
      }
      // For other origins, we'd need to navigate there first - complex case
    }
  }

  private async setSessionStorage(storage: Record<string, Record<string, string>>): Promise<void> {
    const currentOrigin = await this.driver.executeScript<string>('return location.origin');

    for (const [origin, data] of Object.entries(storage)) {
      if (origin === currentOrigin) {
        for (const [key, value] of Object.entries(data)) {
          await this.driver.executeScript(
            `sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`
          );
        }
      }
    }
  }

  private async getCurrentDomain(): Promise<string> {
    return this.driver.executeScript<string>('return location.hostname');
  }
}
