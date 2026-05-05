/**
 * BrowserContext — a WebDriver BiDi user context (an isolated browser
 * profile, equivalent to "open a new incognito window").
 *
 * Each `BrowserContext` owns its own cookies, localStorage, and
 * IndexedDB, isolated from every other context including the default
 * one. Use it to run multi-user scenarios (log in as Alice in one
 * context, as Bob in another) without cookie cross-talk.
 *
 * **BiDi-only.** Maps directly onto BiDi `browser.createUserContext`
 * (§7.2.4.2) and friends. Classic WebDriver has no equivalent and
 * `browser.newContext()` throws there.
 *
 * Obtain via:
 *   - `browser.newContext()` — create a fresh isolated profile.
 *   - `browser.contexts()`  — list all open user contexts.
 *   - `browser.defaultContext` — the implicit context the browser
 *     started in (id = `'default'`).
 */

import type { Driver } from './driver.js';
import type { BiDiConnection } from './bidi/connection.js';
import { Page } from './page.js';
import type { BrowsingContextInfo } from './bidi/types.js';

export class BrowserContext {
  private driver: Driver;
  private conn: BiDiConnection;
  private getDefaultTimeout: () => number;
  private getNavigationTimeout: () => number;
  private _id: string;
  private _closed = false;

  constructor(
    driver: Driver,
    conn: BiDiConnection,
    userContextId: string,
    getDefaultTimeout: () => number,
    getNavigationTimeout: () => number
  ) {
    this.driver = driver;
    this.conn = conn;
    this._id = userContextId;
    this.getDefaultTimeout = getDefaultTimeout;
    this.getNavigationTimeout = getNavigationTimeout;
  }

  /** The BiDi user-context id. The implicit default context has id `'default'`. */
  get id(): string {
    return this._id;
  }

  /** True after `close()` has removed the context. */
  get isClosed(): boolean {
    return this._closed;
  }

  private assertOpen(): void {
    if (this._closed) {
      throw new Error(
        `BrowserContext "${this._id}" is closed; create a new one with browser.newContext().`
      );
    }
  }

  /**
   * Open a new top-level browsing context (a tab or a window) inside this
   * user context. Maps to BiDi `browsingContext.create` with the
   * `userContext` parameter bound to this id.
   */
  async newPage(opts?: { url?: string; type?: 'tab' | 'window' }): Promise<Page> {
    this.assertOpen();
    const created = await this.conn.send<{ context: string }>('browsingContext.create', {
      type: opts?.type ?? 'tab',
      userContext: this._id,
    });
    const page = new Page(this.driver, created.context, this.getDefaultTimeout, this.conn);
    if (opts?.url) {
      await page.navigateTo(opts.url);
    }
    return page;
  }

  /**
   * Return all open top-level pages that belong to this user context.
   */
  async pages(): Promise<Page[]> {
    this.assertOpen();
    const tree = await this.conn.send<{ contexts: BrowsingContextInfo[] }>(
      'browsingContext.getTree',
      {}
    );
    return (tree.contexts ?? [])
      .filter((c) => c.userContext === this._id && !c.parent)
      .map((c) => new Page(this.driver, c.context, this.getDefaultTimeout, this.conn));
  }

  /**
   * Run `action` and resolve to the next new top-level page that opens
   * **inside this user context**. Useful when a click in one of this
   * context's pages spawns a popup.
   */
  async waitForPage(
    action: () => Promise<void>,
    opts?: { timeout?: number }
  ): Promise<Page> {
    this.assertOpen();
    const timeout = opts?.timeout ?? this.getNavigationTimeout();

    await this.conn.subscribe(['browsingContext.contextCreated']).catch(() => { /* already subscribed */ });

    return new Promise<Page>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`waitForPage() timed out after ${timeout}ms`));
      }, timeout);

      const off = this.conn.on('browsingContext.contextCreated', (params: Record<string, unknown>) => {
        if (params.parent) return; // nested frames
        if (params.userContext !== this._id) return;
        clearTimeout(timer);
        off();
        resolve(new Page(
          this.driver,
          params.context as string,
          this.getDefaultTimeout,
          this.conn
        ));
      });

      action().catch((err) => {
        clearTimeout(timer);
        off();
        reject(err);
      });
    });
  }

  /**
   * Remove this user context. All of its pages are closed and any
   * subsequent operation on this `BrowserContext` instance throws.
   *
   * The default context (`id === 'default'`) cannot be removed.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    if (this._id === 'default') {
      throw new Error(
        'Cannot close the default BrowserContext. ' +
        'Quit the browser instead with browser.quit().'
      );
    }
    await this.conn.send('browser.removeUserContext', { userContext: this._id });
    this._closed = true;
  }
}
