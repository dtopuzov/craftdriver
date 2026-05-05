# Capability gaps & roadmap (2026-05)

This is a focused, opinionated plan for closing the remaining
**capability** gaps vs Playwright / Selenium. Syntax sugar and DX
polish are out of scope here.

For each item:

- **What it is** — a plain-English explanation, not just an API name.
- **Why it matters** — concrete, real-world tests it unlocks.
- **Cost / approach** — how it would be built in craftdriver.
- **Priority** — `P1` ship soon, `P2` next, `P3` only if asked.

Already shipped (do not re-implement):

- ✅ Full-page screenshot (`screenshot({ fullPage: true })`, BiDi).
- ✅ Geolocation override (`setGeolocation`, BiDi `emulation.setGeolocationOverride`).

---

## P1 — close obvious holes

### 1. Emulation knobs (colorScheme, reducedMotion, locale, timezoneId, offline)

**What it is.** A handful of one-liner overrides that change what the
page sees from `matchMedia`, `navigator.language`, `Intl.*`, and the
network stack. BiDi exposes most of these through the `emulation` and
`network` modules; the rest go via init scripts.

**Why it matters.**

- **Dark mode.** `colorScheme: 'dark'` lets you test that your
  `prefers-color-scheme: dark` CSS branch actually renders \u2014 without
  asking the OS to flip themes between tests.
- **Localized formatting.** `locale: 'de-DE'` + `timezoneId: 'Europe/Berlin'`
  surfaces real bugs: a price page that hard-codes `,` vs `.` decimals,
  a calendar that picks the wrong week start, an SSR component that
  renders one timezone server-side and another in the browser.
- **Offline mode.** `offline: true` lets you assert that a PWA's
  service worker actually serves the cached fallback, and that retry
  UI appears when the user loses connectivity mid-flow.
- **Reduced motion / forced colors.** Accessibility regression tests:
  prove your animation is suppressed when the user prefers it, prove
  high-contrast mode doesn't clip your buttons.

**Approach.** Add a single `browser.emulate({ colorScheme?, reducedMotion?,
forcedColors?, locale?, timezoneId?, offline? })` method. Map each field
to BiDi where supported (`emulation.setLocaleOverride`,
`emulation.setTimezoneOverride`, `network.setOfflineMode` /
`browsingContext.setNetworkConditions`), fall back to a CSS-feature
override init script for `colorScheme` / `reducedMotion` /
`forcedColors` on browsers that don't expose them yet.

**Priority: P1.** Small surface, big real-world coverage, all BiDi.

---

### 2. HAR record / replay

**What it is.** A HAR file is a standard JSON archive of every HTTP
request/response made by a page. **Recording** writes one out;
**replaying** intercepts requests and answers them from the archive
instead of hitting the network.

**Why it matters.**

- **Deterministic tests against flaky third parties.** Record once
  against the real Stripe / Auth0 / Maps backend, replay forever in CI.
  No outages, no rate limits, no test-data drift.
- **Forensics.** When a CI run fails, the HAR shows exactly which
  request returned what — far more debuggable than a stack trace.
- **Offline development.** A developer with no VPN can still reproduce
  a customer's bug from their HAR.

**Approach.** Build it on top of the existing `NetworkInterceptor`:

- `browser.startHAR(path)` subscribes to `network.responseCompleted` /
  `network.fetchError` and writes HAR 1.2 entries.
- `browser.routeFromHAR(path, { update?, notFound? })` registers a
  network route that matches request URL + method against the archive
  and serves the recorded response (or falls back to the live network
  when `notFound: 'fallback'`).

**Priority: P1.** Highest leverage feature missing today; all the
plumbing (network interception, mock responses) already exists.

---

### 3. PDF generation

**What it is.** `page.pdf()` renders the page's print stylesheet to a
PDF and returns the bytes. Chromium-only (Firefox has no equivalent).

**Why it matters.**

- **Invoice / report apps.** Most B2B SaaS has at least one screen that
  ends in "Download PDF". Today you have no way to test that the
  generated PDF has the right pages, the right header, the right
  totals — except by relying on the server-side renderer being the
  same as the browser's, which it usually isn't.
- **Print stylesheet regression.** Catches the classic bug where
  someone refactors `display: flex` and the print layout silently
  collapses.

**Approach.** BiDi has no PDF command yet. Two options:

