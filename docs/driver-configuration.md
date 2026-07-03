# Driver Configuration

Craftdriver resolves the WebDriver binary through a chain — first match wins:

| Step | Source |
|---|---|
| 1 | `driverPath` option in `Browser.launch()` |
| 2 | `CRAFTDRIVER_CHROMEDRIVER_PATH` / `CRAFTDRIVER_GECKODRIVER_PATH` env var |
| 3 | `CRAFTDRIVER_DRIVER_PATH` env var (generic fallback for either browser) |
| 4 | Legacy/Selenium-compatible env vars: `CHROMEDRIVER_PATH`, `SE_CHROMEDRIVER` (chromedriver) or `GECKODRIVER_PATH`, `GECKODRIVER_FILEPATH`, `SE_GECKODRIVER` (geckodriver) |
| 5 | **Cached auto-resolution** — the path a previous auto-resolve settled on, reused within the `CRAFTDRIVER_DRIVER_TTL` window |
| 6 | `chromedriver` / `geckodriver` in `node_modules/.bin` |
| 7 | `chromedriver` / `geckodriver` on `PATH` |
| 8 | **Auto-download from Chrome for Testing / GitHub** ← the zero-config default |

Downloaded drivers are cached in `~/.cache/craftdriver`, and so is the
*resolution itself* — which driver path to use. Within the
`CRAFTDRIVER_DRIVER_TTL` window (default 24 h), craftdriver reuses the
resolved path directly and skips the system-browser probes it would
otherwise run on **every** launch: launching the browser binary just to read
its version string, and a `PATH` lookup. Both are blocking calls, so caching
the resolution measurably speeds up launch — most noticeably when several
browsers start in parallel (see [Performance](#performance)). After the TTL
expires, or the cache is cleared (e.g. after a browser upgrade), the driver
is re-resolved and re-downloaded if needed. Only the driver binary is ever
downloaded, never the browser itself. Explicit configuration (steps 1–4)
always takes precedence over the cache.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `CRAFTDRIVER_CHROMEDRIVER_PATH` | Absolute path to a chromedriver binary | — |
| `CRAFTDRIVER_GECKODRIVER_PATH` | Absolute path to a geckodriver binary | — |
| `CRAFTDRIVER_DRIVER_PATH` | Generic fallback path (either browser) | — |
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
