# BrowserContext — improvement plan

> Forward-looking design note. Lives in `research/` until shipped; promote
> sections to `docs/browser-context.md` as they land.

## TL;DR — get closer to Playwright

The shell of `BrowserContext` is already Playwright-shaped (isolated
profile, `newPage` / `pages` / `waitForPage` / `close`). The filling is
mostly empty. We close the gap in three user-visible milestones, each
independently shippable:

- **Milestone A — Auth fixtures.** `ctx.cookies/addCookies/clearCookies`,
  `ctx.storageState({ path? })`, and `newContext({ storageState })`. After
  this, the standard Playwright "log in once, reuse the JSON" pattern works.
- **Milestone B — Network & hooks.** `ctx.on('page'|'close')`,
  `ctx.addInitScript`, `ctx.route/unroute`, and the
  `extraHTTPHeaders`/`baseURL`/`httpCredentials` options that ride on top.
- **Milestone C — Identity & device.** `viewport`, `userAgent`, `locale`,
  `timezoneId`, `colorScheme`, `geolocation`, `permissions` on
  `newContext()`, plus `grantPermissions`/`clearPermissions`/`setGeolocation`.

Gap snapshot vs. Playwright (✅ = shipped, ❌ = todo):

| Playwright API | craftdriver | Milestone |
|---|---|---|
| `browser.newContext()` (isolated profile) | ✅ | — |
| `ctx.newPage()` / `pages()` / `close()` | ✅ | — |
| `ctx.waitForEvent('page')` / popup capture | ✅ (`waitForPage`) | — |
| `ctx.cookies` / `addCookies` / `clearCookies` | ❌ | A |
| `ctx.storageState()` / `newContext({ storageState })` | ❌ | A |
| `newContext({ baseURL })` | ❌ | B |
| `ctx.on('page' \| 'close')` | ❌ | B |
| `ctx.addInitScript` | ❌ | B |
| `ctx.route` / `unroute` | ❌ | B |
| `setExtraHTTPHeaders` / `httpCredentials` / `setOffline` | ❌ | B |
| `viewport` / `deviceScaleFactor` / `isMobile` / `hasTouch` | ❌ | C |
| `userAgent` / `locale` / `timezoneId` / `colorScheme` / `reducedMotion` | ❌ | C |
| `geolocation` / `permissions` / `grantPermissions` / `clearPermissions` | ❌ | C |
| Per-context tracing | ❌ | non-goal (separate plan) |

## End goals (user perspective)

A craftdriver `BrowserContext` should be the unit a test reaches for when it
needs **"a browser as some user"** — its own cookies, its own storage, its own
network rules, its own page-level hooks. The user should not have to reach
down into BiDi storage, juggle init scripts per page, or spin up a whole new
browser just to test a second identity.

Concretely, after this plan a user can:

1. **Create a context preconfigured for a user** — viewport, locale, timezone,
   user-agent, geolocation, permissions, extra HTTP headers, offline flag,
   colour scheme — all in one `newContext({...})` call.
2. **Save and restore auth** with `storageState()` / `storageState: ...` so
   logged-in fixtures survive across runs without re-running the login flow.
3. **Manage cookies on the context directly** — `addCookies`, `cookies`,
   `clearCookies` — without touching `bidi/storage`.
4. **Run init scripts at context scope** so every page (current and future,
   including popups) gets the same `window.__seed__` / clock stub / auth
   shim.
5. **Intercept network at context scope**, so "Alice always sends header X"
   or "Bob's `/api` is mocked" works regardless of which tab made the call.
6. **React to new pages as events** (`ctx.on('page', ...)` and
   `ctx.on('close', ...)`) instead of only the one-shot `waitForPage`.
7. Get a clear error on Classic WebDriver for any of the above.

The shape is borrowed from Playwright on purpose — that's where this model
already proved itself. The naming difference vs. Selenium's
`BrowsingContext` (which is really our `Page`) is documented, not papered
over.

