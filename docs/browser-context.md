# Browser Contexts (isolated profiles)

A `BrowserContext` is a **WebDriver BiDi user context** — an isolated
browser profile, equivalent to opening a new incognito window. Each
context has its own cookies, localStorage, IndexedDB, and service
workers, fully isolated from every other context including the default
one.

Use `BrowserContext` to run multi-user scenarios (log in as Alice in
one context, as Bob in another) without cookie cross-talk, or to test
cold-start behaviour without nuking the rest of your session.

> **BiDi-only.** This API maps directly onto BiDi
> `browser.createUserContext` / `browser.getUserContexts` /
> `browser.removeUserContext`. WebDriver Classic has no equivalent and
> these methods throw a clear error when `enableBiDi: false`.

## The hierarchy

```
Browser           — the BiDi session (one launched browser process)
└── BrowserContext  — an isolated user context (this page)
    └── Page          — a top-level browsing context (tab or window)
        └── Frame       — a nested browsing context (iframe)
```

The `Browser` always exposes a `defaultContext` (id `'default'`). Pages
opened via `browser.openPage()` belong to it. Call `browser.newContext()`
to create additional isolated contexts.

## Quick reference

```typescript
import { Browser } from 'craftdriver';

const browser = await Browser.launch();

// The default context (always present, id === 'default').
const defaultCtx = browser.defaultContext;

// Create a fresh isolated context.
const ctx = await browser.newContext();

// List every open context (including 'default').
const all = await browser.contexts();

// Pages inside a context.
const page = await ctx.newPage({ url: 'https://example.com' });
const pages = await ctx.pages();

// Capture a popup spawned from this context.
const popup = await ctx.waitForPage(() => page.find('#open').click());

// Tear it down — all of its pages close, the profile is wiped.
await ctx.close();
```

> **Heads-up.** `browser.click()`, `browser.find()` and the other
> `Browser`-level shortcuts always target a page in **`defaultContext`**.
> They never reach a `Page` you got from `ctx.newPage()` on a
> non-default context. Always call methods on the `Page` you got back —
> e.g. `await aPage.fill('#user', 'alice')`, not `browser.fill(...)`.

## The auth-fixture pattern (skip the login UI in every test)

Most test suites log in dozens of times against the same app. Do it
**once**, snapshot the session to disk, and reuse it from every later
test. This is the canonical real-world use of `storageState`.

```typescript
// tests/setup/login.ts — runs once, before the suite.
import { Browser } from 'craftdriver';

const browser = await Browser.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage({ url: 'https://app.example.com/login' });
await page.find('#username').fill('alice');
await page.find('#password').fill('secret');
await page.find('#submit').click();
await page.expect('#welcome').toBeVisible();

// Cookies + localStorage for every origin the context has visited.
await ctx.saveStorageState('auth/alice.json');
await browser.quit();
```

```typescript
// every other test:
const ctx = await browser.newContext({ storageState: 'auth/alice.json' });
const page = await ctx.newPage({ url: 'https://app.example.com/dashboard' });
// Already logged in — no form, no waiting.
```

## Multi-user login in one browser

Two contexts — two logged-in sessions — no cookie cross-talk. Useful for
testing permission boundaries (admin vs. guest), real-time features
(chat, collaboration), or any flow that needs two users live at once.

```typescript
const alice = await browser.newContext();
const bob = await browser.newContext();

const aPage = await alice.newPage({ url: 'https://app.example.com/login' });
await loginAs(aPage, 'alice');

const bPage = await bob.newPage({ url: 'https://app.example.com/login' });
await loginAs(bPage, 'bob');
// bPage cannot see alice's session cookie, and vice versa.

await alice.close();
await bob.close();
```

## API

### `browser.newContext(opts?): Promise<BrowserContext>`

Create a new isolated user context. Backed by BiDi
`browser.createUserContext`. Throws in Classic mode.

- `opts.storageState`: a `SessionState` object **or** a path to a JSON
  file produced by `BrowserContext.saveStorageState()`. Cookies are
  applied immediately; localStorage entries land on first navigation to
  each captured origin via an internal preload script.
- `opts.baseURL`: a base URL applied to every relative `url` passed to
  `ctx.newPage()` or `page.navigateTo()` inside the context. Absolute
  URLs pass through unchanged. Lets your tests say `'/login'` instead
  of repeating `'https://staging.example.com/login'` everywhere.
- `opts.extraHTTPHeaders`: headers attached to **every** outgoing request
  from every page in this context. Useful for staging tokens, tenant
  ids, feature-flag overrides, or correlating test traffic in server
  logs. Replace later with `ctx.setExtraHTTPHeaders(…)`.

