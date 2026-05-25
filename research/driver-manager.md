# Driver Manager — Master Plan

**Status:** approved, implementation in progress.
**Date:** 2026-05.

---

## Strategy: System-first, driver-only download, CfT browser as opt-in

### Core principle

Download **only the driver binary** (chromedriver / geckodriver) against the
system browser. Do not download the browser itself by default.

**Why not CfT browser download by default:**

- CfT is a bare zip, not an OS package. On lean CI containers (debian:slim,
  alpine-derived) it silently fails with missing `libatk`, `libdbus`, etc.
  Those deps change per CfT release — impossible to maintain reliably.
- The system browser (installed via apt/brew/installer) carries all its own
  deps. It is the reliable zero-surprise baseline.
- The **driver binary** is a small, self-contained executable (~15 MB)
  with zero OS-level dependencies. Safe to download anywhere.

**Why not a network call on every test run:**

- Chrome detection is local (`/path/to/chrome --version`). The result is the
  exact version key for the driver cache.
- Once a driver for version `139.0.7258.67` is cached, the cache key never
  expires. The binary is always valid for that exact Chrome version.
- A new HTTP call only happens when the system Chrome updates and we encounter
  a new version key — exactly when we need a new driver.
- For geckodriver: a 24 h TTL prevents repeated GitHub API calls. geckodriver
  is version-insensitive across modern Firefox releases.

---

## Resolution chain

```
1. options.binaryPath                        (explicit constructor arg)
2. CRAFTDRIVER_DRIVER_PATH env var           (craftdriver-specific pin)
3. CHROMEDRIVER_PATH / SE_CHROMEDRIVER       (legacy / SE compat)
   GECKODRIVER_PATH / GECKODRIVER_FILEPATH / SE_GECKODRIVER
4. node_modules/.bin/chromedriver|geckodriver (locally installed npm pkg)
5. PATH probe  (`which chromedriver`)
6. [CRAFTDRIVER_OFFLINE set → throw here]
7. System browser detect + driver download   ← DEFAULT happy path
     Chrome: /path/to/chrome --version → detect version
             → check ~/.cache/craftdriver/chromedriver/<version>/<platform>/
             → if missing: HTTP → CfT JSON → download driver zip → extract
     Firefox: same with geckodriver + 24 h TTL on "latest" check
8. CfT browser download (opt-in: CRAFTDRIVER_USE_CfT=1)
```

---

## Cache layout

```
~/.cache/craftdriver/
  chromedriver/
    139.0.7258.67/
      mac-arm64/
        chromedriver            ← permanent cache, no TTL needed
      linux64/
        chromedriver
  geckodriver/
    v0.35.0/
      mac-arm64/
        geckodriver
  metadata.json                 ← geckodriver TTL + path record only
```

`metadata.json` keys:
- `geckodriver/<platform>` → `{ version, driverPath, timestamp }`

Chrome needs no metadata entry: the cache key IS the browser version; if the
binary exists it is always valid.

---

## Env vars

| Variable | Purpose | Default |
|---|---|---|
| `CRAFTDRIVER_CHROMEDRIVER_PATH` | Absolute path to chromedriver binary | — |
| `CRAFTDRIVER_GECKODRIVER_PATH` | Absolute path to geckodriver binary | — |
| `CRAFTDRIVER_DRIVER_PATH` | Generic fallback path (applies to whichever browser is resolving) | — |
| `CRAFTDRIVER_BROWSER_PATH` | Absolute path to browser binary (future use) | — |
| `CRAFTDRIVER_CACHE_DIR` | Override `~/.cache/craftdriver/` | `~/.cache/craftdriver` |
| `CRAFTDRIVER_USE_CfT` | Opt in to CfT browser download | unset |
| `CRAFTDRIVER_OFFLINE` | Skip all network, fail on cache miss | unset |
| `CRAFTDRIVER_DRIVER_TTL` | geckodriver TTL in seconds | `86400` |

Resolution order for env vars:
1. `CRAFTDRIVER_CHROMEDRIVER_PATH` / `CRAFTDRIVER_GECKODRIVER_PATH` (browser-specific)
2. `CRAFTDRIVER_DRIVER_PATH` (generic fallback — use only when pinning a single-browser setup)
3. Legacy: `CHROMEDRIVER_PATH`, `SE_CHROMEDRIVER` / `GECKODRIVER_PATH`, `GECKODRIVER_FILEPATH`, `SE_GECKODRIVER`

---

## Implementation files

- `src/lib/driverManager.ts` — all resolution + download logic
- `src/lib/chrome.ts` — override `start()` to call `resolveChromeDriver()`
- `src/lib/firefox.ts` — override `start()` to call `resolveFirefoxDriver()`

No new public API. `ChromeService` and `FirefoxService` constructors remain
unchanged. Auto-resolution is a transparent internal behaviour.

---

## Platform support matrix

| Platform | Chrome binary detection | chromedriver platform key | geckodriver asset |
|---|---|---|---|
| macOS arm64 | `/Applications/Google Chrome.app/...` | `mac-arm64` | `macos-aarch64` |
| macOS x64 | `/Applications/Google Chrome.app/...` | `mac-x64` | `macos` |
| Linux x64 | `google-chrome`, `chromium`, … on PATH | `linux64` | `linux64` |
| Windows x64 | `C:\Program Files\Google\Chrome\...` | `win64` | `win64` |

---

## What is NOT done (future work)

- `CRAFTDRIVER_USE_CfT=1`: download CfT browser+driver pair (for CI where
  there is no system browser). Implementation is straightforward but deferred
  until there is a real use-case and we can test the dep-install story.
- Firefox version → geckodriver version matching (not needed; current latest
  geckodriver supports all Firefox 115+).
- `craftdriver install` CLI subcommand for explicit pre-download.
- SHA256 verification of downloaded archives.
- File locking for parallel test worker safety.
