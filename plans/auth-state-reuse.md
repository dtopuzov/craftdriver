# Auth-state reuse implementation plan

This is the canonical implementation handoff. See
`auth-state-reuse-analysis.md` for the investigation and comparison with the
earlier proposals.

## Progress (branch feat/ai-tools, completed 2026-07-21)

Implemented:

- **Secure state-file persistence.** `saveState` / `saveStorageState` write via a
  shared library writer (`src/lib/secureFile.ts`): parent dir created,
  destination symlink refused, same-directory `0600` temp file, atomic rename.
  Unit-tested.
- **One-time BiDi hydrator.** The per-navigation localStorage preload is retired;
  each captured origin is seeded once via a private, network-intercepted
  same-origin document, then the context owns the values. Both
  `newContext({ storageState })` and BiDi `Browser.launch({ storageState })` now
  restore cookies **and** localStorage. Contract tests cover first-script
  visibility, mutation-survives-reload, multi-origin, and launch-time restore;
  the browser-context and storage suites are green. (Correction: the recipe
  suite is **excluded from the default vitest run** and only executes under
  `vitest.recipes.config.ts` — it was not actually exercised by that first
  pass, and its stale launch-path assertion is fixed in the validation tranche.)
  - Two constraints proved in code and encoded as comments: the intercept must
    use a **specific** URL pattern (a bare `**/*` does not register a working
    intercept), and the private page must navigate over **BiDi** (a Classic
    navigation stalls against a BiDi intercept).

Validation and hardening: one shared validator runs before
any mutation (unknown/legacy sections rejected, not ignored); the
operation-specific sessionStorage policy above; a strict hydration intercept
with zero network fall-through; localStorage-before-cookies apply order; failed
`newContext` cleanup; and the `writeSecureFile` lstat fix. Verified on Chrome +
Firefox, the recipe (both engines), and the CLI auth-state suite.

**Private-context invisibility hardening** (§3): the hydration
context is quarantined from page tracking (quarantine-and-replay of
`contextCreated`, since the event can beat the create response), so even a
`loadStorageState` on an already-active context with a `'page'` listener or a
route never surfaces the private tab, adds it to `pages()`, or registers user
routes on it. CraftDriver-managed init scripts, browser-global mocks, logs,
network observers, waiters, active-page shortcuts, screenshots, and traces also
exclude it. This invisibility contract covers CraftDriver's public surfaces;
consumers that deliberately subscribe to the raw BiDi connection are outside
that abstraction boundary.

**Classic active-origin fallback** (§5): `browser.loadState()` now validates the
whole snapshot, requires one matching active HTTP(S) origin, verifies every
cookie before mutation, and then restores strictly. Classic launch rejects
non-empty state with `UNSUPPORTED`; empty state is a no-op.

**Docs, CLI, and agent skills** (§6): the recipe uses
`Browser.launch({ storageState })` again, the CLI loads before navigation on
BiDi, Classic/sessionStorage retain the active-origin sequence, and the API,
support matrix, error codes, changelog, cheatsheet, and skill references agree.

Verified in this workspace:

- Chrome BiDi: hydrator, path/object launch inputs, browser/context storage,
  one-time and multi-origin behavior, invisibility, failure policy, recipe, and
  CLI suites pass.
- Firefox BiDi: the same suites pass. Multi-file Firefox runs use one Vitest
  worker because this repository's shared geckodriver service accepts only one
  session at a time.
- Chrome Classic and Firefox Classic: strict active-origin and launch-rejection
  tests pass.
- Build, ESLint, generated API reference, VitePress docs build, secure-file
  tests, CLI parsing/state-store tests, and the 20-case skill installation gate
  pass.

Chromium uses the same Chrome-family BiDi implementation, but the local
Chromium binary still cannot be launched by the available chromedriver (the
pre-existing capability mismatch recorded under Spike evidence). Safari is
covered by the Classic contract but was not integration-run here. No optional
CDP adapter was retained: the standards-based BiDi path already meets the MVP
contract, and CDP would add a version-sensitive second implementation without
unlocking a proven requirement.

## Product decision

Deliver an excellent “login once, reuse in other tests” experience first on
Chrome/Chromium with WebDriver BiDi, which is CraftDriver’s default path.

Do not reduce that experience to what the least-capable browser or WebDriver
Classic can support. Reuse the standards-based path on Firefox BiDi when its
required commands pass real integration tests. Give Classic users a smaller,
honest active-origin fallback. Safari remains Classic-only.