```typescript
const ctx = await browser.newContext({
  baseURL: 'https://staging.example.com',
  extraHTTPHeaders: { 'x-test-tenant': 'acme', 'x-staging-token': process.env.STAGING_TOKEN! },
  storageState: 'auth/alice.json',
});
const page = await ctx.newPage({ url: '/dashboard' }); // resolves against baseURL
```

### `browser.contexts(): Promise<BrowserContext[]>`

Return all open user contexts, including the default one. Backed by
BiDi `browser.getUserContexts`. Throws in Classic mode.

### `browser.defaultContext: BrowserContext`

The implicit context the browser started in (id `'default'`). Pages
opened via `browser.openPage()` / `browser.waitForPage()` live here.

### `BrowserContext.id: string`

The BiDi user-context id. The default context's id is the literal
string `'default'`.

### `BrowserContext.newPage(opts?): Promise<Page>`

Open a tab/window inside this context. `opts.url` navigates the new
page; `opts.type` is `'tab'` (default) or `'window'`.

### `BrowserContext.pages(): Promise<Page[]>`

All open top-level pages that belong to this context.

### `BrowserContext.waitForPage(action, opts?): Promise<Page>`

Run `action` and resolve to the next new page that opens **inside this
context**. Useful for popup-from-click flows.

### `BrowserContext.cookies(urls?): Promise<Cookie[]>`

Return cookies scoped to this user context. Pass a single URL or an
array to filter to cookies that would be sent on a request to that URL
(RFC-6265 domain/path match).

```typescript
const session = await ctx.cookies('https://app.example.com');
expect(session.find((c) => c.name === 'sid')).toBeDefined();
```

### `BrowserContext.addCookies(cookies): Promise<void>`

Add cookies to this context. `domain` is required (BiDi rejects
host-less cookies). Throws a clear error if you ask for
`sameSite: 'none'` without `secure: true`.

```typescript
await ctx.addCookies([
  {
    name: 'sid',
    value: 'eyJ…',
    domain: 'app.example.com',
    path: '/',
    secure: true,
    sameSite: 'lax',
  },
]);
```

### `BrowserContext.clearCookies(filter?): Promise<void>`

Remove cookies. With no filter, wipes every cookie in the context. With
a filter, removes cookies that match **all** provided fields (`name`,
`domain`, `path`).

```typescript
await ctx.clearCookies({ name: 'sid' }); // sign the user out
await ctx.clearCookies({ domain: 'tracker.io' }); // wipe a third party
await ctx.clearCookies(); // full reset
```

### `BrowserContext.storageState(opts?): Promise<SessionState>`

Snapshot cookies + localStorage for this context.

- `opts.includeCookies` — default `true`.
- `opts.includeLocalStorage` — default `true`. Only origins of **currently
  open pages** are captured; BiDi has no API to read localStorage for
  an origin no page is visiting. Open one page per origin you need
  captured before snapshotting.

### `BrowserContext.saveStorageState(path, opts?): Promise<SessionState>`

Snapshot the context and write it to `path` as JSON. Returns the
snapshot for inspection. See the auth-fixture example above.

### `BrowserContext.loadStorageState(source): Promise<void>`

Apply a previously-captured snapshot. `source` is a `SessionState`
object or a path to JSON produced by `saveStorageState`. Cookies are
applied immediately; localStorage entries are installed via a preload
script that runs on first navigation to each captured origin. Calling
`loadStorageState` again replaces the previous preload — it does not
stack.

### `BrowserContext.close(): Promise<void>`

Remove the user context and close all its pages. Subsequent operations
on this `BrowserContext` instance throw. The default context cannot be
closed — quit the browser instead.

### `BrowserContext.isClosed: boolean`

`true` after `close()` has run.

### `BrowserContext.on(event, listener): () => void`

Subscribe to lifecycle events on this context. Returns an **unsubscribe
function**; call it to remove the listener. Events fire **only** for
this context.

- `'page'` — fires for every new top-level page in this context,
  including popups opened by `window.open` or `target="_blank"` clicks.
  Listener receives the new `Page`.
- `'close'` — fires once when the context is closed (via `ctx.close()`
  or because the browser quit). Listener receives no arguments.

`ctx.off(event, listener)` is also available if you'd rather hold on to
the listener reference than the unsubscribe function.

```typescript
// Real-world: capture every console error across every tab a test opens,
// including popups. No more "why did my test pass with a 500 in a popup".
const errors: string[] = [];
ctx.on('page', (page) => {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`${page.url()}: ${msg.text()}`);
  });
});

const main = await ctx.newPage({ url: '/checkout' });
const receipt = await ctx.waitForPage(() => main.find('#print').click());
await receipt.waitForLoadState('load');
expect(errors).toEqual([]);
```

### `BrowserContext.addInitScript(script): Promise<InitScriptHandle>`

Register a script that runs in **every** page of this context _before_
any page script, on every navigation — including popups and iframes
that share the realm. Maps to BiDi `script.addPreloadScript` scoped to
this user context.