---

## Public API — proposed shape

Only the additions/changes are shown. Existing methods (`newPage`, `pages`,
`waitForPage`, `close`, `id`, `isClosed`) keep their current signatures.

### 1. Creation-time options

```typescript
type ColorScheme = 'light' | 'dark' | 'no-preference';
type ReducedMotion = 'reduce' | 'no-preference';

interface NewContextOptions {
  // Identity / locale
  userAgent?: string;
  locale?: string;            // e.g. 'en-GB'
  timezoneId?: string;        // e.g. 'Europe/Berlin'
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  permissions?: string[];     // e.g. ['geolocation', 'clipboard-read']

  // Viewport / device
  viewport?: { width: number; height: number } | null;  // null = no override
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  colorScheme?: ColorScheme;
  reducedMotion?: ReducedMotion;

  // Network
  extraHTTPHeaders?: Record<string, string>;
  httpCredentials?: { username: string; password: string; origin?: string };
  offline?: boolean;
  ignoreHTTPSErrors?: boolean;

  // State
  storageState?: SessionState | string;  // object or path to JSON file

  // Hooks
  baseURL?: string;           // resolves relative URLs in page.goto / locator
}
```

```typescript
const ctx = await browser.newContext({
  locale: 'de-DE',
  timezoneId: 'Europe/Berlin',
  viewport: { width: 1280, height: 720 },
  extraHTTPHeaders: { 'X-Tenant': 'acme' },
  storageState: 'auth/alice.json',
});
```

**Problem solved:** today every test that needs a logged-in German user
re-implements three different setup steps. One options bag covers it.

### 2. Storage state round-trip

```typescript
class BrowserContext {
  storageState(opts?: StorageStateOptions): Promise<SessionState>;
  storageState(opts: StorageStateOptions & { path: string }): Promise<void>;
}
```

```typescript
// Setup once: log in, dump state.
const ctx = await browser.newContext();
const page = await ctx.newPage({ url: '/login' });
await loginAs(page, 'alice');
await ctx.storageState({ path: 'auth/alice.json' });
await ctx.close();

// Every test afterwards:
const ctx = await browser.newContext({ storageState: 'auth/alice.json' });
```

**Problem solved:** auth fixtures. Today `SessionStateManager` exists at
`Browser` scope, so two parallel contexts can't keep separate states cleanly.

### 3. Cookies at context scope

```typescript
class BrowserContext {
  cookies(urls?: string | string[]): Promise<Cookie[]>;
  addCookies(cookies: CookieInput[]): Promise<void>;
  clearCookies(filter?: { name?: string; domain?: string; path?: string }): Promise<void>;
}
```

```typescript
await ctx.addCookies([
  { name: 'session', value: 'abc', domain: 'example.com', path: '/' },
]);
const all = await ctx.cookies(['https://example.com']);
await ctx.clearCookies({ domain: 'example.com' });
```

**Problem solved:** removes the need to import `bidi/storage` for the 90%
case. Internally we delegate to it, scoped to this user context.

### 4. Init scripts at context scope

```typescript
class BrowserContext {
  addInitScript(script: string | (() => void) | { path: string }): Promise<{ id: string }>;
  removeInitScript(id: string): Promise<void>;
}
```

```typescript
await ctx.addInitScript(() => {
  // Runs in every page, before any page script, including popups.
  (window as any).__E2E__ = true;
  Date.now = () => 1700000000000;
});
```

**Problem solved:** today you have to call `page.addInitScript` per page and
remember to do it again for any popup. Context scope makes "every page in
this profile gets this hook" a one-liner.

### 5. Routing at context scope

```typescript
type RouteHandler = (route: Route, request: InterceptedRequest) => unknown | Promise<unknown>;

class BrowserContext {
  route(url: string | RegExp | ((url: string) => boolean), handler: RouteHandler): Promise<void>;
  unroute(url: string | RegExp | ((url: string) => boolean), handler?: RouteHandler): Promise<void>;
}
```