1. Add a thin CDP escape hatch (`browser.cdp(method, params)`) that
   speaks Chrome DevTools Protocol over the same WebDriver session
   (chromedriver supports a `goog:chromeOptions.debuggerAddress` hop
   today, but a cleaner route is to expose it through BiDi's
   `goog:cdp` extension once chromedriver lands it).
2. Build `browser.pdf(opts)` on top of that escape hatch using
   `Page.printToPDF`.

**Priority: P1** for Chromium users, **N/A** for Firefox.

---

## P2 — useful but narrower

### 4. Clock / time control

**What it is.** A way to **freeze, advance, or override** the wall
clock the page sees. Concretely: `Date.now`, `new Date()`,
`performance.now`, `setTimeout` / `setInterval` firing, and (with care)
`requestAnimationFrame` ticks.

Playwright ships this as `page.clock.install()` +
`clock.fastForward('30:00')` + `clock.setFixedTime(date)`. Under the
hood it's an injected polyfill (think `sinon.useFakeTimers`) plus a
BiDi-driven controller.

**Why it matters — three concrete tests you can't write reliably without it.**

1. **Auto-logout after 15 minutes of idle.** Without clock control you
   wait 15 real minutes (CI cost) or you stub `Date` in app code (test
   doesn't reflect production). With it:

   ```ts
   await browser.clock.install({ time: '2026-01-01T09:00:00Z' });
   await browser.navigateTo('/dashboard');
   await browser.clock.fastForward('15:01'); // jump 15 min 1 s
   await browser.expect('#login-modal').toBeVisible();
   ```

2. **Free-trial banner that disappears at midnight.** The banner shows
   "expires today" before midnight and "expired" after. You want both
   assertions in one CI run, not "rerun the build at 23:59 local".

   ```ts
   await browser.clock.setFixedTime(new Date('2026-06-15T23:59:00Z'));
   await browser.navigateTo('/billing');
   await browser.expect('#trial-banner').toContainText('expires today');

   await browser.clock.setFixedTime(new Date('2026-06-16T00:00:01Z'));
   await browser.reload();
   await browser.expect('#trial-banner').toContainText('expired');
   ```

3. **Debounced search input.** Component fires the network request
   300 ms after the user stops typing. Today you `setTimeout` for
   400 ms in the test and pray; with clock control you advance exactly
   300 ms and assert the request fired exactly once.

   ```ts
   await browser.clock.install();
   await browser.find('#q').type('lap');
   await browser.clock.tick(299); // not yet
   // assert no request
   await browser.clock.tick(2);   // 301 ms total
   // assert exactly one request to /search?q=lap
   ```

**Approach.** Init script that installs a sinon-style fake-timer
polyfill into every new document; expose `install`, `tick`,
`fastForward`, `setFixedTime`, `uninstall` on `browser.clock`. No BiDi
command needed — it's just a script and some bookkeeping.

**Priority: P2.** High value for the apps that need it (auth flows,
trials, debouncing), zero value for the rest.

---

### 5. Video recording

**What it is.** Record the test run as a `.webm` (or `.mp4`) and save
it on failure. Playwright does this via the browser's own screencast
APIs.

**Why it matters.** Tracing already captures periodic PNGs, which is
enough for most flake debugging. Video is strictly more useful when
the failure is visual (animation glitch, layout shift, focus jumping)
or short-lived between screenshots.

**Approach.**

- BiDi has no native screencast yet.
- Chromium: `Page.startScreencast` over CDP (same escape hatch needed
  for PDF).
- Firefox: no equivalent today.
- Realistic ship: extend the tracing bundle with a screencast frame
  stream when `video: true` and Chromium is in use; muxer can be
  external (let users run `ffmpeg` on the resulting frames).

**Priority: P2.** Tracing PNGs cover 80% of the use case; full video
is mostly demand-driven.

---

### 6. Accessibility tree snapshot

**What it is.** `browser.accessibility.snapshot()` returning the full
ARIA tree the page exposes to assistive tech.

**Why it matters.** Catches accessibility regressions deterministically
— "the submit button lost its accessible name", "the modal isn't
announced as a dialog" — without spinning up axe-core or a real
screen-reader.

**Approach.** BiDi has `browsingContext.captureAccessibilityTree` in
draft; Chromium's `Accessibility.getFullAXTree` works today over CDP.
Same escape-hatch story as PDF / video.

**Priority: P2.**

---

## P3 — nice to have, niche

### 7. WebAuthn virtual authenticator

**What it is — in plain English.**

WebAuthn is the W3C standard behind passwordless login: passkeys,
hardware security keys (YubiKey), Touch ID / Face ID, Windows Hello.
The browser exposes it as `navigator.credentials.create()` /
`navigator.credentials.get()`, and the prompt is a real OS dialog
asking you to touch a key, scan a fingerprint, or confirm with a PIN.

That OS dialog is **why these flows are a nightmare to test**: a
headless CI box has no fingerprint reader and no human to tap the key.

A **virtual authenticator** is a fake authenticator the browser knows
about. You install it via the WebDriver protocol (`POST
/session/:id/webauthn/authenticator`) with options like "I support
resident keys, I do user verification, I am a roaming USB key", and
from then on every WebAuthn ceremony the page initiates is satisfied
silently against this in-memory fake. You can also pre-load
credentials into it (so a "log in with passkey" flow finds the right
credential) and inspect what credentials the site stored.

**What real tests this unlocks.**

1. **"Sign in with passkey" happy path.** Pre-load a credential for
   `example.com` into the virtual authenticator, navigate to the
   login page, click "Use a passkey", and assert you land on the
   dashboard. No prompt, no human.

2. **Registration flow.** Click "Register a new passkey", let the
   virtual authenticator create one, then read the credential back
   out via the WebDriver endpoint and assert your backend stored
   the same `credentialId`.

3. **Negative paths.** Configure the authenticator with
   `isUserVerified: false` and assert your site refuses login (some
   high-assurance flows require UV). Or remove the credential and
   assert the "no passkey found" UI shows.

4. **Cross-device / roaming.** Configure a USB-style authenticator
   vs a platform authenticator and assert your discovery logic
   prompts the right one.

**Approach.** Selenium 4 already exposes this via the W3C "WebAuthn"
extension; chromedriver and geckodriver both implement the endpoints.
craftdriver would add `browser.addVirtualAuthenticator(opts)` /
`removeVirtualAuthenticator(id)` /
`addCredential(authId, credential)` etc. — all Classic WebDriver
endpoints, no BiDi needed.

**Priority: P3.** Niche but unique: if a team builds passkey flows,
*nothing else* lets them test it end-to-end in CI. Cheap to add when
asked for.

---

### 8. IndexedDB in storage state

**What it is.** Today `getStorageState` / `setStorageState` covers
cookies, localStorage and sessionStorage. Apps that persist state in
IndexedDB (Notion-style offline editors, large client-side caches) are
not covered.

**Why it matters.** Lets you snapshot the full client-side state of
a logged-in, populated user once, then reuse it as the starting point
for every test — even if the app stores its data in IDB.

**Approach.** Extend `SessionStateManager` to walk `indexedDB.databases()`
and serialize each database's object stores to JSON. Restore by
re-creating databases via injected script before navigation.

**Priority: P3.** Most apps don't put critical state in IDB.

---

### 9. CDP escape hatch

**What it is.** A typed `browser.cdp(method, params)` for Chromium
sessions. Not a feature in itself — a foundation that unlocks PDF,
video, accessibility tree, and any future Chromium-only thing BiDi
hasn't standardized yet.

**Approach.** chromedriver exposes CDP via `goog:cdp.*` BiDi commands
on a BiDi session. Wire those through the existing `BiDiConnection`,
expose as `browser.cdp(...)` guarded by a Chromium check.

**Priority: P3 as a standalone feature, P1 as a prerequisite for #3
and #5.** Ship together with whichever one lands first.

---

## Out of scope (do not chase)

- **Test runner / assertion framework / trace viewer UI.** craftdriver
  is a library, not a test framework. `expect()` exists for ergonomics,
  not because we're competing with vitest.
- **Codegen / record-and-playback.** Different product.
- **Browser binary management / download.** Users already manage their
  own Chrome / Firefox installs; chromedriver / geckodriver are
  required regardless.
- **Multi-language bindings.** Node-only is the value proposition.

---

## Recommended ship order

1. **Emulation knobs** (P1, small) — one PR, big coverage uplift.
2. **HAR record/replay** (P1, medium) — built on existing interceptor.
3. **CDP escape hatch + `page.pdf()`** (P1 / P3) — same PR.
4. **Clock control** (P2) — fully self-contained, init-script-only.
5. **WebAuthn virtual authenticator** (P3) — when a user actually asks.
6. **Video / a11y / IndexedDB storage state** — opportunistically.