The handle exposes `.id` and `.remove()`. Removing only affects future
navigations.

```typescript
// Real-world: pin Date.now() and Math.random() for visual-regression
// stability; flip a feature flag before app code reads it.
const handle = await ctx.addInitScript(`
  const fixed = new Date('2025-01-15T12:00:00Z').getTime();
  Date.now = () => fixed;
  Math.random = () => 0.42;
  window.__FEATURES__ = { newCheckout: true };
`);

// …run tests…

await handle.remove(); // back to live time on the next navigation
```

Init scripts do **not** leak between contexts: a script added to
`ctx.A` never runs in pages of `ctx.B`.

### `BrowserContext.removeInitScript(id): Promise<void>`

Remove a previously-registered init script by id. Equivalent to
`handle.remove()`. Unknown ids are silently ignored.

### `BrowserContext.setExtraHTTPHeaders(headers): Promise<void>`

Replace the context's `extraHTTPHeaders` map at runtime. Applies to
all **future** requests from existing and new pages in this context.
Pass `{}` to clear.

```typescript
// Rotate a per-test correlation id partway through a flow.
await ctx.setExtraHTTPHeaders({ 'x-trace-id': crypto.randomUUID() });
```

### `BrowserContext.route(pattern, handler): Promise<string>`

Intercept matching requests from pages in **this context only**.
Returns a route id you can pass to `unroute()`.

Under the hood we register one BiDi `network.addIntercept` **per page**,
scoped to that page's browsing-context id. Pages opened later inherit
every route automatically; closed pages have their intercept removed.
Requests from other contexts are not seen.

- `pattern`: a URL substring, a `RegExp`, or a glob (`*` matches any
  run of non-`/` characters; `**` matches any run of characters).
- `handler({ request, fulfill, continue: cont, abort })`: called for
  every matched request. Must call exactly one of:
  - `fulfill({ status?, headers?, contentType?, body? })` — reply
    immediately without hitting the network.
  - `continue({ url?, method?, headers?, postData? })` — let the
    request go through, optionally rewritten.
  - `abort(reason?)` — fail the request.

```typescript
// Real-world: serve a fixture to one tenant, let the real API answer
// the other — in the same test, side-by-side.
const admin = await browser.newContext();
const guest = await browser.newContext();

await admin.route('**/api/users', async ({ fulfill }) => {
  await fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([{ id: 1, role: 'admin', name: 'Alice' }]),
  });
});

const aPage = await admin.newPage({ url: '/users' });
const gPage = await guest.newPage({ url: '/users' });
// aPage sees the mock; gPage hits the live backend.
```

Glob matching is `**`-aware: `'**/api/users'` matches
`https://api.example.com/v1/api/users` but not
`https://example.com/api/users/123`.

### `BrowserContext.unroute(id?): Promise<void>`

Remove a single route by id, or with no argument remove **every** route
registered on this context.

```typescript
const id = await ctx.route('**/api/flags', flagHandler);
// …
await ctx.unroute(id);
```

### `Page.context(): BrowserContext`

Return the `BrowserContext` a page belongs to. Useful when a listener
or helper receives a `Page` and needs to reach back to the context
(e.g. to read cookies, set headers, or close the context).

```typescript
ctx.on('page', (page) => {
  // page.context() === ctx
});
```

### `browser.newContext({ locale, timezoneId, geolocation })`

Identity-and-device overrides. Each is a thin wrapper over a BiDi
`emulation.*` command scoped to this user context, so **every** page in
the context — current and future, including popups — sees the override
without any per-page plumbing.

- `locale` — reported by `navigator.language`, `Intl.*`, and the
  `Accept-Language` header. BiDi `emulation.setLocaleOverride`.
  Cross-browser: Chrome and Firefox.
- `timezoneId` — IANA timezone applied to `Date` and
  `Intl.DateTimeFormat`. BiDi `emulation.setTimezoneOverride`.
  Cross-browser: Chrome and Firefox.
- `geolocation` — `{ latitude, longitude, accuracy? }` returned by
  `navigator.geolocation.getCurrentPosition()`. BiDi
  `emulation.setGeolocationOverride`. Reliable on Chrome; Firefox BiDi
  coverage is uneven and the setter wraps the underlying error with a
  clear engine name when it fails. The `geolocation` permission still
  has to be granted — see {@link BrowserContext.grantPermissions}.

```typescript
// Real-world: render the German checkout, log times in Berlin, pin the
// user to a Berlin lat/lon for the geofence test — all in one context,
// fully isolated from the Tokyo-locale context next to it.
const de = await browser.newContext({
  locale: 'de-DE',
  timezoneId: 'Europe/Berlin',
  geolocation: { latitude: 52.52, longitude: 13.4 },
});
await de.grantPermissions(['geolocation'], { origin: 'https://app.example.com' });
const page = await de.newPage({ url: 'https://app.example.com/checkout' });
```