```typescript
await ctx.route(/\/api\/me$/, (route) =>
  route.fulfill({ status: 200, json: { id: 1, name: 'Alice' } }),
);
```

**Problem solved:** "Alice always sees this `/api/me`" should not be set up
per page. `Route` here is the same primitive `NetworkInterceptor` already
exposes; we wire it once at context scope.

### 6. Events

```typescript
class BrowserContext {
  on(event: 'page', listener: (page: Page) => void): this;
  on(event: 'close', listener: () => void): this;
  off(event: 'page' | 'close', listener: Function): this;
}
```

```typescript
ctx.on('page', (page) => {
  page.on('console', (msg) => log(`[${ctx.id}] ${msg.text}`));
});
```

`waitForPage` stays — it's the right ergonomics for the common popup case
and can be implemented on top of the event.

---

## Implementation plan — three milestones

Reordered to track the Playwright-parity milestones from the TL;DR. Each
numbered step is a self-contained PR with tests + docs + a CHANGELOG
`Unreleased` entry, per the repo checklist.

### Milestone A — Auth fixtures (highest payoff)

After A lands, the canonical Playwright pattern works verbatim:

```typescript
// one-time setup
const ctx = await browser.newContext();
const page = await ctx.newPage({ url: '/login' });
await loginAs(page, 'alice');
await ctx.storageState({ path: 'auth/alice.json' });
await ctx.close();

// every test afterwards
const ctx = await browser.newContext({ storageState: 'auth/alice.json' });
```

1. **`ctx.cookies()` / `addCookies()` / `clearCookies()`.**
   - Thin wrappers over `storage.getCookies` / `storage.setCookie` /
     `storage.deleteCookies` in [src/lib/bidi/storage.ts](src/lib/bidi/storage.ts),
     scoped with `partition: { type: 'context', userContext: this._id }`.
   - Test: two contexts; set cookie in one; assert the other doesn't see it.

2. **`ctx.storageState({ path? })`.**
   - Returns `{ cookies, origins }` in **Playwright's exact JSON shape** so
     dumped files are interchangeable across the two tools (nice-to-have,
     not a hard guarantee).
   - Implementation: collect cookies via #1; collect `localStorage` per
     origin by running a small script in each open page of this context.

3. **`newContext({ storageState })`.**
   - Accept either a `SessionState` object or a path to JSON.
   - Apply cookies and `localStorage` before returning the context (so the
     first `newPage` already sees them).
   - Test: dump from one context → load into a fresh context → land on a
     gated page in [examples/login.html](examples/login.html) without
     re-logging-in.

### Milestone B — Network & hooks

After B lands:

```typescript
const ctx = await browser.newContext({
  baseURL: 'https://staging.example.com',
  extraHTTPHeaders: { 'X-Tenant': 'acme' },
});
await ctx.addInitScript(() => { (window as any).__E2E__ = true; });
await ctx.route(/\/api\/me$/, route =>
  route.fulfill({ status: 200, json: { name: 'Alice' } })
);
ctx.on('page', p => p.on('console', m => console.log(m.text)));
```

4. **Events: `ctx.on('page', ...)` and `ctx.on('close', ...)`.**
   - Promote the one-shot listener already inside `waitForPage` to a real
     EventEmitter on `BrowserContext`.
   - Reimplement `waitForPage` on top of it so existing tests stay green.
   - `'close'` fires after `browser.removeUserContext` resolves.
   - **This is the foundation for steps 5–7** — they all need a "for every
     page now and in the future" hook.

