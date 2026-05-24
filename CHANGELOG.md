# [0.1.0](https://github.com/dtopuzov/craftdriver/compare/v0.0.3...v0.1.0) (2026-02-08)

## Unreleased

- feat: tracing — `browser.startTrace({ outDir, … })` streams a chronological log of `action` / `console` / `error` / `request` / `response` / `navigation` / `screenshot` events to `outDir/trace.ndjson`, one JSON value per line, written synchronously per event so a thrown `expect` cannot lose data. Screenshots land in `outDir/screenshots/NNNN.png` as captures resolve. `browser.stopTrace()` drains pending captures and writes a closing `meta` line — but is purely cosmetic: partial files left behind by a throwing test (or `browser.quit()`) are still valid NDJSON. Pillars toggled independently (`actions`, `network`, `console`, `screenshots`); screenshots are evidence-driven (one before each action, one on each page error) with `screenshots: 'auto'` default. Actions instrumented: `navigateTo` / `goBack` / `goForward` / `reload` / `setContent` / `click` / `fill` / `clear` / `acceptDialog` / `dismissDialog`. BiDi-only. See [docs/tracing.md](docs/tracing.md).
- feat: `browser.emulate({...})` — override `prefers-color-scheme`, `prefers-reduced-motion`, `forced-colors`, `locale`, `timezoneId`, and `offline` for the current session. `locale` and `timezoneId` use BiDi `emulation.setLocaleOverride` / `setTimezoneOverride` and work cross-browser; media features and `offline` use the BiDi+CDP bridge and are Chromium-only with a clear error on Firefox. See [docs/emulation.md](docs/emulation.md).

- feat: virtual clock — `browser.clock.install()`, `tick()`, `fastForward()`, `setFixedTime()`, `setSystemTime()`, `runFor()`, `uninstall()`. Fakes `Date`, `performance.now`, `setTimeout`, `setInterval`, and `requestAnimationFrame` via an injected shim. Persists across navigations via BiDi preload script. See [docs/clock.md](docs/clock.md).

