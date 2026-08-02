# [1.12.0](https://github.com/dtopuzov/craftdriver/compare/v1.11.0...v1.12.0) (2026-08-02)


### Features

* **a11y:** audit from the CLI and MCP, with actionable refs ([#63](https://github.com/dtopuzov/craftdriver/issues/63)) ([b27c200](https://github.com/dtopuzov/craftdriver/commit/b27c200c532942e67f6e6a019596528b82912608)), closes [hi#water](https://github.com/hi/issues/water)

# [1.11.0](https://github.com/dtopuzov/craftdriver/compare/v1.10.0...v1.11.0) (2026-08-01)


### Features

* **ai:** ship snapshot-driven agent workflow for skills, CLI, and MCP ([0340ed1](https://github.com/dtopuzov/craftdriver/commit/0340ed1a82a7470d820050e1f110e682a35901ee)), closes [#56](https://github.com/dtopuzov/craftdriver/issues/56)

# [1.10.0](https://github.com/dtopuzov/craftdriver/compare/v1.9.1...v1.10.0) (2026-07-27)


### Features

* polish AI agent onboarding ([#55](https://github.com/dtopuzov/craftdriver/issues/55)) ([ef43498](https://github.com/dtopuzov/craftdriver/commit/ef434988d8f59fdb79e5400f316aeb4d86697be2))

## [1.9.1](https://github.com/dtopuzov/craftdriver/compare/v1.9.0...v1.9.1) (2026-07-25)


### Bug Fixes

* **by): clear error on non-string locator names; feat(locators:** rank stable anchors above dynamic ones ([#53](https://github.com/dtopuzov/craftdriver/issues/53)) ([7f05ed5](https://github.com/dtopuzov/craftdriver/commit/7f05ed5febeb7d8ce1fb2af42e59439638554092))

# [1.9.0](https://github.com/dtopuzov/craftdriver/compare/v1.8.0...v1.9.0) (2026-07-24)


### Features

* add open Shadow DOM support ([#49](https://github.com/dtopuzov/craftdriver/issues/49)) ([fadd962](https://github.com/dtopuzov/craftdriver/commit/fadd962c6d1a583501d9efb7c8117d42ce3710a6)), closes [#40](https://github.com/dtopuzov/craftdriver/issues/40)

# [1.8.0](https://github.com/dtopuzov/craftdriver/compare/v1.7.0...v1.8.0) (2026-07-21)


### Features

* **agent CLI:** add a persistent browser exploration workflow with semantic snapshots, safe temporary refs, live-validated durable locators, manual QA actions, console/network evidence, mocks, traces, and reusable login state ([2a0f079](https://github.com/dtopuzov/craftdriver/commit/2a0f079b327ffd1545fa0f1919e06045e89422dc))
* **auth state:** restore cookies and multi-origin localStorage before the first navigation on BiDi launch and contexts, with path/object inputs and one-time hydration that preserves later application writes
* **sessions:** isolate browsers, cookies, pages, refs, and artifacts in named sessions under a project-scoped daemon
* **MCP:** add a validated stdio tool server with automatic post-action snapshot diffs, bounded responses, and quota-controlled file artifacts for token-efficient context
* **skill:** add a safe project-local CraftDriver skill installer that teaches coding agents to explore first and turn runtime evidence into maintainable tests

### Bug Fixes

* **agent reliability:** fail closed on malformed CLI input, recover failed browser launches, reset browser-owned state on quit, and bound large results, errors, screenshots, and artifact storage
* **auth state:** validate every restore before mutation, quarantine internal hydration pages from public APIs and telemetry, serialize per-context overlays, reject partial Classic launch restores, and make direct state saves atomic and owner-restricted
* **pages:** preserve the active page when closing background tabs and cover page activation/closing in BiDi-enabled non-default contexts

# [1.7.0](https://github.com/dtopuzov/craftdriver/compare/v1.6.0...v1.7.0) (2026-07-18)


### Bug Fixes

* evaluate wait conditions at zero timeout ([68ec2f9](https://github.com/dtopuzov/craftdriver/commit/68ec2f95148b93ba81f29ecc9ba293eef2265f44))


### Features

* add visual testing ([fd6ce7d](https://github.com/dtopuzov/craftdriver/commit/fd6ce7db8fde26c5ffa80bead9514479547c2a62))

# [1.6.0](https://github.com/dtopuzov/craftdriver/compare/v1.5.0...v1.6.0) (2026-07-16)


### Features

* add remote WebDriver support (Selenium Grid, BrowserStack) ([3941250](https://github.com/dtopuzov/craftdriver/commit/3941250fbae8fcbcc64b51ec7fa25a3cc2c2b3f0))

# [1.5.0](https://github.com/dtopuzov/craftdriver/compare/v1.4.0...v1.5.0) (2026-07-14)


### Features

* add desktop Safari support ([9fa9310](https://github.com/dtopuzov/craftdriver/commit/9fa93106346783339e8f0ab9d213f592649f4ff5))

# [1.4.0](https://github.com/dtopuzov/craftdriver/compare/v1.3.0...v1.4.0) (2026-07-12)


### Features

* electron apps support ([f98c242](https://github.com/dtopuzov/craftdriver/commit/f98c2423d4c13d50c28102991e32c463347332f6))

# [1.3.0](https://github.com/dtopuzov/craftdriver/compare/v1.2.0...v1.3.0) (2026-07-11)


### Features

* make traces Playwright and Vibium compatible ([c6c0746](https://github.com/dtopuzov/craftdriver/commit/c6c0746dcecc671d1d6d6cd26badf6a8432a7f37))

# [1.2.0](https://github.com/dtopuzov/craftdriver/compare/v1.1.1...v1.2.0) (2026-07-10)


### Features

* **logs:** always capture console/error logs; remove captureLogs opt-in ([7b4b75a](https://github.com/dtopuzov/craftdriver/commit/7b4b75ab0fc150367be680929be3d283f116e488))

## [1.1.1](https://github.com/dtopuzov/craftdriver/compare/v1.1.0...v1.1.1) (2026-07-09)


### Bug Fixes

* **selectors:** align semantic locator behavior ([2c73b74](https://github.com/dtopuzov/craftdriver/commit/2c73b74d1ba0e18eba1fdadea89b1544fb52f0e7))

# [1.1.0](https://github.com/dtopuzov/craftdriver/compare/v1.0.4...v1.1.0) (2026-07-09)


### Features

* add browserPath to launch a custom browser binary (Chrome/Chromium/Firefox) ([127d11d](https://github.com/dtopuzov/craftdriver/commit/127d11d9db2877d764253c7359c543abcef8fd0c))
* auto-detect CI-provided driver directories (GitHub Actions) ([bcd389f](https://github.com/dtopuzov/craftdriver/commit/bcd389f4e180e32cc034e0ace61898195f8f7837))


### Performance Improvements

* measure CI-detection savings vs the PATH-probe/version-detect fallback ([a64c2df](https://github.com/dtopuzov/craftdriver/commit/a64c2df51f14be71c791b6c4549f5827df9abb2e))

## [1.0.4](https://github.com/dtopuzov/craftdriver/compare/v1.0.3...v1.0.4) (2026-07-09)


### Bug Fixes

* bound session creation with a request timeout ([5b67d24](https://github.com/dtopuzov/craftdriver/commit/5b67d2496293ad174540c33bd827b2b262fc0d5a))
* isolate driver downloads to per-call temp dirs ([11e38ad](https://github.com/dtopuzov/craftdriver/commit/11e38adfb4e65a6b6787cb35f89c2570ed7cd339))

## [1.0.3](https://github.com/dtopuzov/craftdriver/compare/v1.0.2...v1.0.3) (2026-07-07)


### Bug Fixes

* anchor element handle errors at call site ([a2d6cd3](https://github.com/dtopuzov/craftdriver/commit/a2d6cd3ace7402802ea1c48c1b99556677dc246a))
* recover out-of-bounds element pointer moves ([a525914](https://github.com/dtopuzov/craftdriver/commit/a5259144c9ed7c1b0242d3358888fa0ad55838b2))


### Performance Improvements

* extend fast-path pattern to clear(), press(), and hover() ([1807371](https://github.com/dtopuzov/craftdriver/commit/180737148bbe4f2aa43ddcaae3dadc75d5febb08))

## [1.0.2](https://github.com/dtopuzov/craftdriver/compare/v1.0.1...v1.0.2) (2026-07-06)


### Performance Improvements

* optimize fill without implicit click ([4b3c6c6](https://github.com/dtopuzov/craftdriver/commit/4b3c6c6f2976bc95a767ece1979067bb34b46760))

## [1.0.1](https://github.com/dtopuzov/craftdriver/compare/v1.0.0...v1.0.1) (2026-07-05)


### Bug Fixes

* keep wait and page context errors stable ([3746b84](https://github.com/dtopuzov/craftdriver/commit/3746b8437f4261216862eb160c5d214e1351e6cd))
* preserve structured driver error detail ([b14c93f](https://github.com/dtopuzov/craftdriver/commit/b14c93f48727da38d224ca680e642cd0dbe78344))
* surface WebDriver protocol errors as DRIVER_ERROR ([97c9b3a](https://github.com/dtopuzov/craftdriver/commit/97c9b3a264eb70b4686e08b121d690783a8d2e9b))


### Performance Improvements

* share click fast path across click APIs ([2d28d47](https://github.com/dtopuzov/craftdriver/commit/2d28d47c85337f9098c956529f054359e09aa53a))
* try simple optimistic browser click ([f3e0514](https://github.com/dtopuzov/craftdriver/commit/f3e0514ba448c437ba36a457c5cdb8aec4a2c01c))

# [1.0.0](https://github.com/dtopuzov/craftdriver/compare/v0.2.2...v1.0.0) (2026-07-04)


### Bug Fixes

* element handles from findAll()/all() lose their frame/window binding ([518c385](https://github.com/dtopuzov/craftdriver/commit/518c3855de6793ae93eeb605521182d98f77e9cb))
* keep preload-backed navigation on BiDi ([665da10](https://github.com/dtopuzov/craftdriver/commit/665da10f4e76078edaa9e54d76d9b79668553472))
* recover stale chromedriver cache ([b5cc568](https://github.com/dtopuzov/craftdriver/commit/b5cc568cafb6ff63a92e9631ea75a44d480e8ddd))
* retry evaluate() past transient "execution contexts cleared"; dedupe navigate wait mapping ([f23f3b1](https://github.com/dtopuzov/craftdriver/commit/f23f3b1b571163916022a7a7e55f10b17c8c6729))


### Features

* add opt-in browser `args` launch option; document startup flags (PERF-07) ([bef028a](https://github.com/dtopuzov/craftdriver/commit/bef028a1096acf557c784359cdad170031c3638f))


### Performance Improvements

* cache driver resolution to cut Browser.launch() by ~530ms ([e959208](https://github.com/dtopuzov/craftdriver/commit/e959208e94a0b39f193c06bff3dc0ee304db3808))
* classic-first navigation, batched BiDi connect, lazy logs, HTTP keep-alive ([018ea5e](https://github.com/dtopuzov/craftdriver/commit/018ea5e7e2daa47cfea7e9ac3c28a83397f8a82e)), closes [#20](https://github.com/dtopuzov/craftdriver/issues/20)
* drop 3 redundant BiDi session.subscribe round trips (PERF-01) ([db23e8e](https://github.com/dtopuzov/craftdriver/commit/db23e8e7491d98190b39788891290d65e349a6b0))
* lower default auto-wait poll interval 100ms -> 25ms ([2c2b96f](https://github.com/dtopuzov/craftdriver/commit/2c2b96f142278ae5f8cb5f5d150210eb758719c6))
* make assertion and state polling as responsive as element waits ([9f9978b](https://github.com/dtopuzov/craftdriver/commit/9f9978b5a8f9677ad94e72f7d644c2e71ee1b142))
* scope quit() 500ms port-release sleep to Firefox+BiDi ([acbc58e](https://github.com/dtopuzov/craftdriver/commit/acbc58eda6fc14efdcc3138c1edaffa558e48d10))


### BREAKING CHANGES

* console/error messages emitted before the first
  browser.logs / onConsole / onError / waitForConsole call are no longer
  captured by default. Pass captureLogs: true to Browser.launch(), or
  touch browser.logs right after launch, to restore from-launch capture.

  Network subscription stays eager in the same merged connect-time batch
  - resolved with a benchmark A/B rather than a guess: stripping
  network.* events entirely moved the E2E-flow BiDi/Classic ratio from
  0.93x to 0.94x, well under the ~5% bar for "not worth the added
  complexity of going lazy."

- HttpClient now keeps one pooled, keep-alive Agent per endpoint instead
  of opening a fresh TCP connection for every Classic WebDriver command
  (49+ call sites across driver.ts/webelement.ts, no call-site changes
  needed). Driver.quit() destroys the agent in a finally block so pooled
  sockets don't keep the process alive after the session ends. Benefits
  both enableBiDi: true and false equally.

Net result on this machine (localhost Chrome headless, tests/perf/
bidi-vs-classic.perf.ts): E2E-flow BiDi/Classic ratio improved from
1.12x to ~1.05x across repeated runs (0.93x-1.12x observed - BiDi is
sometimes faster than Classic now, not consistently slower). Full test
suite (287 tests) green, lint and build clean.

enableBiDi remains for now as an explicit opt-out; retiring it as a
user-facing flag is tracked as follow-up work once this lands and proves
out, not done in this change.

Fixes: https://github.com/dtopuzov/craftdriver/issues/20

## [0.2.2](https://github.com/dtopuzov/craftdriver/compare/v0.2.1...v0.2.2) (2026-06-29)


### Bug Fixes

* speed up BiDi activePage lookup ([ec0bb1c](https://github.com/dtopuzov/craftdriver/commit/ec0bb1cd16bb26a3115f3b572963cdded03d0680))

## [0.2.1](https://github.com/dtopuzov/craftdriver/compare/v0.2.0...v0.2.1) (2026-06-22)


### Bug Fixes

* bump axe-core ([9b59497](https://github.com/dtopuzov/craftdriver/commit/9b59497f410f779a2341e5729bbf2490b202314f))

# [0.2.0](https://github.com/dtopuzov/craftdriver/compare/v0.1.0...v0.2.0) (2026-05-29)


### Features

* accessibility audits ([0b59957](https://github.com/dtopuzov/craftdriver/commit/0b59957ecb014d32962298de8da939cb873c6380))
* add driver manager ([3f60949](https://github.com/dtopuzov/craftdriver/commit/3f6094918fdaf0e04a8df61d732ea878c215875f))
* AI productivity tooling ([ffac9f0](https://github.com/dtopuzov/craftdriver/commit/ffac9f02d45bc14126e016bd2b7cfac3cf2fb057))
* browser-context ([6ddbc8a](https://github.com/dtopuzov/craftdriver/commit/6ddbc8acf619418987dc2be1613271bcd5ada488))
* browser.emulate ([aefabba](https://github.com/dtopuzov/craftdriver/commit/aefabba9132275d77ad673539c71242affbb47fb))
* ship the May browser automation feature set ([b89f3a6](https://github.com/dtopuzov/craftdriver/commit/b89f3a65b704178b7d984d65af9c12bddbc2d524))
* **tracing:** mimeType + fromCache on response events; final.png on failure ([4b1b293](https://github.com/dtopuzov/craftdriver/commit/4b1b293cd46d9641fa1106c7ae9736a47e418e62))
* **tracing:** streaming NDJSON tracer with on-failure vitest helper ([3c95a4b](https://github.com/dtopuzov/craftdriver/commit/3c95a4b2880ff379668b449a47e422ce74e2cfb3))
* virtual clock ([1d6b0ec](https://github.com/dtopuzov/craftdriver/commit/1d6b0eca4d8f0eed03dc597a3bf443836a206208))

# [0.1.0](https://github.com/dtopuzov/craftdriver/compare/v0.0.3...v0.1.0) (2026-02-08)

### Changes

- docs: refresh the README as a product front door, add a VitePress documentation site with GitHub Pages deployment, add proof pages/launch kit/social card, and add contribution files (issue forms, PR template, code of conduct).
- **breaking** (pre-1.0): BiDi console/error log capture is lazy by default. Messages emitted before the first `browser.logs` / `onConsole` / `onError` / `waitForConsole` touch are no longer captured unless `Browser.launch({ captureLogs: true })` is used to arm logging at launch.
- feat(launch): add `Browser.launch({ args })` for opt-in browser flags, forwarded to `goog:chromeOptions.args` for Chrome/Chromium and `moz:firefoxOptions.args` for Firefox. Craftdriver still sets no performance flags by default.
- perf(bidi): reduce the issue #20 BiDi/Classic per-command regression by routing common `waitUntil: 'load'` navigations through Classic when safe, batching BiDi connect-time work into one parallel `getTree` + `session.subscribe` batch, removing three redundant context-event subscriptions, making log capture lazy, and pooling Classic HTTP connections with keep-alive. New `npm run bench` harnesses cover the light flow, heavier registration-shaped flow, launch critical path, and optional real-app registration flow.
- perf(launch): cache driver auto-resolution for Chrome and Firefox with `CRAFTDRIVER_DRIVER_TTL`, skip the redundant driver `--version` probe for already-resolved absolute driver paths, poll driver readiness at 25 ms, and scope the fixed 500 ms quit delay to Firefox+BiDi only. Benchmarks show `Browser.launch()` about 530 ms faster in both BiDi and Classic modes, concurrent launch batches about 17-20% faster, and Chrome `quit()` about 500 ms faster.
- perf(waiting): lower element/locator auto-wait polling, `expect(...)` assertion polling, Classic ready-state/window/download polling, and driver-readiness polling from 100 ms to 25 ms. Already-satisfied checks still run immediately; only genuine waits become more responsive.
- fix(navigation): keep preload-backed navigations on BiDi so browser/context init scripts are present before the next page script runs, and retry `evaluate()` through transient BiDi "execution contexts cleared" races that can follow Classic-first navigation. Shared BiDi load-state mapping now lives in `src/lib/loadState.ts`.
- fix(elements): element handles returned by `Page.findAll()`, `Frame.findAll()`, `Locator.all()`, and nested `locator().locator()` chains keep their owning frame/window context binding instead of running later operations in whichever context Classic currently has focused.
- fix(driver-manager): stale cached chromedriver auto-resolution now self-heals after a Chrome major-version update. If session creation reports the classic "ChromeDriver only supports Chrome version X" mismatch and the running driver came from the auto-resolution cache, craftdriver clears that metadata entry, stops the stale service, and retries launch once so users do not wait up to the 24h TTL.
- refactor(timing): centralize poll intervals, default timeouts, fixed delays, and retry policy in `src/lib/timing.ts`; route `expect(...)` matchers through one shared polling helper; and DRY the driver-resolution TTL metadata helpers.
- docs: refresh BiDi/protocol guidance, lazy-log docs, driver-resolution performance guidance, route-handler examples, dialog/emulation transport notes, mouse signatures, storage-origin wording, and contributor setup now that drivers auto-download.
- chore(deps): pin the vendored npm used by `@semantic-release/npm` to a version that bundles patched `undici`, clearing the dev/release-tooling finding without changing craftdriver runtime dependencies.
- fix: clamp user-supplied `timeout` and `idleDuration` values passed to `setTimeout` in `waitForNetworkIdle` (network.ts) and `waitForLoadState` (browser.ts) to prevent resource exhaustion from unbounded timer durations. The `ms()` helper in `dispatcher.ts` (the socket→number boundary for the CLI daemon) now also caps at 300,000 ms so the sanitization happens at the untrusted-input boundary rather than deep in the call chain. Caps: 300,000 ms for timeouts, 60,000 ms for idle durations.
- fix(tests): `driver-manager.test.ts` integration test was silently short-circuiting on systems where `chromedriver` is already on `PATH` (ubuntu-latest CI runners, nvm-managed Node envs). The resolution chain hit the PATH probe at step 5 before ever reaching the auto-download step, so nothing was written to the cache directory and the cache assertions failed. Fix: `beforeAll` now filters chromedriver-containing directories out of `PATH` to force the download path; `PATH` is restored in `afterAll`.

- fix(browser-context): `page.context()` now returns `browser.defaultContext` for pages opened via `browser.openPage()` / `browser.waitForPage()` / `browser.pages()` / `browser.activePage()` instead of `undefined`. Previously these pages lived in the default user context at the BiDi layer but had no owner wired up, which meant `page.navigateTo('/foo')` silently ignored the default context's `baseURL`, and the model leaked. New regression test in [tests/browser-context-hooks.test.ts](tests/browser-context-hooks.test.ts).
- fix(browser-context): `browser.contexts()`, `browser.defaultContext`, and `browser.newContext()` now share a single cached `BrowserContext` instance per BiDi user-context id, evicted on context close. Previously `browser.contexts()` minted a fresh wrapper every call, silently losing every `on()` listener, `addInitScript`, and `route()` registration attached to a sibling instance. [src/lib/browser.ts](src/lib/browser.ts).
- chore(browser-context): internal cleanup pass — dropped dead state (`_routeIds`, `_tracking`), parallelized per-page intercept registration in `ctx.route()`, fixed stale jsdoc on `ctx.route()` and `ctx.on()`, and trimmed `docs/browser-context.md` to remove the obsolete "no `storageState` round-trip" callout and a duplicated multi-user-login example. Added a "Scope and precedence (gotchas)" section documenting the `storageState` coverage (cookies + localStorage only — not sessionStorage / IndexedDB), Browser-vs-Context emulation precedence, the service-worker scope of `ctx.route()`, and the non-transactional shape of `grantPermissions`. [docs/browser-context.md](docs/browser-context.md).

- feat: `BrowserContext` identity & device emulation — tight, capability-gated slice. New `browser.newContext({ locale, timezoneId, geolocation })` options plus live setters `ctx.setLocale(locale | null)`, `ctx.setTimezone(timezoneId | null)`, `ctx.setGeolocation(coords | null)`, `ctx.grantPermissions(names, { origin, state? })`, and `ctx.clearPermissions(names, { origin })`. All five are scoped via BiDi `userContexts: [<id>]` / `userContext` so future pages (and popups) inherit automatically with no per-page plumbing. `locale`, `timezoneId`, and `grantPermissions` work on Chrome **and** Firefox; `setGeolocation` is reliable on Chrome and wraps the BiDi error with the engine name on Firefox where coverage is still uneven. A default `browser.newContext()` (no options) remains cross-browser. Out-of-scope by design: per-context `viewport` / `colorScheme` / `reducedMotion` / `userAgent` — those still need either CDP (Chromium-only) or BiDi primitives that aren't broadly shipped. See [docs/browser-context.md](docs/browser-context.md), tests in [tests/browser-context-emulation.test.ts](tests/browser-context-emulation.test.ts).

- feat: `BrowserContext` page-scoped hooks & routing — `ctx.on('page' | 'close', listener)` / `ctx.off(...)` for tab-and-popup observation across every page in a context, `ctx.addInitScript(script)` returning an `InitScriptHandle` with `.id` + `.remove()` (and matching `ctx.removeInitScript(id)`) for per-context preload scripts that don't leak to sibling contexts, `ctx.route(pattern, handler)` / `ctx.unroute(id?)` for context-scoped request mocking (URL substring, `RegExp`, or `**`-aware glob; the handler receives `{ request, fulfill, continue, abort }`), `ctx.setExtraHTTPHeaders(headers)` to swap the per-context header bag at runtime, plus `browser.newContext({ baseURL, extraHTTPHeaders })` options so `ctx.newPage({ url: '/login' })` resolves against the context's base URL and every outbound request carries the configured headers. Adds `page.context()` so a `Page` can reach back to its owning `BrowserContext`. Routes are registered per BiDi browsing context (and re-registered on every new page), which is what makes Firefox honour them under a non-default `userContext`. Works on Chrome **and** Firefox via BiDi. New exported types `BrowserContextConfig`, `BrowserContextHooks`, `InitScriptHandle`, `RoutePattern`. See [docs/browser-context.md](docs/browser-context.md), tests in [tests/browser-context-hooks.test.ts](tests/browser-context-hooks.test.ts).

- feat: `BrowserContext` cookies + storage state — `ctx.cookies(urls?)`, `ctx.addCookies(cookies)`, `ctx.clearCookies(filter?)`, `ctx.storageState(opts?)`, `ctx.saveStorageState(path, opts?)`, `ctx.loadStorageState(source)`, and `browser.newContext({ storageState })`. All operations are scoped to the user context via the BiDi `storageKey` partition; localStorage is restored on first navigation through an internal preload script bound to the user context. Enables the auth-fixture pattern (log in once, save to JSON, reuse across tests) and proper multi-user isolation. Works on Chrome **and** Firefox. New exported types `ClearCookiesFilter`, `ContextStorageStateOptions`. See [docs/browser-context.md](docs/browser-context.md), tests in [tests/browser-context-storage.test.ts](tests/browser-context-storage.test.ts).

- chore(tests): drop the `bidi-` filename prefix on the four BiDi-specific test files (`bidi-network` → `network`, `bidi-logs` → `logs`, `bidi-load-state` → `load-state`, `bidi-storage` → `storage`). The prefix dates back to when those were the only BiDi tests; today most tests are BiDi-only (BiDi is default-on) and the inconsistent prefix actively misled readers. BiDi-ness is now treated as an implementation detail of the feature, not a test category. Renamed via `git mv` so blame survives. Updated [.github/instructions/tests.instructions.md](.github/instructions/tests.instructions.md) accordingly. Also renamed the non-test helper `tests/auto-trace.ts` → `tests/_auto-trace.ts` so it sorts to the top of the directory and reads as "not a test" at a glance.
- test: smoke tests for the MCP server in [tests/mcp-smoke.test.ts](tests/mcp-smoke.test.ts) — spawn `node bin/craftdriver.mjs mcp` as a child process, speak JSON-RPC 2.0 over its stdio (no LLM required — MCP is a deterministic protocol), and assert on the protocol surface. Three cases: `tools/list` returns the 14 documented tools by name, `browser_navigate` + `browser_snapshot` against [examples/login.html](examples/login.html) yields refs for the known form controls, and `browser_click` on a missing selector returns `isError: true` with a stable `structuredContent.error.code`.
- test: smoke tests for the CLI binary in [tests/cli-smoke.test.ts](tests/cli-smoke.test.ts) — spawn `node bin/craftdriver.mjs --ephemeral` as a child process, pipe a script of commands via stdin, and assert on the JSON-per-line output. Three cases: a full login flow against [examples/login.html](examples/login.html), a `snapshot` call that verifies refs + roles for known controls, and an error-code path that confirms `exists`/`text` against a missing selector returns `ok:false` with `code: NO_MATCH` plus a non-zero exit. Requires `npm run build` first (the bin shim loads `dist/cli/index.js`).
- docs: align README / docs / skill on the three AI-agent surfaces (CLI, skill pack, MCP) and `craftdriver init` rules files. Fixed stale "13 tools" copy in [README.md](README.md), [docs/mcp.md](docs/mcp.md), and [skills/craftdriver/SKILL.md](skills/craftdriver/SKILL.md) — MCP exposes 14 tools. Added a Skill pack subsection to [README.md](README.md) and [docs/cli.md](docs/cli.md) so the tarball-shipped `skills/craftdriver/` files are discoverable from the front door.

- feat: sanitized DOM snapshot with refs — `craftdriver snapshot` (CLI) and `browser_snapshot` (MCP tool) return a flat accessibility-tree summary of the active page where each visible interactive element gets a stable ref (`e1`, `e2`, …). Use `ref=eN` as a selector for the next command and refs auto-resolve to the right DOM node (`[data-craftdriver-ref="eN"]`) with full auto-wait — no selector hallucination, no per-element `find` round-trips, and 5-char selectors instead of 26-char `role=button[name=…]` expressions. Refs invalidate on the next snapshot or navigation; stale refs fail with `NO_MATCH`. The same renderer powers the post-action snapshot diff in MCP, so refs in the diff are usable in the very next call. Inspired by [Playwright CLI](https://playwright.dev/agent-cli/introduction). [src/cli/snapshot.ts](src/cli/snapshot.ts), [src/cli/selector.ts](src/cli/selector.ts).

- feat: MCP server — `craftdriver mcp` runs a stdio JSON-RPC 2.0 server speaking [Model Context Protocol](https://modelcontextprotocol.io) `2024-11-05`, so MCP-aware hosts (Claude Desktop / Code, Cursor, Windsurf, Zed, Goose, Gemini CLI) can drive a real browser without spawning a CLI per turn. 14 schema-typed tools (`browser_navigate`, `browser_click`, `browser_fill`, `browser_press`, `browser_hover`, `browser_find`, `browser_exists`, `browser_wait`, `browser_read`, `browser_pages`, `browser_snapshot`, `browser_screenshot`, `browser_status`, `browser_advanced_eval`) share the dispatcher and selector syntax with the CLI; mutating tools additionally return a **compact a11y snapshot diffed from the previous turn** (≤ 80 nodes, ref + role + accessible name + locator hint, full snapshot on first call / URL change, set-difference thereafter) so the agent sees what the action changed without a follow-up read. Errors come back as MCP `isError: true` content with the stable `code` field in `structuredContent.error.code`; JSON-RPC `error` is reserved for protocol-level failures. **Token-efficient artifact spilling** ([src/cli/mcp/artifacts.ts](src/cli/mcp/artifacts.ts)) writes screenshots, large snapshots, and large tool results to a per-session directory (`<tmpdir>/craftdriver-mcp-<pid>-<stamp>/`) instead of inlining them as content blocks — the agent gets a short preview plus the absolute path, paying no image tokens for screenshots and bounded text tokens for everything else. Configurable via `$CRAFTDRIVER_MCP_ARTIFACTS_DIR` and `$CRAFTDRIVER_MCP_SPILL_BYTES` (default 2 KB). Hand-rolled (no `@modelcontextprotocol/sdk` dep) — [src/cli/mcp/server.ts](src/cli/mcp/server.ts), [src/cli/mcp/tools.ts](src/cli/mcp/tools.ts), [src/cli/snapshot.ts](src/cli/snapshot.ts). See [docs/mcp.md](docs/mcp.md).

- feat: `craftdriver init <flavor>` — writes a short, opinionated agent-guide file into the current project so AI assistants pick up craftdriver conventions (selector preference, auto-waiting, error codes, CLI usage) on every turn. Flavors: `agents` (`AGENTS.md`), `copilot` (`.github/copilot-instructions.md`), `claude` (`CLAUDE.md`), `cursor` (`.cursor/rules/craftdriver.mdc` with frontmatter), `gemini` (`GEMINI.md`), `all`. One shared body, N filenames — [src/cli/init.ts](src/cli/init.ts). `--force` overwrites, `--dry-run` previews. Per-project by design; never writes to a user's home directory.
- docs: CLI section in [README.md](README.md) plus dedicated [docs/cli.md](docs/cli.md) reference and an agent-facing [skills/craftdriver/cli.md](skills/craftdriver/cli.md). `docs/` and `skills/` are now shipped in the npm tarball alongside `dist/` and `bin/` so installs of `craftdriver` carry their own docs and SKILL pack for in-repo agents. Added `cli`, `agent`, `ai` keywords and wired `--version` to print the package version.
- feat: agent-first CLI v1 — new `craftdriver` binary (re-exported via `bin/craftdriver.mjs`, wired through `package.json#bin`) wraps the public Browser API for shell agents and humans. Daemon mode keeps a long-lived browser behind a Unix-domain socket at `~/.craftdriver/sock` (override with `$CRAFTDRIVER_SOCKET`) so successive commands share state; `--ephemeral` reads a command-per-line script from stdin in a single short-lived session for sandboxed cloud agents. Default per-call timeout is 5 s on the agent surface (vs. 30 s in the library); override with `--timeout` or `$CRAFTDRIVER_AGENT_TIMEOUT`. Selectors follow `kind=value` syntax (`css=`, `xpath=`, `role=button[name=Submit]`, `text=Sign In`, `label=`, `placeholder=`, `testid=`, …); CSS is the default when no prefix is given. Output is JSON when stdout is piped, pretty when on a TTY (force with `--json` / `--pretty`). Commands: `go`, `find` (with `--all/--limit/--offset` and stable `next_offset`), `click`, `fill`, `press`, `hover`, `text`, `attr`, `value`, `is`, `wait`, `exists` (0-wait probe, exit 1 when missing), `pages`, `screenshot`, `eval`, `back`/`forward`/`reload`/`status`/`quit`, `daemon start|status|stop`. Every error carries the existing stable `code` field plus a one-line `hint:`. Run `npm run build` then `craftdriver --help`.
- feat: stable, machine-readable error codes — every error thrown from the public API is now a `CraftdriverError` (re-exported from [src/index.ts](src/index.ts)) carrying a stable `code`, JSON-serializable `detail`, and an optional `hint`. Codes distinguish the three common probe failures (`NO_MATCH` vs `TIMEOUT_WAITING_VISIBLE` vs `TIMEOUT_WAITING_STATE`) plus `TIMEOUT_WAITING_LOAD`, `EXPECT_MISMATCH`, `EVAL_THREW`, `EVAL_BAD_ARG`, `INVALID_ARGUMENT`, `UNSUPPORTED`, `STATE_INVALID`, `A11Y_VIOLATIONS`, and more. `instanceof Error` still holds; existing message-based catches keep working. `A11yError` now extends `CraftdriverError`. See [docs/error-codes.md](docs/error-codes.md).
- feat: generated [docs/api-reference.md](docs/api-reference.md) — one canonical table of every public symbol re-exported from [src/index.ts](src/index.ts), produced by `scripts/gen-api-reference.mjs`. Run `npm run docs:api` to regenerate; `npm run docs:api:check` and the vitest guard `tests/api-reference.test.ts` fail when the file is out of sync.
- feat: tiered agent-facing SKILL content under `skills/craftdriver/` — `SKILL.md` (always-on, ≤ 500 tokens, decision rules + pointers), `cheatsheet.md` (command-by-command reference for writing tests), `patterns.md` (worked recipes for login / upload / network-wait / a11y / tracing / clock).
- chore: `Locator` simple-path shortcut removed in favour of a single polling code path. No public behaviour change beyond improved error-code accuracy.

- feat: tracing — `browser.startTrace({ outDir, … })` streams a chronological log of `action` / `console` / `error` / `request` / `response` / `navigation` / `screenshot` events to `outDir/trace.ndjson`, one JSON value per line, written synchronously per event so a thrown `expect` cannot lose data. Response events include `mimeType` and `fromCache` when available. Screenshots land in `outDir/screenshots/NNNN.png` as captures resolve. `browser.stopTrace()` drains pending captures and writes a closing `meta` line — but is purely cosmetic: partial files left behind by a throwing test (or `browser.quit()`) are still valid NDJSON. Pillars toggled independently (`actions`, `network`, `console`, `screenshots`); screenshots are evidence-driven (one before each action, one on each page error) with `screenshots: 'auto'` default. Actions instrumented: `navigateTo` / `goBack` / `goForward` / `reload` / `setContent` / `click` / `fill` / `clear` / `acceptDialog` / `dismissDialog`. BiDi-only. See [docs/tracing.md](docs/tracing.md).
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
- docs: feature-availability notes added to the browser capability docs, timeout-defaults table added in [docs/browser-api.md](docs/browser-api.md), mobile-emulation Chrome-only callout promoted to the top of [docs/mobile-emulation.md](docs/mobile-emulation.md), cleanup / failure-recovery guidance added to [docs/browser-api.md](docs/browser-api.md).
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

- mobile emulation ([36ab952](https://github.com/dtopuzov/craftdriver/commit/36ab9527eb8c111565ad80c56e82644b52b39511))
- network and session management ([d23057d](https://github.com/dtopuzov/craftdriver/commit/d23057d94de842e9a670246de0d8190a429a0657))

## [0.0.3](https://github.com/dtopuzov/craftdriver/compare/v0.0.2...v0.0.3) (2026-02-03)

### Bug Fixes

- lint task ([7b83099](https://github.com/dtopuzov/craftdriver/commit/7b8309973f8660f3ec57548c030e6da7cd173748))

## [0.0.2](https://github.com/dtopuzov/craftdriver/compare/v0.0.1...v0.0.2) (2026-02-03)

### Bug Fixes

- improve API consistency and test reliability ([495c49a](https://github.com/dtopuzov/craftdriver/commit/495c49a1fc68451cbdc27298c04d51e5f6c6f016))
