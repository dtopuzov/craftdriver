# Research: driver manager vs. driver-free (BiDi-direct)

**Status:** research only, no code changes.
**Author/date:** 2026-05. **Revised** with Option D (chromium-bidi as
a library) after discovering Puppeteer's actual architecture.

## TL;DR

There are **four** real options. The fourth is the one this revision
adds, and it changes the recommendation.

| Option | What it ships | Net code change | Risk | User UX |
| --- | --- | --- | --- | --- |
| **A. Add a manager (Selenium Manager or `@puppeteer/browsers`), keep drivers** | A small fallback that resolves+downloads `chromedriver`/`geckodriver` on first run. Drivers stay. | **+150 LOC** | Low | "It just works" on a fresh machine |
| **B. Driver-free Firefox, manager + drivers for Chrome** | Firefox spawned directly (BiDi is in the browser). Chrome still goes through chromedriver. | **+300 LOC** | Medium | Same as A for Chrome; one less binary for Firefox |
| **C. Re-implement the BiDi Mapper ourselves for Chrome** | Vendor or fork the chromium-bidi JS code and ship it ourselves. | **+50 KLOC** vendored, indefinite maintenance | High | Same as D, but with a permanent burden tracking Chrome internals |
| **D. Drop drivers, depend on `chromium-bidi` (npm) + `@puppeteer/browsers`** | Spawn Chrome → CDP → run `chromium-bidi` *in our process* to expose BiDi. Spawn Firefox → its native BiDi WebSocket. **No chromedriver, no geckodriver.** | **−500 LOC net** (delete `service.ts`, `chrome.ts`, `firefox.ts`, `builder.ts`, `driver.ts`, Classic HTTP layer; add ~300 LOC of launchers). | Medium-low (Puppeteer ships this exact stack) | Best — zero binaries, zero version-mismatch problems |

**Revised recommendation: Option D is on the table and is now the
strongest choice if the priority is less code.** It is exactly what
Puppeteer does today, dependencies confirmed in their `package.json`:
`chromium-bidi`, `@puppeteer/browsers`, `ws`, `devtools-protocol`,
`webdriver-bidi-protocol`. No drivers anywhere.

The rest of this doc explains all four options. The earlier version
of this document under-weighted Option D because it confused
"chromium-bidi the npm library" with "chromium-bidi the Mapper running
inside chromedriver". They are the same code; the difference is *where*
it runs. Running it in-process (Option D) is supported, supported by
Google, and ~50× less code than vendoring it (Option C).

---

## The honest picture: who actually speaks BiDi today

This was the single most important fact to get right before deciding.