Every supported combination must be documented and tested. Unsupported
combinations must fail before deterministic state mutation with a structured,
actionable error; they must never silently restore only part of a state file.

Implement the MVP in this file only. Everything under “Deferred” is out of
scope.

## User-facing contract

These become equivalent full restores on supported BiDi sessions:

```ts
const browser = await Browser.launch({ storageState: '.auth/alice.json' });

const context = await browser.newContext({
  storageState: '.auth/alice.json',
});

await browser.defaultContext.loadStorageState('.auth/alice.json');
```

The state must be ready before the first real navigation:

```ts
const browser = await Browser.launch({ storageState: '.auth/alice.json' });
await browser.navigateTo('https://app.example.com/dashboard');
// Cookies and localStorage were both visible to the page's first author script.
```

Broaden all library restore entry points to accept either a path or an in-memory
`SessionState` object:

- `Browser.launch({ storageState })`
- `browser.loadState(source)`
- `browser.newContext({ storageState })`
- `BrowserContext.loadStorageState(source)`

The CLI continues to resolve its named state file and then uses the same library
restoration path.

### Fixed state semantics

- Restore is an overlay, preserving current behavior.
- A listed cookie replaces a cookie with the same identity.
- A listed localStorage key replaces the value with the same name.
- Cookies and localStorage keys absent from the snapshot are not cleared.
- A fresh browser/context behaves like an exact fixture because it starts empty.
- localStorage is seeded once. Application changes must survive reload.
- `storageState` covers cookies and localStorage only.
- State uses CraftDriver’s native JSON shape; Playwright JSON compatibility is
  not implied.

A future clear-and-replace API is deferred.

### sessionStorage policy (operation-specific, decided 2026-07-21)

sessionStorage is tab-scoped, so a private hydration page cannot transfer it to
the caller's future pages. The policy therefore depends on the operation, and
unknown/unsupported sections are never silently ignored:

- **Active-page APIs** — `browser.loadState()`, `browser.storage.setState()`,
  and the CLI `state load` — **preserve** non-empty sessionStorage restoration
  (an existing documented feature behind `--session-storage`). They require a
  matching active HTTP(S) origin and a single applicable origin, and fail
  **before mutation** on a mismatch or on multi-origin sessionStorage.
- **Context/launch APIs** — `Browser.launch({ storageState })`,
  `browser.newContext({ storageState })`, and `BrowserContext.loadStorageState()`
  — **hard-error `UNSUPPORTED` before any cookie/localStorage mutation** when the
  state contains non-empty sessionStorage, because their private hydration page
  cannot carry tab-scoped sessionStorage to future pages.
- An empty `sessionStorage: {}` is a **no-op**, never an error.
- `browser.loadState()` on a BiDi session routes through the validated hydrator
  when the state has no sessionStorage, and through the active-page path when it
  does. Local launch, remote BiDi launch, and `newContext` share that one
  validated hydrator. All library restore inputs accept a path **or** an
  in-memory `SessionState` object.

## Browser and transport support policy

The implementation records the verified result in this matrix before merging:

| Surface | Chrome/Chromium BiDi | Firefox BiDi | Chrome/Chromium Classic | Firefox Classic / Safari |
| --- | --- | --- | --- | --- |
| `Browser.launch({ storageState })` | Full cookies + multi-origin localStorage; MVP release gate | Use the same BiDi path if its integration suite passes; otherwise fail `UNSUPPORTED` | Baseline: reject non-empty state at launch. May become full support only through the optional CDP gate below | Reject non-empty state at launch |
| `browser.newContext({ storageState })` | Full, isolated restore; MVP release gate | Full if the BiDi suite passes; otherwise `UNSUPPORTED` | Unavailable: Classic has no user contexts | Unavailable |
| `BrowserContext.loadStorageState()` | Full multi-origin overlay | Full if the BiDi suite passes; otherwise `UNSUPPORTED` | Unavailable | Unavailable |
| `browser.loadState()` after launch | Full multi-origin overlay | Full if the BiDi suite passes; otherwise `UNSUPPORTED` | Active-origin-only fallback, or the optional CDP fast path | Active-origin-only fallback |
| Save state | Existing cookie behavior; localStorage capture limitations remain documented | Same | Cookies plus current page origin | Cookies plus current page origin |

Definitions:

- **Full** means cookies plus all captured HTTP(S) localStorage origins, with no
  caller navigation prerequisite.