- feat: accessibility audits — `browser.a11y.audit()` / `check()` plus element-scoped `element.a11y.*` and `locator.a11y.*` wrap axe-core (shipped as a direct dependency — works out of the box). Ergonomic `disableRules: string[]` shorthand, `rules` whitelist, `minImpact` filter, and `axeOptions` escape hatch. `check()` throws an `A11yError` listing every violation with its help URL. See [docs/accessibility.md](docs/accessibility.md).
- feat: full-page screenshots — `browser.screenshot({ fullPage: true })` captures the entire scrollable document via BiDi `browsingContext.captureScreenshot` with `origin: 'document'`. Viewport remains the default. `fullPage` and `selector` are mutually exclusive. See [docs/screenshots.md](docs/screenshots.md).
- feat: history navigation — `browser.goBack()` / `goForward()` / `reload()`, mirrored on `Page`. BiDi `browsingContext.traverseHistory` / `reload` with Classic `/back`, `/forward`, `/refresh` fallback.
- feat: `page.content()` and `browser.content()` return the full document HTML; `page.setContent(html, { waitUntil })` and `browser.setContent(...)` replace the document via a `data:text/html` navigation.
- feat: `browser.setViewportSize({ width, height })` resizes the layout viewport (BiDi `browsingContext.setViewport`) with a Classic `setWindowRect` fallback.
- feat: `browser.grantPermissions([...], { origin?, state? })` and `browser.clearPermissions(...)` over BiDi `permissions.setPermission`. BiDi-only.
- feat: `browser.setGeolocation({ latitude, longitude, accuracy? } | null)` over BiDi `emulation.setGeolocationOverride`. BiDi-only.
- feat: `browser.on('request' | 'response', cb)` — persistent network listeners returning an `off()` function. Sits next to the existing one-shot `waitForRequest` / `waitForResponse`.
- **breaking** (pre-1.0): `element.tag()` renamed to `element.tagName()` for symmetry with `By.tagName()` and the DOM `Element.tagName` property.
- **breaking** (pre-1.0): screenshot APIs converged on a single options-bag form. `browser.screenshot(opts?: { path?, selector?, timeout? })`, `element.screenshot(opts?: { path?, timeout? })`. `browser.saveScreenshot(...)` removed.
- **breaking** (pre-1.0): `KeyboardController` / `MouseController` renamed to `Keyboard` / `Mouse` for Playwright parity. Re-exported from `src/index.ts`.
- feat: `By.text(text, { exact: false })` is now sugar for `By.partialText(text)`. `getByText` and `By.text` share one vocabulary.
- docs: dedicated [docs/dialogs.md](docs/dialogs.md); browser-api dialogs section trimmed to a callout. Attached-vs-visible gloss added to the waiting section. `By.role({ includeHidden })` documented in [docs/selectors.md](docs/selectors.md). `browser.actions()` gets a runnable shift-drag example in [docs/browser-api.md](docs/browser-api.md).
- docs: BiDi-feature matrix added at the top of [docs/bidi-features.md](docs/bidi-features.md), timeout-defaults table added in [docs/browser-api.md](docs/browser-api.md), mobile-emulation Chrome-only callout promoted to the top of [docs/mobile-emulation.md](docs/mobile-emulation.md), cleanup / failure-recovery guidance added to [docs/browser-api.md](docs/browser-api.md).
- feat: re-export `Keyboard` and `Mouse` (was `KeyboardController` / `MouseController`) from [src/index.ts](src/index.ts).
- **breaking** (pre-1.0): remove deprecated aliases `Browser.waitForNewContext()` and `LogMonitor.getConsoleLogs()`. One API per concept; no aliases pre-1.0.
- **breaking** (pre-1.0): rename `By.nameAttr` → `By.name` and `By.tag` → `By.tagName` for parity with Selenium's canonical `By` API.
- **breaking** (pre-1.0): drop `BiDiSession` / `BiDiConnection` from the public surface.
- docs: close coverage gaps — `By.attr` / `dataAttr` / `aria` / `partialText` / `altText` / `title` / `testId` documented in [docs/selectors.md](docs/selectors.md); `getValue` / `getAttribute` get full signature blocks; `actions()` and `isBiDiEnabled()` documented; custom-binary / port configuration via `ChromeService` / `FirefoxService` documented in [docs/getting-started.md](docs/getting-started.md).
- docs: Browser properties table now lists the correct exported types `NetworkInterceptor` / `LogMonitor`.
- feat: Firefox support via geckodriver — `Browser.launch({ browserName: 'firefox' })` spawns geckodriver, negotiates BiDi, and runs the full test suite under `BROWSER_NAME=firefox`. `FirefoxService` exported; respects `GECKODRIVER_PATH` / `GECKODRIVER_FILEPATH`; mobile emulation throws a clear error on Firefox.
- feat: lightweight tracing — `browser.startTrace()` / `stopTrace(path)` write a JSON bundle of console, error, request, response and navigation events plus optional periodic screenshots. BiDi-only. See [docs/tracing.md](docs/tracing.md).
- feat: `browser.activePage()` returns the focused page in `defaultContext` — explicit handle for the implicit target of `browser.click()` / `find()` / etc.
- feat: `BrowserContext` API — real BiDi user contexts (isolated profiles). `browser.newContext()`, `browser.contexts()`, `browser.defaultContext`; `BrowserContext.newPage()`, `pages()`, `waitForPage()`, `close()`. BiDi-only.
- feat: `Page` API — `browser.openPage({ url?, type? })` (BiDi-only), `browser.pages()`, `browser.waitForPage(action)`.
- feat: iframe support — `browser.frame(selector)` returns a `Frame` scoped to the iframe; `browser.frames()` returns all frames.
- feat: dialog handling — `browser.waitForDialog()`, `onDialog()`, `acceptDialog()`, `dismissDialog()`; `Dialog` / `DialogType` types exported.
- feat: configurable default timeouts via `setDefaultTimeout` / `setDefaultNavigationTimeout`.
- feat: composable `Locator` API — `browser.locator()`, `.nth()`, `.first()`, `.last()`, `.filter()`, `.count()`, `.all()`, `browser.findAll()`.
- feat: `browser.evaluate()`, `element.evaluate()`, and `browser.addInitScript()`.
- feat: `browser.waitForResponse()` / `waitForRequest()` for observing network traffic.
- feat: `element.setInputFiles()` for file uploads; `browser.waitForDownload()` for downloads.
- feat: BiDi-first navigation — `navigateTo(url, { waitUntil })`, `waitForLoadState()`, `network.waitForNetworkIdle()`; BiDi enabled by default.



### Features

* mobile emulation ([36ab952](https://github.com/dtopuzov/craftdriver/commit/36ab9527eb8c111565ad80c56e82644b52b39511))
* network and session management ([d23057d](https://github.com/dtopuzov/craftdriver/commit/d23057d94de842e9a670246de0d8190a429a0657))

## [0.0.3](https://github.com/dtopuzov/craftdriver/compare/v0.0.2...v0.0.3) (2026-02-03)


### Bug Fixes

* lint task ([7b83099](https://github.com/dtopuzov/craftdriver/commit/7b8309973f8660f3ec57548c030e6da7cd173748))

## [0.0.2](https://github.com/dtopuzov/craftdriver/compare/v0.0.1...v0.0.2) (2026-02-03)


### Bug Fixes

* improve API consistency and test reliability ([495c49a](https://github.com/dtopuzov/craftdriver/commit/495c49a1fc68451cbdc27298c04d51e5f6c6f016))