### `BrowserContext.setLocale(locale: string | null): Promise<void>`

Change the per-context locale at runtime. Pass `null` to clear. Existing
pages pick up the new locale on their next page-driven re-read (e.g.
reload, navigation, or any code that re-evaluates `navigator.language`).
Cross-browser: Chrome and Firefox.

### `BrowserContext.setTimezone(timezoneId: string | null): Promise<void>`

Change the per-context timezone at runtime. Pass `null` to clear.
Cross-browser: Chrome and Firefox.

### `BrowserContext.setGeolocation(coords | null): Promise<void>`

Replace the geolocation override for this context. Pass `null` to clear.
Validates that latitude ∈ [-90, 90] and longitude ∈ [-180, 180]. Wraps
the underlying BiDi error with the engine name on failure so you can
tell when a browser hasn't shipped this command yet.

### `BrowserContext.grantPermissions(permissions, { origin, state? })`

Grant, deny, or reset W3C permissions for an origin in **this context
only**. `origin` is required — BiDi `permissions.setPermission` has no
"all origins" wildcard. `state` defaults to `'granted'`; pass `'denied'`
to pre-reject the prompt, or `'prompt'` to clear back to the browser
default.

Valid `permissions` names are the W3C Permissions catalogue:
`'geolocation'`, `'notifications'`, `'clipboard-read'`,
`'clipboard-write'`, `'camera'`, `'microphone'`, `'midi'`,
`'background-sync'`, `'persistent-storage'`, …

```typescript
// Real-world: don't make the test click through the notification prompt.
await ctx.grantPermissions(['notifications'], {
  origin: 'https://app.example.com',
  state: 'denied',
});
```

### `BrowserContext.clearPermissions(permissions, { origin })`

Reset the listed permissions for an origin back to `'prompt'`. Sugar for
`grantPermissions(…, { state: 'prompt' })`.

## Cross-browser support

Most of the `BrowserContext` API — cookies, storage state,
`on('page'|'close')`, `addInitScript`, `route`/`unroute`,
`setExtraHTTPHeaders`, `baseURL`, `extraHTTPHeaders`, `page.context()`,
`setLocale`, `setTimezone`, `grantPermissions`/`clearPermissions` — works
on **Chrome** and **Firefox** via WebDriver BiDi. Every method throws a
clear error in Classic mode.

`setGeolocation` / `newContext({ geolocation })` is reliable on Chrome.
Firefox BiDi `emulation.setGeolocationOverride` coverage is still
uneven; the setter surfaces the engine error with a clear message when
the browser hasn't shipped it.

A default `browser.newContext()` (no options) is always cross-browser.

## Scope and precedence (gotchas)

A few things that aren't bugs but bite if you don't know them:

- **`storageState` covers cookies + localStorage only.** Not
  sessionStorage, not IndexedDB, not Cache Storage. Apps that put their
  auth token in sessionStorage (some Auth0 / MSAL fallback configs) will
  need a custom restore step.
- **Browser-level vs context-level emulation race.** `browser.setGeolocation(...)`
  is a session-wide override; `ctx.setGeolocation(...)` is a per-context
  override. If both are set, the context-level one wins inside the
  context (it carries a more specific `userContexts` scope at the BiDi
  layer). To avoid surprises, pick one layer per concern.
- **`ctx.route()` does not see service-worker requests.** Per-page
  intercepts are bound to the page's browsing context; fetches initiated
  by a service worker or a dedicated/shared worker bypass them. Mock
  those endpoints at the application layer, or unregister the service
  worker via an `addInitScript`.
- **`grantPermissions(['a','b'], ...)` is not transactional.** Each
  permission is a separate BiDi call; if the second one fails, the first
  one stays granted. Re-grant idempotently or wrap in your own
  try/finally if you need rollback.
- **`page.context()` reflects the BiDi user context, not the window
  group.** Popups opened from a page in `ctx` belong to `ctx`. Pages
  opened via `browser.openPage()` / `waitForPage()` belong to
  `browser.defaultContext`.

## What's not (yet) supported

These are documented gaps, not bugs — open an issue if you need them:

- **Per-context viewport, `colorScheme`, `reducedMotion`, `forcedColors`,
  `userAgent`.** These require either CDP (Chromium-only) or BiDi
  primitives that aren't broadly shipped yet. Use
  `browser.emulate({ … })` for the session-wide equivalents on Chromium.
- **localStorage capture for origins with no open page.** BiDi has no
  out-of-band storage read API; only currently-visiting origins are in
  the snapshot.
- **`httpCredentials` / `offline`.** Not modelled in BiDi yet.