| Browser | Speaks BiDi natively? | Where the BiDi WebSocket lives | Driver still needed? |
| --- | --- | --- | --- |
| **Firefox** (102+) | **Yes**, in the Remote Agent inside the browser. | Inside `firefox` itself when launched with `--remote-debugging-port` (or `marionette` + a CLI flag). | **No**, geckodriver is optional. Puppeteer's Firefox path proves this in production. |
| **Chrome / Chromium** | **No.** Chrome only speaks **CDP**. | Inside chromedriver, which runs the **chromium-bidi JavaScript Mapper** in a hidden tab. The Mapper translates BiDi → CDP. See [chromium-bidi README](https://github.com/GoogleChromeLabs/chromium-bidi) — *"There are 2 main modules: 1. backend WS server… 2. front-end BiDi Mapper… Gets BiDi commands from the backend, and map them to CDP commands."* | **Yes**, unless we ship the Mapper ourselves. |
| **Edge** | Same as Chrome (Chromium). | Same. | Yes. |
| **Safari** | No (and no roadmap). | safaridriver does Classic only. | Yes (and BiDi never). |

Implication: **"BiDi-first" does not mean "no driver"**. craftdriver is
already BiDi-first, talking to the BiDi WebSocket the driver exposes.
That's the same thing Selenium 4 does. Dropping drivers is a separate
architectural choice with nothing to do with BiDi.

---

## Option A — Reuse a driver manager (Selenium Manager or `@puppeteer/browsers`)

### What it is

Selenium Manager is a standalone Rust CLI that does five things:

1. Detects the installed browser version (`google-chrome --version` etc.).
2. Resolves the matching driver version from official metadata
   (Chrome-for-Testing JSON endpoints, geckodriver releases).
3. Downloads + extracts the driver to `~/.cache/selenium`.
4. Caches discovery results with a TTL so repeat invocations are fast.
5. Optionally downloads the matching browser binary too (CfT for Chrome).

It is a **CLI tool, not a library**. Selenium bindings shell out to it
and parse a single line of JSON/INFO output:

```
INFO  Driver path: /Users/x/.cache/selenium/chromedriver/mac-arm64/139.0.7258.68/chromedriver
INFO  Browser path: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

That's the whole integration contract.

### Why reuse instead of rolling our own

We already have a "good enough" resolver in
[src/lib/chrome.ts](src/lib/chrome.ts#L17-L43): env var → local
`node_modules/.bin/chromedriver` → PATH. The bug it can't fix is the
**Chrome-evergreen mismatch**: a developer's Chrome auto-updates from
139 → 140 over the weekend, and Monday's CI breaks with
`This version of ChromeDriver only supports Chrome version 139`.
Solving that ourselves means:

- maintaining HTTP clients for Google's CfT JSON endpoints,
- maintaining HTTP clients for Mozilla's geckodriver release feed,
- a download/extract/cache layer with file locking,
- TTL handling,
- proxy support, retry logic, graceful corporate-firewall errors,
- per-platform / per-arch binary selection,
- chmod on Unix, `.exe` on Windows, the macOS Gatekeeper unquarantine dance.

Selenium Manager has done all of this for two years and it is the
default in every Selenium binding. There are mature reference
implementations of how to invoke it from Node — Selenium's own
`selenium-webdriver` npm package does exactly this.

### What "reuse" would look like in craftdriver

1. Add a thin `SeleniumManager` helper in `src/lib/manager.ts` that:
   - Locates the binary in this order:
     1. `SE_MANAGER_PATH` env var (Selenium's own override).
     2. Bundled binary under `bin/<platform>-<arch>/selenium-manager`.
     3. `selenium-manager` on PATH.
   - Spawns it with `--browser chrome|firefox`, optional
     `--browser-version`, `--language-binding JavaScript`, `--output JSON`.
   - Parses the `driver_path` and `browser_path` fields from JSON output.

2. Wire it into `ChromeService` / `FirefoxService` as a **last-resort
   fallback**, after the existing env-var / local-`node_modules` /
   PATH probes:

   ```
   binaryPath ?? CHROMEDRIVER_PATH ?? node_modules/.bin/chromedriver
              ?? PATH ?? selenium-manager --browser chrome
   ```

   Crucially, Selenium Manager **stays an opt-in fallback**. Existing
   users who pin a chromedriver via `binaryPath` or env var keep their
   current behaviour bit-for-bit.

3. Distribution choice — three sub-options, ordered by user-friendliness:
   - **(a) Bundle the binaries in the npm package.** ~7 MB per platform
     × three platforms (macOS-universal, linux-x64, win-x64) = ~21 MB
     unpacked. We can use `optionalDependencies` with platform-specific
     packages (the pattern `esbuild`, `swc`, `rollup` use) to ship only
     the right one to each user. End-user experience: zero-config.
   - **(b) Download on `postinstall`.** Smaller npm tarball, but breaks
     in airgapped CI and is generally hated.
   - **(c) Don't bundle; require user to install separately.** Worst
     UX; defeats the point.

   Recommend **(a)** with `optionalDependencies` per platform.

### Cost / risk

- ~150 LOC of TypeScript glue.
- Three small companion packages
  (`@craftdriver/selenium-manager-darwin-arm64` etc.) that each ship one
  binary. Selenium publishes the binaries openly under Apache-2.0.
- Risk: Selenium Manager output format is documented but technically
  still beta. Mitigation: pin a known version, write a one-shot
  integration test that calls it with `--output JSON` and checks the
  shape.

### What this *doesn't* solve

- We still ship/depend on chromedriver and geckodriver. They still run
  as a child process. That's fine — see the next section.

---

## Option B — Driver-free Firefox, drivers-with-manager Chrome

### Why this is interesting

Firefox 102+ implements WebDriver BiDi **natively in the browser**.
You can:

```
firefox --remote-debugging-port=0 --headless --no-remote --profile /tmp/p
```

…then read the WebSocket URL from the browser's DevToolsActivePort
file, connect, and start sending BiDi commands. **No geckodriver in
the loop.** This is exactly what Puppeteer does for its Firefox
backend.

What we'd lose by dropping geckodriver:

- W3C Classic WebDriver fallback for things BiDi doesn't cover yet.
- Some niche features that go through the marionette protocol.

What we already do over BiDi (network, logs, dialogs, navigation,
input, screenshots, permissions, geolocation, viewport, storage) keeps
working. Auditing our codebase, the **only** Firefox-on-Classic paths
left are:

- `setWindowRect` fallback inside `setViewportSize` — rarely hit, BiDi
  has `browsingContext.setViewport`.
- Some `executeScript` calls — Classic, but BiDi has
  `script.callFunction` which we already use elsewhere.

So a driver-free Firefox path is **achievable**, mostly mechanical,
and gets us a meaningfully smaller install footprint plus startup
saving (no extra process).

### Why we should NOT vendor or fork the Mapper ourselves

Note that this section is about **vendoring** the chromium-bidi source
into our repo. Using it as an **npm dependency** is a different story
— that's Option D below, and it's the cheap way to get Chrome
driver-free.

To vendor or fork chromium-bidi, we would have to:

- download/pin per Chrome version,
- inject into an isolated tab on every session,
- keep updating in lockstep with Chrome's CDP changes,
- debug ourselves when it breaks.

This is what chromedriver does internally. We would essentially be
re-implementing chromedriver in Node. The chromium-bidi project is
~50 KLOC of TypeScript and Python. **Hard pass.**

The other "go direct" approach — talking CDP and dropping BiDi
altogether — is also a hard pass: we lose the BiDi-first design
principle and become Puppeteer-lite without the Puppeteer feature set.

### Cost / risk for Firefox-only driver-free

- ~300 LOC: a `FirefoxLauncher` that spawns firefox, reads
  `DevToolsActivePort`, opens a BiDi WebSocket, plumbs it into the
  existing `BiDiSession`.
- We still need to **find the firefox binary**. Either reuse Selenium
  Manager from option A (it can manage Firefox installs too) or trust
  PATH + `FIREFOX_BIN`.
- Risk: Firefox's BiDi surface is slightly behind chromedriver's on
  some new modules (`emulation.*` has gaps). We'd discover gaps as we
  hit them, but the suite already runs green against geckodriver, so
  parity is reachable.
- Net win: removes one process, one binary, one maintenance vector.

### Recommendation for option B

Stand-alone, option B doesn't make much sense — Firefox is a small
fraction of users and Chrome still has chromedriver. It only really
matters as a stepping-stone toward, or a fallback complement to,
option D.

---

## Option C — Vendor / fork the chromium-bidi Mapper ourselves

Already argued against above. To repeat in one place:

- We would have to ship the chromium-bidi Mapper (the JS code, not the
  npm package) inside craftdriver, tracking Chrome stable + canary
  indefinitely.
- The "save one process" win is small: chromedriver is ~10 MB and
  starts in ~50 ms.
- The "speak BiDi natively" claim is **already true today** because
  chromedriver is just transport — the BiDi protocol is what we send.

If at some point Chrome ships a native BiDi WebSocket inside the
browser (it's in the [Chromium roadmap](https://chromestatus.com/feature/5198373824200704)
but not landed), this option becomes free. Until then, no.

**Important:** option C is *not* the same as depending on
`chromium-bidi` from npm. The npm package runs the same Mapper code
inside *our* Node process; we don't fork it, we don't track it, we
just bump a version number. That's option D.

---

## Option D — Drop drivers, depend on `chromium-bidi` (npm) + `@puppeteer/browsers`

### What is `chromium-bidi`, exactly?

[`chromium-bidi`](https://www.npmjs.com/package/chromium-bidi) is a
**TypeScript library on npm**, Apache-2.0, maintained by Google. It
takes a CDP connection and exposes the W3C WebDriver BiDi protocol on
top of it. The exact same code runs inside chromedriver today (in a
hidden tab) — but it can also run inside any Node process. That's
what Puppeteer does for its BiDi-over-Chrome path.

Confirmed by Puppeteer's `package.json` runtime dependencies:

```json
"@puppeteer/browsers": "2.13.0",
"chromium-bidi": "14.0.0",
"devtools-protocol": "...",
"webdriver-bidi-protocol": "...",
"ws": "^8.20.0"
```

No chromedriver, no geckodriver. That's the whole stack.

### What this would look like in craftdriver

The user-facing API does not change at all. Internally:

| Browser | Today | Option D |
| --- | --- | --- |
| Chrome | spawn chromedriver → HTTP /session → upgrade to BiDi WS that chromedriver hosts | spawn chrome → connect to its CDP socket → start `chromium-bidi`'s `BidiServer` in-process → talk BiDi to it |
| Firefox | spawn geckodriver → HTTP /session → upgrade to BiDi WS that geckodriver hosts | spawn firefox → read `DevToolsActivePort` → connect to firefox's native BiDi WS directly |

Everything above the connection layer (`browser.ts`, `page.ts`,
`locator.ts`, `expect.ts`, `bidi/network.ts`, `bidi/logs.ts`,
`bidi/storage.ts`, `bidi/connection.ts`) keeps working unchanged: they
already speak BiDi and don't care what's at the other end of the
WebSocket.

### Estimated code-size impact

| Layer | Today | Option D |
| --- | --- | --- |
| `service.ts`, `chrome.ts`, `firefox.ts` (driver process management, port readiness) | ~250 LOC | 0 (deleted) |
| `builder.ts`, `driver.ts`, Classic WebDriver HTTP, `webelement.ts`, `http.ts` | ~600 LOC | ~150 LOC (BiDi-only session bootstrap) |
| New: Chrome launcher + `chromium-bidi` glue | 0 | ~80 LOC |
| New: Firefox launcher | 0 | ~60 LOC |
| **Net change** | **~850 LOC** | **~290 LOC + 2 npm deps** |

Roughly **~500 LOC net deletion** plus removal of two external
binaries from users' installs. This is the only option in this
document where the answer to "if I drop drivers do I have less code?"
is genuinely **yes**.

### Wins

- ~500 LOC net code deletion.
- No chromedriver/geckodriver in users' installs, ever.
- Zero version-mismatch problem — `chromium-bidi`'s release range
  states which Chrome versions it supports; `@puppeteer/browsers` can
  fetch a matching Chrome-for-Testing build if needed.
- This is *exactly* the architecture Puppeteer uses today; battle-tested
  at scale in Puppeteer, Chrome DevTools, Lighthouse.
- Manager problem solved as a side effect — `@puppeteer/browsers`
  resolves browser binaries, no separate "manager" layer needed.

### Costs / risks

- **Release-cadence dependency.** When Chrome ships a new major,
  `chromium-bidi` releases an update. We bump it. That's normal Node
  ecosystem hygiene; the cadence is roughly weekly.
- **Chrome + Firefox only.** No Edge (works as Chromium, but no IE),
  no Safari, no remote Selenium Grid. craftdriver loses the "any
  WebDriver-compliant endpoint" pluggability.
- **No Classic WebDriver escape hatch.** If BiDi can't do something,
  we can't reach for `/session/.../execute` as a fallback. In practice
  every feature we ship today already works on BiDi; the audit in
  option B identified two harmless Classic call sites.
- **Philosophical:** for Chrome we are no longer using "the W3C
  WebDriver protocol" — we're using BiDi-over-CDP via a Google library.
  The user-visible API is identical and the wire protocol is BiDi, but
  it's not Selenium-grid-compatible.

### When option D is wrong for craftdriver

- If supporting **Selenium Grid / remote drivers** is a goal.
- If supporting **Edge, IE, or Safari** is a goal.
- If we want **zero runtime npm dependencies**.

If none of those apply (and they currently don't), option D is the
strongest choice.

---

## What about webdriver-manager / webdrivermanager-node / chromedriver npm?

The Node ecosystem has several driver managers:

- **`chromedriver` npm package**, **`geckodriver` npm package** — single-purpose,
  download a matching binary at `npm install` time. We already
  implicitly support these via the `node_modules/.bin/...` probe.
  Limitations: per-package, no browser-version detection, `postinstall`
  download fails in airgapped CI.
- **`webdriver-manager`** — the AngularJS-era tool. Effectively dead;
  last meaningful release predates Chrome-for-Testing.
- **`@puppeteer/browsers`** — Google's official CLI for downloading
  browsers and drivers. Actively maintained, used by Puppeteer and
  Chrome DevTools. Apache-2.0. **A real alternative to Selenium Manager.**

### Selenium Manager vs `@puppeteer/browsers`

| | Selenium Manager | `@puppeteer/browsers` |
| --- | --- | --- |
| Language | Rust (binary) | TypeScript (npm) |
| Distribution | Bundled binaries | Plain `npm install` |
| Browser support | Chrome, Firefox, Edge, IE | Chrome, Firefox, Chromium |
| Driver support | chromedriver, geckodriver, msedgedriver, IEDriverServer | chromedriver, chrome-headless-shell, firefox |
| Browser version detection | Yes (shell calls) | Limited |
| Cache layout | `~/.cache/selenium` | `./browsers` (configurable) |
| Production users | All Selenium bindings | Puppeteer, DevTools, Lighthouse |
| Stable? | Beta but battle-tested | Stable |

**Both are good.** `@puppeteer/browsers` is the more "Node-native"
choice — it's a normal npm dep, not a binary — and integrates cleanly
without the bundling-binaries problem.

If we want zero-binary npm distribution, **`@puppeteer/browsers` is
arguably the better fit** for a Node-only project. Selenium Manager's
edge (browser-version sniffing + offline mode) is nice-to-have, not
core.

### Revised recommendation

**Use `@puppeteer/browsers`** as the manager, not Selenium Manager.
Reasons:

- Pure-npm install, no binary bundling, no `optionalDependencies`
  per-platform contortions.
- Apache-2.0, maintained inside Google by the Puppeteer team.
- Already speaks "Chrome for Testing" JSON endpoints natively.
- Smaller surface; we don't need browser auto-management today (most
  users have a system Chrome) — we mainly need the **driver**.

The Selenium-Manager option is the right pick **only if** we want the
exact same UX as Selenium and are happy bundling Rust binaries.

---

## Decision matrix

For each axis, score 1 (worst) – 5 (best):

| | A. Selenium Manager | A′. `@puppeteer/browsers` (manager only) | B. Driver-free Firefox only | C. Vendor Mapper | **D. Drop drivers via `chromium-bidi`** |
| --- | --- | --- | --- | --- | --- |
| Effort to ship | 4 | 5 | 3 | 1 | 3 |
| Maintenance burden | 3 | 4 | 3 | 1 | 4 |
| User-visible UX win | 4 | 4 | 3 | 5 | **5** |
| Ecosystem alignment (Node) | 3 | 5 | 4 | 4 | **5** |
| Survives Chrome auto-update | 5 | 5 | n/a | 4 | **5** |
| Code-size impact | 0 (+150 LOC) | 0 (+150 LOC) | +300 LOC | +50 KLOC | **−500 LOC** |
| Risk of bitrot | 4 | 4 | 3 | 1 | 3 |
| Loses Selenium Grid support | no | no | no | no | **yes** |

The decision really comes down to: do we want Selenium-Grid /
multi-browser-vendor compatibility, or do we want the smallest, most
modern stack? They are mutually exclusive.

---

## Concrete recommendations (revised)

Ordered from "least risky, smallest change" to "biggest win,
biggest change":

### Path 1 — incremental (lower risk)

1. **Add `@puppeteer/browsers` as a chromedriver/geckodriver fallback.**
   Keep all existing probes; only call the manager when nothing else
   resolves. No breaking change. ~150 LOC.
2. **Add driver-free Firefox** behind a `{ driverless: true }` flag.
   Flip default once green. ~300 LOC.
3. Stop here, or eventually move to path 2.

### Path 2 — go all-in on BiDi-direct (recommended if "less code" is
the priority)

1. **Adopt `chromium-bidi` and `@puppeteer/browsers` as runtime deps.**
2. Replace `service.ts` / `chrome.ts` / `firefox.ts` with a single
   `launcher.ts` that spawns a browser binary and returns a BiDi
   WebSocket — using `chromium-bidi` for Chrome, native BiDi for Firefox.
3. Delete `builder.ts`, `driver.ts`, the Classic WebDriver HTTP layer,
   and the `webelement.ts` shim.
4. Keep `bidi/connection.ts` and everything above it untouched.
5. Drop `ChromeService` / `FirefoxService` from the public API
   (breaking change, pre-1.0).
6. Net result: **~500 LOC less code, zero driver binaries, no manager
   needed**. The API users see does not change.

### What both paths agree on

- chromium-bidi as a **vendored fork** is off the table (option C).
- "Just drop drivers and write nothing" is not a real option.
- The current implicit `node_modules/.bin/chromedriver` probe stays
  useful and should not be removed in any path.

---

## Open questions for the user

- **Is Selenium Grid / remote-driver support a hard requirement?**
  If yes, path 1; if no, path 2 is on the table.
- **Are we OK with two new runtime deps** (`chromium-bidi`,
  `@puppeteer/browsers`)? They're both Apache-2.0, both maintained by
  Google, and combined ship as ~3 MB unpacked.
- **Pre-1.0 breaking changes acceptable?** Path 2 removes
  `ChromeService` / `FirefoxService` from the public surface.
- **Is dropping Classic-WebDriver fallback in-scope?** Path 2 implies
  yes; path 1 leaves it as-is.