- **Active-origin-only** means the caller has already navigated to an HTTP(S)
  page and every localStorage origin and cookie is applicable there.
- Firefox support is evidence-based, not hidden behind a permanent
  browser-name block. An “unknown command” or “unsupported operation” from the
  required BiDi setup may produce `UNSUPPORTED`; unrelated implementation bugs
  must still fail the test.
- Remote sessions follow their negotiated transport and demonstrated command
  support. Do not assume that a browser name guarantees that a Grid/provider
  proxies every required BiDi or Chromium-vendor command.
- Electron is not part of the MVP support claim. It may inherit a working
  Chromium path only after its own integration test proves the relevant origin
  and context behavior.

Firefox parity is desirable but does not block the first release if the browser
lacks a required command. Chrome/Chromium BiDi correctness does block it.

## Spike evidence (2026-07-21)

Spike #1 proved the load-bearing mechanism on **chrome**: a BiDi context-scoped
intercept fulfilling a **top-level** navigation via `network.provideResponse`
yields a scriptable, correct-origin document whose `localStorage` persists into
a later **real** same-origin navigation in another tab of the same user
context. **15/15 iterations, top-level intercepted every time.** Per-origin
hydration cost (create private tab → scoped intercept → BiDi navigate → fulfill
→ set localStorage → close): **p50 ≈ 340 ms, p95 ≈ 640 ms** headless. Chromium
could not launch on the spike box (chromedriver capability mismatch, not a
mechanism failure) — same engine, confirm in CI. Firefox stays evidence-based
per the support matrix.

Two constraints the spike surfaced, now load-bearing:

1. **Scope the intercept to the private context's id.** `network.mock`/
   `intercept` otherwise scopes to the context active at install time
   (`src/lib/bidi/network.ts` ~line 174), so a page created afterward is not
   covered and its navigation escapes to the real network. Create the private
   context first, then intercept `[privId]`.
2. **Navigate the private page over BiDi, never the Classic `load` fast path.**
   Scoped intercept + Classic navigation hung; scoped intercept + BiDi navigate
   passed 15/15. (See the protocol-seam note on hydrator step 5.)

Perf budget for the acceptance gate: hydration adds ~0.3–0.7 s per captured
origin at launch. Record the measured number against baseline in the PR and keep
single-origin restore within a documented budget — this repo makes no perf claim
without numbers.

## Architecture

### 1. One parser and one dispatcher

Create one library-level parser/validator and one restoration dispatcher. Route
all entry points through them; do not keep separate launch, context, CLI, and
Classic interpretations of the same state.

The dispatcher chooses an internal strategy from the actual session:

1. standards-based BiDi origin hydrator
2. Classic active-origin hydrator
3. optional Chromium CDP hydrator, but only if it passes the gate below

Strategy selection and capability setup happen before browser state is changed.
Do not catch an arbitrary restore failure and retry through a different strategy
after mutation may have started.

Serialize restore operations per target user context so two concurrent calls
cannot race their overlays, private contexts, or cleanup. Different user
contexts may restore concurrently.

### 2. Standards-based BiDi origin hydrator

WebDriver BiDi can set cookies out of band, but it has no equivalent command for
localStorage. Hydrate localStorage through a private same-origin document:

1. Parse and validate the complete state.
2. Return immediately for a valid empty state.
3. Create one private top-level browsing context in the target user context.
4. Install a `network.addIntercept` scoped to that private context before any
   target-origin navigation.
5. For every captured HTTP(S) origin, sequentially navigate the private context
   to a deterministic URL on that origin **over BiDi**
   (`browsingContext.navigate`), never the default-context Classic `load` fast
   path. A Classic-initiated navigation combined with a BiDi intercept stalls
   (measured — see Spike evidence); the private page must navigate on the same
   protocol that holds the intercept. This is a protocol-mixing seam — name the
   barrier in code.
6. Fulfill the main document locally with a minimal empty HTML response via
   `network.provideResponse`. Never let this navigation reach the real network.
7. Verify that the resulting `location.origin` exactly matches the requested
   origin. Fail rather than seed the wrong origin after an HSTS upgrade or
   other browser rewrite.
8. Set the listed localStorage keys once using structured script arguments.
9. Apply cookies to the target user-context storage partition.
10. Remove the intercept and close the private context in `finally`.
11. Resolve the public API only after hydration and cleanup complete.

