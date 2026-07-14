# Driver Configuration

Craftdriver resolves the WebDriver binary through a chain — first match wins:

| Step | Source |
|---|---|
| 1 | `driverPath` option in `Browser.launch()` |
| 2 | `CRAFTDRIVER_CHROMEDRIVER_PATH` / `CRAFTDRIVER_GECKODRIVER_PATH` env var |
| 3 | `CRAFTDRIVER_DRIVER_PATH` env var (generic fallback for either browser) |
| 4 | Legacy/Selenium-compatible env vars: `CHROMEDRIVER_PATH`, `SE_CHROMEDRIVER` (chromedriver) or `GECKODRIVER_PATH`, `GECKODRIVER_FILEPATH`, `SE_GECKODRIVER` (geckodriver) |
| 5 | Known CI-provided driver directories (e.g. GitHub Actions' `CHROMEWEBDRIVER` / `GECKOWEBDRIVER`) — see [CI platform detection](#ci-platform-detection) |
| 6 | **Cached auto-resolution** — the path a previous auto-resolve settled on, reused within the `CRAFTDRIVER_DRIVER_TTL` window |
| 7 | `chromedriver` / `geckodriver` in `node_modules/.bin` |
| 8 | `chromedriver` / `geckodriver` on `PATH` |
| 9 | **Auto-download from Chrome for Testing / GitHub** ← the zero-config default |

Downloaded drivers are cached in `~/.cache/craftdriver`, and so is the
*resolution itself* — which driver path to use. Within the
`CRAFTDRIVER_DRIVER_TTL` window (default 24 h), craftdriver reuses the
resolved path directly and skips the system-browser probes it would
otherwise run on **every** launch: launching the browser binary just to read
its version string, and a `PATH` lookup. Both are blocking calls, so caching
the resolution measurably speeds up launch — most noticeably when several
browsers start in parallel (see [Performance](#performance)). After the TTL
expires, or if Chrome reports that the cached chromedriver is for the wrong
major version after a browser upgrade, the driver is re-resolved and
re-downloaded if needed. Only the driver binary is ever downloaded, never the
browser itself. Explicit configuration (steps 1–4) always takes precedence over
the cache.

## CI platform detection

On **GitHub Actions**, craftdriver recognizes the runner's own pre-installed,
version-matched driver automatically — no configuration needed. GitHub's
`ubuntu-latest`, `macos-latest`, and `windows-latest` images all publish a
driver directory via `CHROMEWEBDRIVER` / `GECKOWEBDRIVER` env vars (see
[actions/runner-images](https://github.com/actions/runner-images)); craftdriver
checks those directories as step 5 above, before falling back to its own
cache/PATH-probe/download machinery.

This is best-effort: if a future runner image drops or renames these vars,
craftdriver falls through safely to the next resolution step rather than
erroring. No other CI platform is auto-detected yet — set
`CRAFTDRIVER_CHROMEDRIVER_PATH` / `CRAFTDRIVER_GECKODRIVER_PATH` explicitly on
other providers (or to pin a non-default driver even on GitHub Actions;
explicit config always wins, per the chain above).

## Browser Binary Configuration

Everything above resolves the **driver** (chromedriver/geckodriver). A
separate, independent chain resolves the **browser** binary itself — useful
for a non-default Chrome/Chromium install or a portable Firefox build.

The `browserPath` option itself is opt-in: craftdriver never sets it for you,
and omitting it changes nothing. Steps 4–5 below are **not** craftdriver-opt-in
the same way, though — `CHROME_BIN`, `FIREFOX_BIN`, `SE_CHROME_PATH`, and
`SE_FIREFOX_PATH` are conventions other tools (Karma, Selenium Manager) already
set in CI images and local environments for their own purposes. If one of
those happens to already be exported in your environment, craftdriver will
start forwarding it as of this version — a behavior change you didn't ask
craftdriver for, even though you didn't touch any craftdriver config either.
If you don't want that, set `CRAFTDRIVER_OFFLINE`-style pinning instead, or
simply don't rely on those four var names for anything craftdriver-adjacent.

| Step | Source |
|---|---|
| 1 | `browserPath` option in `Browser.launch()` |
| 2 | `CRAFTDRIVER_CHROME_PATH` / `CRAFTDRIVER_FIREFOX_PATH` env var |
| 3 | `CRAFTDRIVER_BROWSER_PATH` env var (generic fallback for either browser) |
| 4 | `CHROME_BIN` / `FIREFOX_BIN` env var (common CI/tooling convention, e.g. Karma) |
| 5 | `SE_CHROME_PATH` / `SE_FIREFOX_PATH` env var (Selenium Manager convention) |

Each step is validated (the file must exist) before use; an invalid path falls
through to the next step rather than being forwarded to the driver as-is (and
logs a `[craftdriver]` note to stderr when it does, so a typo doesn't silently
launch the wrong browser).

`CRAFTDRIVER_BROWSER_PATH` (step 3) is forwarded verbatim regardless of
whether the browser being launched is Chrome or Firefox — it's a single path,
so it can only ever be correct for one of them. Don't set it in a process or
CI job that launches both browsers; use the browser-specific `CRAFTDRIVER_CHROME_PATH`
/ `CRAFTDRIVER_FIREFOX_PATH` instead.

```typescript
// Launch a custom Chromium build
const browser = await Browser.launch({
  browserName: 'chrome',
  browserPath: '/opt/chromium-custom/chrome',
});
```

```bash
# Equivalent via env var — no code change needed
CRAFTDRIVER_CHROME_PATH=/opt/chromium-custom/chrome npm test
```

If chromedriver itself also has to be auto-downloaded (no driver pinned
anywhere in the chain above), its version is detected from *this* binary
instead of probing for system Chrome — a custom Chromium build's version
routinely doesn't match system Chrome, so using the right binary for version
detection avoids downloading a mismatched chromedriver. Firefox has no
equivalent concern: geckodriver's own download isn't gated on the Firefox
version.

Version detection runs the binary with `--version` and parses its output, the
same way craftdriver already probes system Chrome/Firefox — so `browserPath`
is supported for Chrome/Chromium and Firefox builds only. Anything that
doesn't answer `--version` the way those browsers do (Electron apps and other
Chromium embedders) is out of scope for now; point `CRAFTDRIVER_CHROMEDRIVER_PATH`
at a pinned driver instead of relying on auto-detection in that case.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `CRAFTDRIVER_CHROMEDRIVER_PATH` | Absolute path to a chromedriver binary | — |
| `CRAFTDRIVER_GECKODRIVER_PATH` | Absolute path to a geckodriver binary | — |
| `CRAFTDRIVER_DRIVER_PATH` | Generic fallback path (either browser) | — |
| `CRAFTDRIVER_CHROME_PATH` | Absolute path to a Chrome/Chromium binary — see [Browser Binary Configuration](#browser-binary-configuration) | — |
| `CRAFTDRIVER_FIREFOX_PATH` | Absolute path to a Firefox binary | — |
| `CRAFTDRIVER_BROWSER_PATH` | Generic browser-binary fallback path (either browser) | — |
| `CRAFTDRIVER_CACHE_DIR` | Directory for cached driver downloads | `~/.cache/craftdriver` |
| `CRAFTDRIVER_OFFLINE` | Set to `1` to disable all network calls | — |
| `CRAFTDRIVER_DRIVER_TTL` | Driver-resolution cache lifetime, in seconds (both browsers). `0` disables the cache | `86400` (24 h) |

## Examples

```bash
# Pin a specific chromedriver
CRAFTDRIVER_CHROMEDRIVER_PATH=/usr/bin/chromedriver npm test

# Pin a specific geckodriver
CRAFTDRIVER_GECKODRIVER_PATH=/usr/local/bin/geckodriver npm test

# Never make a network call (requires a local driver to exist in steps 1–7)
CRAFTDRIVER_OFFLINE=1 npm test

# Change the cache location
CRAFTDRIVER_CACHE_DIR=/tmp/my-driver-cache npm test

# Re-check geckodriver more frequently (every hour instead of 24 h)
CRAFTDRIVER_DRIVER_TTL=3600 npm test
```

## Performance

Most of the time `Browser.launch()` spends is the browser process starting up
(that's the same for WebDriver Classic and BiDi and there's little a client
library can do about it). The part craftdriver *does* control is resolving and
starting the driver, and it's tuned to stay out of the way:

- **Driver resolution is cached** (see above). Without a cache, resolving a
  chromedriver means launching your Chrome binary just to read its version
  string — a blocking call of a few hundred milliseconds on *every* launch.
  The TTL cache skips that after the first launch.
- **Point at a driver explicitly to skip resolution entirely.** If you set
  `CRAFTDRIVER_CHROMEDRIVER_PATH` / `CRAFTDRIVER_GECKODRIVER_PATH` (or pass
  `chromeService: new ChromeService({ binaryPath })`), craftdriver uses it
  directly — no version detection, no `PATH` lookup, no cache read. This is
  the fastest and most deterministic option and is recommended for CI:

  ```bash
  CRAFTDRIVER_CHROMEDRIVER_PATH=/opt/chromedriver/chromedriver npm test
  ```

- **Parallel runs benefit the most.** The resolution work that the cache (or an
  explicit path) removes was synchronous and blocked the event loop, so it
  serialized when several browsers were launched at once. Removing it lets
  concurrent `Browser.launch()` calls overlap their startup (measured ~17–20%
  faster wall time for a batch of concurrent launches).

### Concurrency and oversubscription

Once resolution is out of the way, the rest of launch time is the browser
process starting — and that is **CPU-bound**. Starting many browsers at once
on a machine with fewer CPU cores oversubscribes the CPU, and each browser's
startup slows down roughly in proportion. On an 8-core machine, for example, a
single launch is ~2s but 20 simultaneous launches take ~25s *each* (they still
finish sooner in aggregate than launching serially, just with diminishing
returns). This is not a craftdriver limitation — it's the browser competing for
CPU — and no client-side change removes it.

Practical guidance for parallel test suites (e.g. Vitest / Jest / Playwright
Test): **cap worker concurrency at roughly the number of CPU cores.** More
workers than cores mostly adds launch latency, and a launch that is merely slow
under heavy load can trip a short per-test/hook timeout and look like a hang.
With Vitest, set `maxWorkers` (or `poolOptions`) accordingly; a generous
`hookTimeout` for the `beforeAll` that launches the browser also helps on
loaded CI runners.

Indicative numbers from the `tests/perf/launch-critical-path.perf.ts`
benchmark (macOS, Chrome, headless — absolute values are machine-dependent,
but the direction holds):

| Scenario | Before | After |
|---|---|---|
| `Browser.launch()` (BiDi) | ~2760ms | ~2240ms |
| `Browser.launch()` (Classic) | ~2400ms | ~1860ms |
| 4 browsers launched concurrently | ~6450ms | ~5130ms |

Run it yourself with `npm run bench -- launch-critical-path`.

A separate micro-benchmark (`tests/perf/driver-resolution.perf.ts`) isolates
just the CI-provided driver directory step from the rest of the resolution
chain — `resolveChromeDriver()` alone, cache isolated so both paths are
measured cold:

| Scenario | Time |
|---|---|
| `CHROMEWEBDRIVER` set (new) | ~0ms (an `fs.existsSync` check) |
| PATH-probe + Chrome-version-detect fallback (old) | ~360ms |

That's the cost every cold `Browser.launch()` used to pay once per process on
a GitHub Actions runner before this step existed — now skipped entirely. Run
it yourself with `npm run bench -- driver-resolution`.

### Browser startup flags (advanced, opt-in)

craftdriver launches the browser with **no performance flags of its own** — it
stays unopinionated so it never silently changes browser behavior underneath
you. If you want to experiment, you can pass extra browser command-line flags
via the `args` launch option (appended to `goog:chromeOptions.args` for
Chrome/Chromium, `moz:firefoxOptions.args` for Firefox):

```typescript
const browser = await Browser.launch({
  browserName: 'chrome',
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain', // macOS: skip keychain access
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
  ],
});
```

> `args` are **browser** flags. They are distinct from the **driver**
> (chromedriver/geckodriver) args you'd pass via `chromeService` /
> `firefoxService` below.

**Set expectations honestly:** on a normal local machine this set moved
`Browser.launch()` wall time by **~0.4% (≈8ms — noise)** in our measurements.
Cold browser startup is dominated by unavoidable process/engine init; these
flags mostly suppress *background* work (auto-updates, telemetry, background
networking, sync) that happens after startup rather than on the launch critical
path. So their real value is **determinism and avoiding intermittent stalls in
CI / constrained environments** (no update popups, no background network
calls), not raw local launch speed. If you adopt them, **measure on your own
environment** — the payoff is environment-dependent, and some flags can change
behavior (e.g. `--no-sandbox`, or `--disable-features=...` entries a page or
fixture relies on).

## Pinning via code

For tighter control (custom port, extra driver flags), pass a `ChromeService`
or `FirefoxService` directly to `Browser.launch()`:

```typescript
import { Browser, ChromeService, FirefoxService } from 'craftdriver';

const browser = await Browser.launch({
  browserName: 'chrome',
  chromeService: new ChromeService({
    binaryPath: '/opt/chromedriver/chromedriver',
    port: 9515,
    args: ['--log-level=ALL'],
  }),
});
```

## Safari (macOS): driver ships with the browser

Everything above (steps 1–9, the download chain, the TTL cache) resolves
**chromedriver**/**geckodriver** — binaries craftdriver may fetch and cache on
disk. `browserName: 'safari'` doesn't fit that model at all: Apple ships
`safaridriver` as part of macOS/Safari itself, so there is no download, no
version-matching problem, and no cache to warm. This page covers only driver
**resolution**; for setup (`safaridriver --enable`), capabilities, limitations,
and Safari Technology Preview, see the [**Safari guide**](./safari.md).

`SafariService` resolves the `safaridriver` binary through its own chain —
first match wins, and none of these steps ever triggers a network call:

| Step | Source |
|---|---|
| 1 | `binaryPath` passed to `new SafariService({ binaryPath })` |
| 2 | `CRAFTDRIVER_SAFARIDRIVER_PATH` env var |
| 3 | `CRAFTDRIVER_DRIVER_PATH` env var (generic fallback, shared with Chrome/Firefox) |
| 4 | `/usr/bin/safaridriver` (the fixed system location on macOS) |
| 5 | `safaridriver` on `PATH` |
| 6 | a clear, actionable error if nothing resolves — craftdriver never downloads a `safaridriver` |

To pin **Safari Technology Preview**, point `binaryPath` at its bundled driver
(`/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver`) —
see the [Safari guide](./safari.md#safari-technology-preview).

### Extra `safaridriver` arguments

`SafariService` accepts `args`, passed through verbatim after `--port <port>`.
The most useful one is `--diagnose`, which turns on `safaridriver`'s
diagnostic logging (written under `~/Library/Logs/com.apple.WebDriver/`) —
handy when a Safari session fails to start and the driver's own stdout/stderr
isn't enough to tell why:

```typescript
const browser = await Browser.launch({
  browserName: 'safari',
  safariService: new SafariService({ args: ['--diagnose'] }),
});
```

### What's different from Chrome/Firefox here

- No `CRAFTDRIVER_CACHE_DIR`, `CRAFTDRIVER_DRIVER_TTL`, or `CRAFTDRIVER_OFFLINE`
  behavior applies to Safari — there's nothing cached or downloaded to
  configure.
- No browser-binary resolution chain (`browserPath` / `CRAFTDRIVER_CHROME_PATH`-
  style) exists for Safari — you select which Safari build's driver to use via
  `SafariService.binaryPath` directly, as shown above, not via a separate
  browser-path option.
- `enableBiDi: true` is rejected before launch — Safari has no documented
  WebDriver BiDi endpoint to negotiate. See
  [WebDriver Standards → Safari is Classic-only](./standards.md#safari-is-classic-only).
