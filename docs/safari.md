# Safari

CraftDriver drives **real desktop Safari on macOS** through W3C WebDriver
Classic.

## One-time setup

Safari's driver (`safaridriver`) ships with macOS — **nothing to install or
download**. You only have to turn on automation **once per machine**:

```bash
safaridriver --enable
```

This is the single prerequisite.

CraftDriver never runs `--enable` for you. If automation isn't enabled, a
launch fails immediately with that exact remedy rather than hanging.

## Quick start

```typescript
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'safari' });
await browser.navigateTo('http://127.0.0.1:8080/login.html');
await browser.getByLabel('Username').fill('alice');
await browser.getByLabel('Password').fill('secret');
await browser.getByRole('button', { name: 'Sign in' }).click();
await browser.expect('#welcome').toHaveText('Welcome back, alice!');
await browser.quit();
```

Same API as every other browser — locators, actions, assertions, and
auto-waiting all work unchanged.

## What works

Navigation, locators, and element queries · click / fill / clear / keyboard /
desktop mouse · `evaluate()` (sync & async JS) · frames and iframes · window &
popup enumeration · **imperative dialogs** (`getAlertText` / `acceptAlert` /
`dismissAlert` / `sendAlertText`) · viewport and element screenshots · cookies
and storage (via the standard Classic cookie endpoints) · accessibility checks.

## What isn't supported

Safari exposes no WebDriver BiDi endpoint, so everything event- or
BiDi-driven is unavailable — and each of these throws a clear
[`UNSUPPORTED`](./error-codes.md) error immediately, never a silent hang:

- network mocking / interception and request/response waits
- console & JavaScript-error capture, tracing
- BiDi user contexts and emulation (permissions, geolocation,
  locale/timezone, offline, color-scheme)
- init/preload scripts and the virtual clock
- event-driven dialogs (`onDialog` / `waitForDialog`) — use the imperative
  methods above
- full-page screenshots and `openPage()`
- CraftDriver-managed downloads (`waitForDownload`)

Desktop Safari is also **not** iPhone/iPad Safari — there is no mobile or
touch emulation.

## Limitations to plan around

- **macOS-only.** There is no Safari for Linux or Windows, and none is coming.
  Trying to launch Safari off macOS throws `UNSUPPORTED`.
- **Headed only.** No headless mode — every launch opens a visible automation
  window (with a purple banner). Don't interact with it while a test runs.
  Setting `HEADLESS=true` with Safari is rejected up front.
- **Serial only.** Only one Safari WebDriver session can be active on a Mac at
  a time. A second concurrent launch is refused with an actionable error
  (never a hang) — run Safari tests serially.

## Safari Technology Preview

STP ships its own `safaridriver`; point `SafariService` at it. This is also
the one way to get a **second concurrent session** on one Mac — stable Safari
and STP each run one session at the same time.

```typescript
import { Browser, SafariService } from 'craftdriver';

const browser = await Browser.launch({
  browserName: 'safari',
  safariService: new SafariService({
    binaryPath: '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver',
  }),
});
```

Enable automation once for STP too: `/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver --enable`.

## Running Safari tests

Run Safari **serially** — one session at a time. With Vitest that's
`--maxWorkers=1`:

```bash
vitest run --maxWorkers=1
```

Keep it headed (don't set `HEADLESS`), on macOS with Remote Automation enabled.
In CI, use a macOS runner; parallelism across Safari needs **separate macOS
hosts**.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `You must enable 'Allow remote automation'…` | Run `safaridriver --enable` once (see [setup](#one-time-setup)). |
| Second launch fails while one session is open | Expected — Safari is serial. Serialize your tests, or use STP for a second session. |
| `Could not find 'safaridriver'` | You're not on macOS, or Safari is missing. For a non-standard install, set `CRAFTDRIVER_SAFARIDRIVER_PATH` or `SafariService({ binaryPath })`. |

## See also

- [Driver Configuration → Safari](./driver-configuration.md#safari-macos-driver-ships-with-the-browser) — the no-download driver-resolution chain.
- [WebDriver Standards](./standards.md#safari-is-classic-only) — why Safari is Classic-only.
