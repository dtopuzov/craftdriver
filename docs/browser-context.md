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

> **Current limitation.** `BrowserContext` does not yet have its own
> `storageState()` round-trip helper. Save/restore session state is currently a
> `Browser`-level API.

> **Heads-up.** `browser.click()`, `browser.find()` and the other
> `Browser`-level shortcuts always target a page in **`defaultContext`**.
> They never reach a `Page` you got from `ctx.newPage()` on a
> non-default context. Always call methods on the `Page` you got back —
> e.g. `await aPage.fill('#user', 'alice')`, not `browser.fill(...)`.

## Multi-user login (the canonical example)

Two contexts, two logins, no cross-talk:

```typescript
const alice = await browser.newContext();
const bob = await browser.newContext();

const aPage = await alice.newPage({ url: 'https://app.example.com/login' });
await aPage.find('#username').fill('alice');
await aPage.find('#password').fill('secret');
await aPage.find('#submit').click();
await aPage.expect('#welcome').toContainText('alice');

const bPage = await bob.newPage({ url: 'https://app.example.com/login' });
// bPage cannot see alice's session cookie.
await bPage.find('#username').fill('bob');
await bPage.find('#password').fill('secret');
await bPage.find('#submit').click();
await bPage.expect('#welcome').toContainText('bob');

await alice.close();
await bob.close();
```

## API

### `browser.newContext(): Promise<BrowserContext>`

Create a new isolated user context. Backed by BiDi
`browser.createUserContext`. Throws in Classic mode.

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

### `BrowserContext.close(): Promise<void>`

Remove the user context and close all its pages. Subsequent operations
on this `BrowserContext` instance throw. The default context cannot be
closed — quit the browser instead.

### `BrowserContext.isClosed: boolean`

`true` after `close()` has run.

## What's not (yet) supported

These are documented gaps, not bugs — open an issue if you need them:

- **`storageState` round-trip.** Save / restore cookies + localStorage
  to a file. Cookie partition uses the `userContext` field internally
  but isn't yet wired to a `storageState()` helper on `BrowserContext`.
- **Per-context proxy / geolocation / locale overrides.** BiDi has the
  hooks; we just haven't surfaced them.
- **`page.context()`.** Knowing which `BrowserContext` a `Page` belongs
  to. Workaround: track the owning context yourself, or call
  `ctx.pages()` and match by `page.id()`.
