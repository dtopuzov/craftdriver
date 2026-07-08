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
| 3    | Project-local binaries in `node_modules/.bin`                           |
| 4    | Binaries already available on `PATH`                                    |
| 5    | Auto-resolved and cached driver matching the installed browser          |

If a browser update leaves a cached driver stale, CraftDriver retries once with a refreshed driver instead of making you clear the cache manually.

## CI Friendly

The default setup works well on CI runners that already include Chrome or Firefox. For stricter environments, you can pin the driver path or run offline:

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

See [Driver Configuration](./driver-configuration.md) for the full reference.