5. **`ctx.addInitScript()` / `removeInitScript()`.**
   - BiDi `script.addPreloadScript` filtered to this user context's pages;
     re-applied to new pages on the `page` event from #4.
   - Verify the cleanest implementation path against
     [src/lib/bidi/connection.ts](src/lib/bidi/connection.ts) (one preload
     script with a refreshed `contexts` filter, vs. one per page).
   - Test: install script; open page A and page B (incl. a popup from
     [examples/popup.html](examples/popup.html)); assert both see the hook.

6. **`ctx.route()` / `ctx.unroute()`.**
   - Wrap `NetworkInterceptor` with a "is this request's tab inside this
     user context?" filter.
   - Handlers added before the first page must be honoured when that page
     opens (use the #4 event to apply).
   - Test: route registered before `newPage`; first page request matches.

7. **`baseURL`, `extraHTTPHeaders`, `httpCredentials`, `offline` options.**
   - Built on top of #5/#6:
     - `baseURL` — pure plumbing in `Page.goto` / `Locator` URL matchers.
     - `extraHTTPHeaders` — a built-in route that merges headers.
     - `httpCredentials` — handle 401 challenges via the same route.
     - `offline` — `network.setOffline` if exposed, else a blanket
       abort-all route.

### Milestone C — Identity & device

After C lands:

```typescript
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  userAgent: 'craftdriver-tests',
  locale: 'de-DE',
  timezoneId: 'Europe/Berlin',
  geolocation: { latitude: 52.52, longitude: 13.40 },
  permissions: ['geolocation'],
  colorScheme: 'dark',
});
```

8. **Viewport / `deviceScaleFactor` / `isMobile` / `hasTouch`.**
   - BiDi `browsingContext.setViewport` per page, applied via the #4 hook.
   - Reuse the existing mobile-emulation path in
     [src/lib/browser.ts](src/lib/browser.ts) — don't fork it.

9. **`userAgent`, `locale`, `timezoneId`, `colorScheme`, `reducedMotion`.**
   - BiDi `emulation.*` where supported; per-engine fallbacks otherwise.
   - Capability-detect; throw the standard "BiDi-only" / "Chrome-only"
     error rather than silently no-op'ing (design principle 5).

10. **`geolocation` + `permissions` (and the live setters
    `grantPermissions` / `clearPermissions` / `setGeolocation`).**
    - `permissions.setPermission` per origin; geolocation via
      `emulation.setGeolocationOverride` on Chrome, page-scoped fallback
      elsewhere.

### Cross-cutting polish (after each milestone)

- Update `docs/browser-context.md`: remove "current limitation" notes as
  they get fixed, add one runnable snippet per new method.
- Add the **naming clarification box** to the top of the doc the first
  time anything in this plan ships:

  | You'll see… | …in | What it actually is |
  |---|---|---|
  | `BrowserContext` | craftdriver, Playwright | BiDi *user context* (profile) |
  | `BrowsingContext` | Selenium, BiDi spec | A tab/window — our `Page` |
  | `browsingContext.*` | BiDi RPC | Tab/window operations |

- Grow `tests/browser-context-options.test.ts` as the options bag fills
  in, so the matrix is covered end-to-end against existing fixtures.

## Non-goals (for now)

- **Tracing per context.** Tracing today is `Browser`-scoped; promoting
  it is a separate plan.
- **Service workers / web workers as first-class objects on the context.**
  Worth a separate research note when there's a real user need.
- **Renaming the class** to match the BiDi spec term. The Playwright name
  is more useful to users; we document the difference instead.

## Risks / open questions

- BiDi support for `emulation.*` is uneven across Chrome/Firefox/WebKit at
  time of writing. Phase 3 may need per-engine fallbacks; gate features
  on capability detection and throw the standard "BiDi-only" / "Chrome-only"
  error rather than silently no-op'ing (per design principle 5).
- `storageState` format compatibility with Playwright's JSON would be a
  bonus (drop-in auth fixtures across tools) but is not a goal.
- Init-script "applies to future popups too" needs an integration test
  with [examples/popup.html](examples/popup.html) before we claim it works.