Install the intercept before cookie/localStorage mutation so unsupported network
interception is discovered as early as possible. Applying cookies last also
avoids changing them when origin hydration cannot start.

Do not retain `script.addPreloadScript` for storage restoration. A retained
preload replays state on every new document and incorrectly overwrites
application changes after reload.

Use the same BiDi hydrator for the default and isolated user contexts. Context
partitioning must be explicit for cookies and page creation.

### 3. Private-context invisibility

The internal context id must be classified as private before its
`browsingContext.contextCreated` event reaches CraftDriver’s public
abstractions. Because the event may arrive before the create command returns
the id, quarantine top-level context-created events for that user context while
an internal create is in flight. Once the response supplies the id, suppress
the matching event and replay any unrelated quarantined events in order. Route
all CraftDriver-owned page creation through the same coordinator so concurrent
user page creation cannot be mistaken for the private context.

The private context must not:

- appear in `browser.pages()` or `context.pages()`
- satisfy `browser.waitForPage()` or `context.waitForPage()`
- emit public page-created/page-closed events
- enter `_pageIds`, active-page selection, or Browser shortcut targeting
- receive user `route()` handlers or extra headers
- appear in user traces, screenshots, videos, or other artifacts

Use a dedicated low-level internal-context path. Do not call public `newPage()`
and attempt to hide the page afterward.

### 4. Startup barrier and cleanup ownership

- `Browser.launch()` does not resolve until restore and cleanup finish. Its
  existing failure path must quit the whole session.
- `browser.newContext()` does not resolve until restore finishes. If restore
  fails, remove the newly created user context before rethrowing.
- Loading into an existing context also waits for cleanup before resolving or
  rejecting.

Fresh launch/context restore is effectively transactional because the entire
new session/context is discarded on failure.

An overlay into an existing, already-used context cannot be made fully
transactional across several browser protocol calls. Validate every
deterministic condition before mutation, but if a transport/browser failure
occurs after mutation begins:

- perform best-effort internal cleanup
- throw `DRIVER_ERROR`
- include `phase` and `partialApplied: true|false` in structured detail
- document that callers needing failure isolation should restore into a fresh
  context

Do not claim rollback unless an implementation actually proves and tests it.

### 5. Classic active-origin fallback

Keep a useful standards-only fallback for Chrome/Chromium, Firefox, and Safari
Classic:

1. Parse and validate the whole state first.
2. Require the active document to have an HTTP(S) origin.
3. Require every localStorage origin to equal the normalized active origin.
4. Require every cookie to be settable for the active document under WebDriver
   Classic domain/secure rules.
5. Only then overlay localStorage and cookies.

State with multiple origins, a mismatched cookie domain, or `about:blank` fails
before mutation. Do not preserve the current behavior that silently skips an
invalid-cookie-domain error specifically during state restore. The general
`storage.setCookies()` API may retain its existing best-effort behavior; the
strict restore path must not use that behavior.

This fallback makes `browser.loadState()` useful after explicit navigation. It
does not make launch-time restore possible in standards-only Classic mode.

### 6. Optional Chromium CDP gate

Do not make CDP a prerequisite for the BiDi MVP. Before adding a Chromium-only
fast path, run a focused proof that establishes all of the following:

- `DOMStorage.setDOMStorageItem` can seed arbitrary HTTP(S) origins before the
  first real navigation
- cookies can be restored out of band
- writes land in the correct default or isolated BiDi user context
- no real network request or public page is created
- local Chrome/Chromium behavior is stable across the project’s supported
  browser versions
- Classic ChromeDriver can expose the required vendor endpoint without
  weakening the remote-session boundary

Adopt the CDP adapter only if the proof either:

- unlocks full Chrome/Chromium Classic launch-time restore, or
- demonstrates a meaningful measured reliability/performance improvement over
  the BiDi private-context path

The adapter must preserve the exact public semantics, errors, validation, and
cleanup contract. It must be capability-gated, not selected by browser name
alone. Treat the experimental CDP DOMStorage surface as version-sensitive and
fall back only when capability setup fails before mutation. Record the proof and
benchmark in the PR. If any condition fails, delete the spike and ship the
standards-based Chromium BiDi path.

## State validation and compatibility

Validate the entire input before choosing or running a mutation strategy:

- valid JSON when loaded from a path
- a plain top-level object
- only supported top-level fields
- a cookie array with valid names, values, domains, paths, same-site values,
  booleans, and finite expiry values
