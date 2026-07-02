# Browser API

The `Browser` class is the main entry point for browser automation.

> **Heads-up.** `browser.click()`, `browser.find()`, `browser.evaluate()`
> and the other DOM-touching shortcuts target the focused page in
> `browser.defaultContext` — i.e. `(await browser.activePage()).X(...)`.
> They never reach into pages inside a context created by
> `browser.newContext()`. See
> [Getting Started — `browser.X()` vs `page.X()`](./getting-started.md#browserx-vs-pagex--when-to-use-which).

## Launching

```typescript
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });

// With pre-loaded session state
const browser = await Browser.launch({
  browserName: 'chrome',
  storageState: './auth.json',
});
```

### Launch options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `browserName` | `'chrome' \| 'chromium' \| 'firefox'` | `'chrome'` | Browser to launch |
| `enableBiDi` | `boolean` | `true` | Use WebDriver BiDi. Set `false` only when running against a browser that does not support it — every BiDi-only feature then throws a `requires BiDi` error if called. |
| `captureLogs` | `boolean` | `false` | Start console/error log capture immediately at launch instead of lazily on first `browser.logs`/`onConsole`/`onError`/`waitForConsole` touch. See [BiDi Features — Console & Error Logs](./bidi-features.md#console--error-logs). |
| `storageState` | `string` | — | Path to a session-state JSON file to load on startup |
| `mobileEmulation` | `MobileEmulation \| DeviceName` | — | Mobile device emulation settings (Chrome/Chromium only) |
| `downloadsDir` | `string` | temp dir | Directory where downloaded files are saved |

## Navigation

```typescript
// Navigate to URL — waits for the page load event (default)
await browser.navigateTo('https://example.com');

// Wait only until DOMContentLoaded (faster — skips images/fonts)
await browser.navigateTo('https://example.com', { waitUntil: 'domcontentloaded' });

// Wait until no requests are in-flight for 500 ms after load
await browser.navigateTo('https://example.com', { waitUntil: 'networkidle' });

// Fire-and-forget — does not wait for any load event
await browser.navigateTo('https://example.com', { waitUntil: 'none' });

// Get current URL
const url = await browser.url();

// Get page title
const title = await browser.title();
```

### `waitForLoadState(state?, opts?)`

Wait for the page to reach a given load state after an action that triggers navigation
(e.g. clicking a link or submitting a form).

```typescript
// After an action that causes navigation:
await browser.click('#submit');
await browser.waitForLoadState();              // default: 'load'
await browser.waitForLoadState('domcontentloaded');
await browser.waitForLoadState('networkidle', { timeout: 10_000 });
```

| State | Description |
|-------|-------------|
| `'load'` | Page `load` event fired (default) |
| `'domcontentloaded'` | `DOMContentLoaded` fired — no waiting for images/fonts |
| `'networkidle'` | `load` + no in-flight requests for 500 ms |

Uses BiDi `browsingContext.load` / `browsingContext.domContentLoaded` events.

### History

```typescript
await browser.goBack();      // history back
await browser.goForward();   // history forward
await browser.reload();      // reload the active page
```

All three proxy to the active page (`browser.activePage()`); use
`page.goBack()` / `page.goForward()` / `page.reload()` directly when
working with a specific tab.

### Page content

```typescript
// Full document HTML (document.documentElement.outerHTML)
const html = await browser.content();

// Replace the document with synthetic HTML and wait for the load event
await browser.setContent('<!doctype html><h1>Hello</h1>');

// Faster — wait only for DOMContentLoaded
await browser.setContent(html, { waitUntil: 'domcontentloaded' });
```

Implementation: `setContent` navigates to a `data:text/html` URL so the
new document goes through a real navigation and load events fire.

### Viewport

```typescript
await browser.setViewportSize({ width: 1280, height: 720 });
```

Uses BiDi `browsingContext.setViewport` to resize the **layout** viewport
without changing the OS window. In Classic mode it falls back to
`POST /session/{id}/window/rect`, which resizes the OS window — the
inner viewport may end up a few pixels smaller because of browser
chrome.

For full mobile emulation (DPR, user-agent, touch), pass
`mobileEmulation` to `Browser.launch` — see
[Mobile emulation](./mobile-emulation.md). `setViewportSize` only
changes the viewport box.

### Emulation

`browser.emulate({...})` overrides `prefers-color-scheme`,
`prefers-reduced-motion`, `forced-colors`, `navigator.language`,
`Intl.*` timezone, and `navigator.onLine` for the current session.

```typescript
await browser.emulate({
  colorScheme: 'dark',
  locale: 'de-DE',
  timezoneId: 'Europe/Berlin',
});
```

`locale` and `timezoneId` work on Chrome, Chromium and Firefox.
The CSS-media-feature fields and `offline` are Chromium-only — see
[Emulation](./emulation.md) for the full option table and use cases.

## Element Interaction

String selectors are CSS selectors. For semantic selectors, pass a `By.*`
locator or use `browser.getByRole()`, `browser.getByText()`,
`browser.getByLabel()`, and related helpers.

```typescript
// Click an element
await browser.click('#submit-btn');
await browser.click(By.text('Submit'));

// Fill text input
await browser.fill('#username', 'testuser');

// Clear input
await browser.clear('#search');
```

### `getValue(selector, opts?)`

Return the live `value` property of an `<input>`, `<textarea>`, or
`<select>`. Use this rather than `getAttribute('value')` — the
attribute reflects the *initial* value, the property reflects what the
user has typed.

```typescript
const typed = await browser.getValue('#input');
const withTimeout = await browser.getValue('#input', { timeout: 1000 });
```

Returns `string` (empty string if the property is null/undefined).

### `getAttribute(selector, name, opts?)`

Return the value of an HTML attribute, or `null` if the attribute is
not set. Pass a `By` locator or CSS string.

```typescript
const href = await browser.getAttribute('a.link', 'href');
const role = await browser.getAttribute(By.testId('menu'), 'role');
```

## Finding Elements

```typescript
// Returns an ElementHandle for chained operations
const element = browser.find('#my-element');

// With By locators
const button = browser.find(By.text('Click me'));
const input = browser.find(By.placeholder('Enter email'));
```

## Playwright-style Locators

```typescript
// By role
browser.getByRole('button', { name: 'Submit' });

// By visible text
browser.getByText('Hello World');
browser.getByText('partial', { exact: false });

// By label
browser.getByLabel('Username');

// By placeholder
browser.getByPlaceholder('Enter email');

// By test ID
browser.getByTestId('submit-btn');
```

## Waiting

> **`attached` vs `visible`.** *Attached* means the element exists in
> the DOM — it may still be `display: none` or have zero size.
> *Visible* is stricter: attached **and** laid out with non-zero size
> and not `visibility: hidden`. *Hidden* and *detached* are the
> respective negatives. The default for `waitFor` is `'visible'`,
> which matches what users mean 95 % of the time.

```typescript
// Canonical: pick the state explicitly.
await browser.waitFor('#modal',   { state: 'visible' });
await browser.waitFor('#loading', { state: 'hidden', timeout: 5000 });
await browser.waitFor('#dynamic', { state: 'attached' });
await browser.waitFor('#removed', { state: 'detached' });

// Shortcuts (one-liner wrappers):
await browser.waitForVisible('#modal');
await browser.waitForHidden('#loading');
await browser.waitForAttached('#dynamic-content');
await browser.waitForDetached('#removed-element');

// Pause for fixed time
await browser.pause(1000); // 1 second

// Wait for custom condition
await browser.waitFor(async () => {
  const count = await browser.find('#items').text();
  return parseInt(count) > 5;
});
```

## Assertions

```typescript
// Assert text content
await browser.expect('#message').toHaveText('Success');
await browser.expect('#message').toContainText('Success');

// Assert visibility
await browser.expect('#modal').toBeVisible();
await browser.expect('#modal').not.toBeVisible();

// Assert attribute
await browser.expect('a').toHaveAttribute('href', '/home');

// Assert value
await browser.expect('#input').toHaveValue('test');
```

## Frames and Contexts

### Iframes

```typescript
import { Browser } from 'craftdriver';

const browser = await Browser.launch();
await browser.navigateTo('https://example.com/page-with-iframe');

// Obtain a Frame scoped to the first matching iframe
const frame = await browser.frame('#stripe-card-frame');

// All element methods are scoped to the iframe
await frame.fill('#card-number', '4242 4242 4242 4242');
await frame.click('#pay-btn');
await frame.expect('#result').toContainText('success');

// Evaluate JavaScript inside the iframe
const iframeTitle = await frame.evaluate(() => document.title);

// Get all iframes on the page
const frames = await browser.frames();
console.log(`Page has ${frames.length} iframe(s)`);
```

### Pages (tabs and popups)

A `Page` is a top-level browsing context — a tab or a popup window. Maps
1-to-1 onto the WebDriver BiDi `browsingContext` concept (the BiDi spec
calls them "top-level browsing contexts"; we call them pages because that
is what users mean).

```typescript
import { Browser } from 'craftdriver';

const browser = await Browser.launch();
await browser.navigateTo('https://example.com/dashboard');

// List all open pages (tabs / windows)
const pages = await browser.pages();
console.log(`Open tabs: ${pages.length}`);

// Open a new tab proactively (BiDi-only)
const newTab = await browser.openPage({
  url: 'https://example.com/help',
  type: 'tab',
});
await newTab.waitForLoadState('load');

// Capture a popup opened by a user action
const popup = await browser.waitForPage(async () => {
  await browser.click('#open-in-new-tab');
});

await popup.waitForLoadState('load');

// Interact with the popup just like the main browser
const heading = await popup.find('h1').text();
console.log(heading);

await popup.evaluate(() => {
  window.close();
});
```

> **Note.** `browser.openPage()` requires BiDi (the default). In Classic
> mode it throws — WebDriver Classic has no spec-level command for
> creating a top-level browsing context.
>
> For **isolated profiles** (cookies, localStorage, IndexedDB scoped to
> a single test user), see [Browser Contexts](./browser-context.md) —
> `browser.newContext()` returns a real `BrowserContext` backed by BiDi
> user contexts.

## Screenshots

```typescript
// Capture viewport (default)
const buffer = await browser.screenshot();

// Capture the full scrollable document (BiDi)
const fullBuffer = await browser.screenshot({ fullPage: true });

// Capture specific element
const elementBuffer = await browser.screenshot({ selector: '#header' });

// Save to file
await browser.screenshot({ path: 'page.png' });
await browser.screenshot({ selector: '#header', path: 'element.png' });
```

## Session Management

See [Session Management](./session-management.md) for full details.

```typescript
// Access storage manager
const storage = browser.storage;

// Save current session to file
await browser.saveState('./session.json');

// Load session from file
await browser.loadState('./session.json');
```

## Evaluate

Run JavaScript in the page and get the result back. Useful for reading app state,
asserting on globals, or triggering things the UI doesn't expose.

```typescript
// Function form — arguments are passed through
const title = await browser.evaluate(() => document.title);
const sum   = await browser.evaluate((a, b) => a + b, 2, 3); // 5

// String form — write it like a function body
const href = await browser.evaluate('return location.href');

// On a specific element — receives the DOM node as the first argument
const tag  = await browser.find('#btn').evaluate(el => el.tagName.toLowerCase());
const has  = await browser.find('#btn').evaluate((el, cls) => el.classList.contains(cls), 'active');
```

Only JSON-serializable return values are supported. Returning a DOM node or function
throws a clear error.

## Init scripts

Register a script that runs before any page script on every navigation:

```typescript
// Function form
const handle = await browser.addInitScript(() => {
  window.__featureFlags = { darkMode: true };
});

// Or a script string
await browser.addInitScript(`window.__featureFlags = { darkMode: true };`);

// The script survives navigations automatically
await browser.navigateTo(url);
const flag = await browser.evaluate(() => window.__featureFlags.darkMode); // true

// Unregister when no longer needed
await handle.remove();
await browser.navigateTo(url);
// window.__featureFlags is now undefined
```

> Init scripts are scoped to the current browser session and survive navigations automatically.

## Files (upload & download)

### Upload

Set the value of an `<input type="file">` element:

```typescript
const handle = browser.find('#file-input');
await handle.setInputFiles('/absolute/path/to/file.pdf');

// Multiple files (input must have the `multiple` attribute)
await handle.setInputFiles(['/path/to/a.pdf', '/path/to/b.pdf']);
```

Throws a clear error if the element is not an `<input type="file">`.

### Download

Pass a callback that triggers the download; `waitForDownload` resolves once
a file appears in the downloads directory:

```typescript
const dl = await browser.waitForDownload(() => browser.click('#export-btn'));

console.log(dl.suggestedFilename); // 'report.csv'
console.log(dl.path);              // absolute path on disk

// Copy to a known location
await dl.saveAs('/tmp/report.csv');
```

Configure the directory at launch (defaults to an isolated temp directory):

```typescript
const browser = await Browser.launch({
  downloadsDir: '/tmp/my-test-downloads',
});
```

## Time Control

Control the clock the page sees — `Date.now()`, `new Date()`,
`performance.now()`, `setTimeout`, and `setInterval`.

See [Virtual Clock](./clock.md) for the full guide and method reference.

```typescript
// Freeze date for date-dependent rendering (no fake timers)
await browser.clock.setFixedTime('2026-06-15T23:59:00Z');
await browser.navigateTo('/billing');
await browser.expect('#trial-banner').toContainText('expires today');

// Full fake-timer installation — control every setTimeout/setInterval
await browser.clock.install({ time: '2026-01-01T09:00:00Z' });
await browser.navigateTo('/dashboard');
await browser.clock.fastForward('15:01'); // advance 15 min 1 s
await browser.expect('#login-modal').toBeVisible();

// Debounced input: advance exactly to the threshold
await browser.clock.install();
await browser.fill('#q', 'lap');
await browser.clock.tick(299); // debounce hasn't fired yet
await browser.clock.tick(2);   // total 301 ms — fires exactly once
```

## Dialogs (alert / confirm / prompt)

> **Heads-up.** craftdriver makes unhandled dialogs **loud failures**
> rather than silently auto-dismissing them like Playwright does. The
> action that triggered the dialog will time out until something
> handles it. See [Dialogs](./dialogs.md) for the dedicated guide,
> including `waitForDialog()`, `onDialog()`, and the imperative
> `acceptDialog()` / `dismissDialog()` API.

Quick example:

```typescript
const [, dialog] = await Promise.all([
  browser.click('#confirm-btn'),
  browser.waitForDialog(),
]);
await dialog.accept();
```

## Cleanup

```typescript
// Always quit the browser when done
await browser.quit();
```

`quit()` closes the browser session and stops the WebDriver process. Use
it in a `finally` block (or your test runner's teardown hook) so it
runs even when the test throws:

```typescript
const browser = await Browser.launch({ browserName: 'chrome' });
try {
  // … your test …
} finally {
  await browser.quit().catch(() => {
    // The session may already be gone (browser crash, killed driver,
    // network blip). Swallow — there is nothing useful left to clean
    // up from the client side.
  });
}
```

### When `quit()` is not enough

`quit()` makes a best-effort `DELETE /session` call to the driver and
then kills the local driver process craftdriver spawned. It does **not**
cover:

- **The host process is killed** (`kill -9`, OS reboot, CI runner
  cancellation). The driver and browser may linger as orphan processes.
  Clean them up at the OS level (CI runners typically do this
  automatically; on a dev machine `pkill chromedriver` /
  `pkill geckodriver` is the easy fix).
- **Custom `ChromeService` / `FirefoxService` you own.** If you passed
  one via `chromeService` / `firefoxService` and want to keep it for a
  second `Browser.launch()` call, manage its lifetime yourself —
  craftdriver only stops services it spawned.
- **Multiple browsers in one test.** Each instance must be quit
  independently; there is no global registry.

## Advanced

### `isBiDiEnabled()`

Returns `true` if BiDi negotiation succeeded at launch. Use this to
guard code paths that depend on BiDi-only features (network mocking,
log capture, init scripts) when the same code may run against a
browser launched with `enableBiDi: false`.

```typescript
if (browser.isBiDiEnabled()) {
  await browser.network.block('**/analytics/**');
}
```

### `actions()`

Returns a low-level W3C Actions builder for input sequences the
high-level `browser.keyboard` / `browser.mouse` APIs do not cover —
e.g. drag-and-drop with a held modifier, multi-pointer gestures, or
custom timing.

The builder is fluent and **all steps in a single chain are dispatched
in one HTTP `POST /session/{id}/actions` call**, so they execute as one
sequence on the browser side.

#### Example: shift-drag a marquee selection

The example page at `examples/mouse.html` includes an SVG canvas at
fixed coordinates. The snippet below holds **Shift**, drags from
`(100, 100)` to `(300, 300)`, then releases — modelling a "Shift-drag
to add to selection" interaction:

```typescript
import { Browser, Key } from 'craftdriver';

const browser = await Browser.launch();
await browser.navigateTo('http://127.0.0.1:8080/mouse.html');

await browser
  .actions()
  .keyDown(Key.SHIFT)               // hold Shift
  .pointerMove(100, 100)            // jump cursor to start
  .pointerDown()                    // press primary button
  .pointerMove(300, 300, { duration: 250 })  // drag over 250 ms
  .pointerUp()                      // release
  .keyUp(Key.SHIFT)                 // release Shift
  .perform();

await browser.quit();
```

Available steps: `keyDown(value)`, `keyUp(value)`, `pointerMove(x, y, opts?)`,
`pointerDown(button?)`, `pointerUp(button?)`, `pause(ms?)`,
`wheel(deltaX, deltaY, opts?)`, then `await .perform()`.

For routine clicks and typing prefer `browser.keyboard`,
`browser.mouse`, and `browser.click()` — they auto-wait for the target
and report failures clearly. Reach for `actions()` only when you need
byte-for-byte control of the input sequence.

## Configuring timeouts

All element actions, waits, and assertions use a browser-level default timeout
of **5000 ms**. You can change this globally or override it per call.

### Default timeouts

| Setting | Default | Applies to |
|---|---|---|
| `setDefaultTimeout(ms)` | **5 000 ms** | Element actions (`click`, `fill`, `clear`, `getValue`, `getAttribute`, …), `waitFor*`, assertions, dialog waits, locator/handle methods. |
| `setDefaultNavigationTimeout(ms)` | **30 000 ms** | `navigateTo()` and `waitForLoadState()`. |

Every method that accepts a `{ timeout }` option overrides the
appropriate default for that single call. The change made by
`setDefaultTimeout()` is live — it applies to `ElementHandle` and
`Locator` objects that already exist.

### Global defaults

```typescript
// Change the default for all actions/waits/assertions on this browser instance
browser.setDefaultTimeout(10000); // 10 s

// Change the default for navigation (used by navigateTo in future BiDi mode)
browser.setDefaultNavigationTimeout(30000); // 30 s (this is already the default)
```

### Per-call override

Every method that interacts with the DOM accepts an optional `{ timeout }` option
that overrides the browser default for that single call:

```typescript
// One-shot override — only this click uses 2 s
await browser.click('#slow-button', { timeout: 2000 });

// Works on fill, clear, getValue, getAttribute, waitFor* too
await browser.fill('#input', 'text', { timeout: 3000 });
await browser.waitForVisible('#modal', { timeout: 8000 });

// Works on ElementHandle methods
await browser.find('#result').text({ timeout: 1000 });
await browser.find('#submit').click({ timeout: 2000 });

// Works on assertions
await browser.expect('#message').toBeVisible({ timeout: 3000 });
await browser.expect('#data').toHaveText('Loaded', { timeout: 10000 });
```

### Live updates

`setDefaultTimeout()` takes effect immediately, including for `ElementHandle`
and locator objects that were already created:

```typescript
const button = browser.find('#submit');
browser.setDefaultTimeout(2000); // change after creating handle
await button.click(); // uses 2000 ms, not 5000 ms
```

## Properties

| Property   | Type                  | Description                    |
| ---------- | --------------------- | ------------------------------ |
| `keyboard` | `Keyboard`            | Low-level keyboard control     |
| `mouse`    | `Mouse`               | Low-level mouse control        |
| `storage`  | `SessionStateManager` | Cookie and storage management  |
| `network`  | `NetworkInterceptor`  | Network mocking (BiDi only)    |
| `logs`     | `LogMonitor`          | Console/error logs (BiDi only) |
