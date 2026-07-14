# Zero-Config Drivers

CraftDriver is designed so a normal install is enough:

```bash
npm install craftdriver --save-dev
```

Then launch an installed browser:

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });
```

You do not need to add `chromedriver`, `geckodriver`, or browser downloads to most projects. CraftDriver resolves the matching WebDriver binary, starts it on a free port, and caches resolution details so later launches are faster.

## What Happens At Launch?

CraftDriver checks for the driver in this order:

| Step | Source                                                                  |
| ---- | ----------------------------------------------------------------------- |
| 1    | Explicit `ChromeService` / `FirefoxService` configuration               |
| 2    | Environment variables such as `CHROMEDRIVER_PATH` or `GECKODRIVER_PATH` |
| 3    | Known CI-provided driver directories (e.g. GitHub Actions' `CHROMEWEBDRIVER` / `GECKOWEBDRIVER`) |
| 4    | Project-local binaries in `node_modules/.bin`                           |
| 5    | Binaries already available on `PATH`                                    |
| 6    | Auto-resolved and cached driver matching the installed browser          |

If a browser update leaves a cached driver stale, CraftDriver retries once with a refreshed driver instead of making you clear the cache manually.

## CI Friendly

The default setup works well on CI runners that already include Chrome or
Firefox. On **GitHub Actions** specifically, craftdriver auto-detects the
runner's own pre-installed, version-matched driver out of the box (via
`CHROMEWEBDRIVER` / `GECKOWEBDRIVER`) — no configuration needed, and it's
faster than the fallback probes since it skips version detection entirely (see
[Driver Configuration → CI platform detection](./driver-configuration.md#ci-platform-detection)).

For platforms without built-in detection, or to pin a driver other than the
runner's default, set the path manually:

```bash
CRAFTDRIVER_CHROMEDRIVER_PATH=/usr/bin/chromedriver npm test
CRAFTDRIVER_OFFLINE=1 npm test
CRAFTDRIVER_CACHE_DIR=/tmp/craftdriver-cache npm test
```

## When To Configure Manually

Manual configuration is useful when:

- your CI image pins a specific browser and driver pair
- network access is blocked
- you need custom driver logging
- you want to avoid any version detection during launch
- you're launching a non-default Chrome/Chromium/Firefox build via
  `browserPath` / `CRAFTDRIVER_CHROME_PATH` — see
  [Driver Configuration → Browser Binary Configuration](./driver-configuration.md#browser-binary-configuration)

See [Driver Configuration](./driver-configuration.md) for the full reference.

## Safari: nothing to resolve, nothing to download

The auto-download model above doesn't apply to `browserName: 'safari'`.
`safaridriver` ships as part of macOS/Safari itself — there's no version to
match, no binary to fetch, and no cache to warm. CraftDriver only ever
**locates** the driver Apple already installed. The single prerequisite is
turning automation on once per Mac with `safaridriver --enable`.

See the [**Safari guide**](./safari.md) for setup and capabilities, and
[Driver Configuration → Safari](./driver-configuration.md#safari-macos-driver-ships-with-the-browser)
for the driver-resolution chain.