- a localStorage origin map whose keys are canonical HTTP(S) origins
- string localStorage keys and values
- a valid sessionStorage origin map when present; its operation-specific restore
  policy is applied only after the complete state validates
- no legacy `origins` field or unknown future section

Treat syntactically valid but unsupported sections as `UNSUPPORTED`, not as
fields to ignore. Update the public `SessionState` type so it no longer promises
that ignored fields are restorable. Opt-in `sessionStorage` snapshots are
reusable only through the single-origin active-page APIs described above; they
are rejected by context and launch `storageState` APIs.

Centralize cookie normalization. A snapshot emitted by CraftDriver must be
reloadable by the same supported browser. Add regression coverage for
`sameSite: 'none'` plus insecure cookies and remove the current disagreement
between the launch/session manager and BrowserContext restore paths. Do not
silently change cookie semantics differently in different entry points.

Use existing machine-readable error codes consistently:

- `INVALID_ARGUMENT` — malformed JSON/native schema or invalid values
- `UNSUPPORTED` — unsupported section, browser, transport, or origin count
- `STATE_INVALID` — valid state cannot be applied to the current Classic origin
- `DRIVER_ERROR` — failure after a supported protocol operation begins

Include at least `feature: 'storageState'`, operation, browser name, negotiated
protocol, phase, and safe origin/section information in `detail`. Never include
cookie values, localStorage values, passwords, or tokens in messages, hints,
results, traces, or normal logs.

## Safe state-file persistence

Create one library-level file writer and use it from both
`SessionStateManager.saveState()` and `BrowserContext.saveStorageState()`:

- create the parent directory
- refuse an unexpected destination symlink
- write a same-directory temporary file
- request owner-only permissions (`0600`) where supported
- atomically rename it over the destination
- remove the temporary file after failure

Do not import the CLI state-store module into the public library. Avoid
dependency cycles and test Windows behavior without assuming POSIX permissions.

## Implementation phases

### Phase 1 — Contract and capability tests

Write failing Chromium BiDi tests first:

- launch-path cookies and localStorage
- localStorage visible to the first author script
- mutation surviving reload
- two HTTP origins
- default-context and isolated-context parity
- path and in-memory `SessionState` inputs
- overlay behavior in an existing context
- serialization of concurrent restores in one context, without preventing
  independent contexts from restoring concurrently
- private-context invisibility across pages, events, waiters, routes, active
  page, traces, and artifacts
- cleanup after intercept, navigation, script, or cookie failure
- new user-context removal after restore failure
- malformed/unsupported input failing before deterministic mutation
- live-context protocol failure reporting `partialApplied`
- empty-state no-op

Then run the same standards-path tests on Firefox BiDi. If a required command is
genuinely unsupported, replace only those integration expectations with a
specific `UNSUPPORTED` contract and record the browser/version and command in
the PR. Do not broadly skip the suite.

Add Classic tests for:

- successful active-origin restore
- rejection on `about:blank`
- rejection of multiple/mismatched origins and cookies before mutation
- Chrome/Chromium and at least one non-Chromium Classic engine in available CI

Likely files:

- `tests/browser-context-storage.test.ts`
- `tests/storage.test.ts`
- `tests/recipes/login-once-reuse-session.test.ts`
- `tests/cli/auth-state.test.ts`
- `tests/safari-guards.test.ts`

### Phase 2 — Shared parser, dispatcher, and BiDi hydrator

Implement the native schema parser, capability-aware dispatcher, private
context registry, intercepted origin hydration, context-partitioned cookies,
startup barrier, cleanup ownership, and structured errors.

Route launch, runtime, context, and CLI state restoration through it. Remove the
storage preload path and update navigation checks that existed only to preserve
that preload.

### Phase 3 — Classic fallback

Implement the strict active-origin strategy without changing the public
best-effort semantics of unrelated cookie APIs. Add clear remediation hints:
enable BiDi for full restore, or navigate to the sole origin before loading.

### Phase 4 — Optional Chromium CDP proof

Run the gate above. Keep an adapter only when all conditions pass. This phase
must not delay or destabilize the required Chromium BiDi implementation.

### Phase 5 — Secure persistence

Introduce the shared atomic owner-restricted writer and migrate both direct
library save paths.

### Phase 6 — Documentation, CLI, and agent skills

- Return the main recipe to the simple
  `Browser.launch({ storageState: '.auth/state.json' })` form.
- Remove the claim that launch restores cookies only on supported BiDi
  sessions.
