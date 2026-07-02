# Driver Configuration

Craftdriver resolves the WebDriver binary through a chain — first match wins:

| Step | Source |
|---|---|
| 1 | `driverPath` option in `Browser.launch()` |
| 2 | `CRAFTDRIVER_CHROMEDRIVER_PATH` / `CRAFTDRIVER_GECKODRIVER_PATH` env var |
| 3 | `CRAFTDRIVER_DRIVER_PATH` env var (generic fallback for either browser) |
| 4 | Legacy/Selenium-compatible env vars: `CHROMEDRIVER_PATH`, `SE_CHROMEDRIVER` (chromedriver) or `GECKODRIVER_PATH`, `GECKODRIVER_FILEPATH`, `SE_GECKODRIVER` (geckodriver) |
| 5 | `chromedriver` / `geckodriver` in `node_modules/.bin` |
| 6 | `chromedriver` / `geckodriver` on `PATH` |
| 7 | **Auto-download from Chrome for Testing / GitHub** ← the zero-config default |

Downloaded drivers are cached in `~/.cache/craftdriver`. Only the driver
binary is downloaded, never the browser itself. Caching differs by browser:
chromedriver is pinned to the detected Chrome version and reused as long as
that version doesn't change; geckodriver isn't version-pinned to Firefox, so
it's re-checked against the latest GitHub release once per
`CRAFTDRIVER_DRIVER_TTL` window regardless of your Firefox version.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `CRAFTDRIVER_CHROMEDRIVER_PATH` | Absolute path to a chromedriver binary | — |
| `CRAFTDRIVER_GECKODRIVER_PATH` | Absolute path to a geckodriver binary | — |
| `CRAFTDRIVER_DRIVER_PATH` | Generic fallback path (either browser) | — |
| `CRAFTDRIVER_CACHE_DIR` | Directory for cached driver downloads | `~/.cache/craftdriver` |
| `CRAFTDRIVER_OFFLINE` | Set to `1` to disable all network calls | — |
| `CRAFTDRIVER_DRIVER_TTL` | Geckodriver freshness check interval (seconds) | `86400` (24 h) |

## Examples

```bash
# Pin a specific chromedriver
CRAFTDRIVER_CHROMEDRIVER_PATH=/usr/bin/chromedriver npm test

# Pin a specific geckodriver
CRAFTDRIVER_GECKODRIVER_PATH=/usr/local/bin/geckodriver npm test

# Never make a network call (requires a local driver to exist in steps 1–5)
CRAFTDRIVER_OFFLINE=1 npm test

# Change the cache location
CRAFTDRIVER_CACHE_DIR=/tmp/my-driver-cache npm test

# Re-check geckodriver more frequently (every hour instead of 24 h)
CRAFTDRIVER_DRIVER_TTL=3600 npm test
```

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
