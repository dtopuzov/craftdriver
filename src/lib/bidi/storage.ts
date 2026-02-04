/**
 * Session State Manager
 * Playwright-style session persistence - save login state, cookies, localStorage
 */

import fs from 'fs/promises';
import type { BiDiConnection } from './connection.js';
import type { Driver } from '../driver.js';
import type {
  BrowsingContext,
  NetworkCookie,
  SessionState,
  PartialCookie,
  GetCookiesResult,
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
    await fs.writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
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
  async getCookies(filter?: { domain?: string; name?: string }): Promise<NetworkCookie[]> {
    if (this.connection?.isConnected()) {
      return this.getCookiesBiDi(filter);
    }
    return this.getCookiesClassic();
  }

  /**
   * Set cookies using BiDi or fallback to Classic
   */
  async setCookies(cookies: NetworkCookie[] | PartialCookie[]): Promise<void> {
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
      // Classic WebDriver - delete all cookies
      const cookies = await this.getCookiesClassic();
      for (const cookie of cookies) {
        if (filter?.domain && cookie.domain !== filter.domain) continue;
        if (filter?.name && cookie.name !== filter.name) continue;
        await this.driver.executeScript(
          `document.cookie = "${cookie.name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${cookie.domain}"`
        );
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

    const partialCookie: PartialCookie = {
      name: cookie.name,
      value: { type: 'string', value: cookie.value },
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
  }): Promise<NetworkCookie[]> {
    const params: Record<string, unknown> = {};
    if (filter) {
      params.filter = filter;
    }
    if (this.context) {
      params.partition = { type: 'context', context: this.context };
    }

    const result = await this.connection!.send<GetCookiesResult>('storage.getCookies', params);
    return result.cookies;
  }

  private async getCookiesClassic(): Promise<NetworkCookie[]> {
    const cookies = await this.driver.executeScript<
      Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        expiry?: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite?: string;
      }>
    >(`
      return document.cookie.split(';').map(c => {
        const [name, ...valueParts] = c.trim().split('=');
        return {
          name: name,
          value: valueParts.join('='),
          domain: location.hostname,
          path: '/',
          httpOnly: false,
          secure: location.protocol === 'https:',
          size: c.length,
          sameSite: 'lax'
        };
      }).filter(c => c.name);
    `);

    return (cookies || []).map((c) => ({
      name: c.name,
      value: { type: 'string' as const, value: c.value },
      domain: c.domain,
      path: c.path || '/',
      size: (c.name + c.value).length,
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite: (c.sameSite?.toLowerCase() as 'strict' | 'lax' | 'none' | 'default') || 'lax',
      expiry: c.expiry,
    }));
  }

  private async setCookiesBiDi(cookies: NetworkCookie[] | PartialCookie[]): Promise<void> {
    for (const cookie of cookies) {
      // Both NetworkCookie and PartialCookie now have value as BytesValue
      // Note: sameSite: 'none' requires secure: true, so adjust if needed
      let sameSite = cookie.sameSite;
      let secure = cookie.secure;
      if (sameSite === 'none' && !secure) {
        // Invalid combo - either set secure to true or change sameSite
        sameSite = 'lax'; // Default to lax for non-secure cookies
      }

      const partialCookie: PartialCookie = {
        name: cookie.name,
        value: cookie.value,
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

  private async setCookiesClassic(cookies: NetworkCookie[] | PartialCookie[]): Promise<void> {
    for (const cookie of cookies) {
      // Extract string value from BytesValue
      const value = cookie.value.value;

      let cookieStr = `${cookie.name}=${encodeURIComponent(value)}`;
      if (cookie.path) cookieStr += `; path=${cookie.path}`;
      if (cookie.domain) cookieStr += `; domain=${cookie.domain}`;
      if (cookie.secure) cookieStr += '; secure';
      if (cookie.sameSite) cookieStr += `; samesite=${cookie.sameSite}`;
      if (cookie.expiry) {
        const date = new Date(cookie.expiry * 1000);
        cookieStr += `; expires=${date.toUTCString()}`;
      }

      await this.driver.executeScript(`document.cookie = ${JSON.stringify(cookieStr)}`);
    }
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