- Remove the CLI navigate-before-load instruction for full BiDi restore; retain
  it for the Classic active-origin fallback.
- Add the verified browser/transport matrix to the relevant API and session
  documentation.
- Document partial-failure semantics for runtime overlay into an existing
  context.
- Update browser-context, session-management, API, CLI, recipe, error-code,
  skill references, and changelog together.
- Edit `skills/craftdriver/*.md` by hand; do not run Prettier over those
  hand-formatted Markdown files.

## Acceptance criteria

1. Chrome and Chromium BiDi restore cookies plus multi-origin localStorage at
   launch and in new contexts.
2. Restored localStorage is visible to the first author script.
3. State is seeded once; application mutations survive reload.
4. Path and in-memory state inputs share the same behavior.
5. Default and isolated contexts have equivalent semantics and correct
   partitions.
6. No internal context leaks through public pages, events, waiters, routing,
   active-page selection, traces, or artifacts.
7. Launch/new-context APIs resolve only after restore and cleanup.
8. Failed launch/context restore destroys the new session/context.
9. Malformed or deterministically unsupported input cannot cause mutation.
10. Existing-context transport failures honestly report possible partial state.
11. Classic active-origin restore works and every broader Classic case fails
    with an actionable structured error.
12. Firefox BiDi has either a passing full-restore suite or a tested, narrowly
    justified `UNSUPPORTED` outcome.
13. Empty state is a valid no-op on every transport.
14. Direct library saves are atomic and owner-restricted where supported.
15. Errors and ordinary diagnostics expose no state values.
16. Runtime docs, CLI docs, recipes, and agent skills match the verified
    browser matrix.
17. Restores are serialized within one user context and may proceed
    independently across different user contexts.

## Verification gate

Run the focused Chromium BiDi suite:

```sh
BROWSER_NAME=chrome HEADLESS=true npx vitest run tests/auth-state-hydration.test.ts tests/auth-state-invisibility.test.ts tests/auth-state-restore-policy.test.ts tests/browser-context-storage.test.ts tests/storage.test.ts
BROWSER_NAME=chrome HEADLESS=true npx vitest run --config vitest.recipes.config.ts tests/recipes/login-once-reuse-session.test.ts
```

Run Firefox BiDi and the explicit Classic coverage:

```sh
BROWSER_NAME=firefox HEADLESS=true npx vitest run --maxWorkers=1 tests/auth-state-hydration.test.ts tests/auth-state-invisibility.test.ts tests/auth-state-restore-policy.test.ts tests/browser-context-storage.test.ts tests/storage.test.ts
BROWSER_NAME=firefox HEADLESS=true npx vitest run --config vitest.recipes.config.ts tests/recipes/login-once-reuse-session.test.ts
BROWSER_NAME=chrome HEADLESS=true npx vitest run tests/storage.test.ts -t "Classic"
BROWSER_NAME=firefox HEADLESS=true npx vitest run tests/storage.test.ts -t "Classic"
```

Run CLI and repository gates:

```sh
HEADLESS=true npx vitest run --config vitest.cli.config.ts tests/cli/auth-state.test.ts
npm run build
npm run lint
npm run docs:check
npx vitest run tests/cli/init-skill.test.ts
```

Add focused suites for every other changed file. Run Safari integration when a
macOS runner is available; otherwise unit-test its explicit Classic contract
and do not claim full Safari verification.

Measure multi-origin setup cost on Chromium against the current preload path.
If a CDP adapter is retained, compare it against the standards-based BiDi path
and record browser versions and median measurements in the PR.

## Deferred

Do not include these in the MVP:

- capture from origins whose pages were closed before `storageState()`
- Playwright JSON compatibility
- IndexedDB capture or restore
- context/launch-time sessionStorage hydration
- persistent `userDataDir` profiles
- cookie-expiry warnings
- a validate-and-refresh/session orchestration primitive
- a clear-and-replace `setStorageState` API
- partitioned-cookie/CHIPS fidelity beyond the current `SessionState` model
- a support claim for Electron without dedicated integration coverage

## Agent handoff

Use this instruction:

> Implement the MVP in `plans/auth-state-reuse.md` in phase order. Prioritize
> the required Chrome/Chromium BiDi contract; do not weaken it to obtain
> cross-browser parity. Start with failing contract tests, keep deferred work
> out of scope, preserve unrelated working-tree changes, record the verified
> browser matrix, and complete the applicable verification gate before
> reporting completion.
