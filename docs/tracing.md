# Tracing

Capture an append-only recording of a browser session for **bug
investigation**. Every event is written synchronously to a line-delimited
JSON file as it happens, so a thrown `expect`, a failed locator, or a
process crash cannot lose the evidence that led up to it.

> **BiDi-only.** Tracing piggybacks on the same BiDi subscriptions used
> by `browser.logs` and `browser.network`. Calling `startTrace()` without
> `enableBiDi: true` throws.

## Quick start

```ts
import { chromium } from 'craftdriver';

const browser = await chromium.launch();

await browser.startTrace({ outDir: './artefacts/login' });
try {
  await browser.navigateTo('http://127.0.0.1:8080/login.html');
  await browser.fill('#user', 'alice');
  await browser.click('#submit');
} finally {
  await browser.stopTrace();
}
```

After the run you get:

```
artefacts/login/
├── trace.ndjson                  ← one JSON event per line
└── screenshots/
    ├── 0001.png
    └── 0002.png
```

`try/finally` is the recommended shape, but it's a courtesy — see the
next section.

## Export for Vibium Player

Pass a zip path when stopping the trace to create a portable recording that
opens in [Vibium Player](https://player.vibium.dev/) and Playwright Trace
Viewer:

```ts
await browser.startTrace({
  outDir: './artefacts/login-raw',
  title: 'Login flow',
});

try {
  await browser.navigateTo('https://example.com/login');
  await browser.fill('#user', 'alice');
  await browser.click('#submit');
} finally {
  await browser.stopTrace({ path: './artefacts/login.zip' });
}
```

The raw `trace.ndjson` remains the crash-resilient source. The zip is produced
during `stopTrace()` and contains the Vibium/Playwright layout:

```text
login.zip
├── trace.trace       # context-options + before/after actions + browser events
├── trace.network     # HAR-style resource-snapshot events
└── resources/        # PNG frames referenced by screencast-frame events
```

Vibium Player is the recommended online viewer. For local-only inspection:

```sh
npx playwright show-trace ./artefacts/login.zip
```

The export includes Craftdriver actions, screenshots, screenshot-backed frame
snapshots, navigation/console events, and the network metadata that WebDriver
BiDi exposes to the tracer. Screenshot-backed snapshots make the main panel of
Playwright Trace Viewer useful while staying honest: they are not a restorable
DOM. Response bodies and source files remain future work. Browser action spans
use real start/end times and preserve thrown action errors.

## What happens when a test throws

Every recorded event hits disk **before** the next line of your test
runs (synchronous `writeSync` on an open file descriptor). So if your
test throws halfway through — `expect.toBeVisible()` times out, a click
misses, an a11y check fails — the partial `trace.ndjson` already
contains every action, console message, network event, navigation, and
screenshot reference that led up to the failure.

NDJSON has no closing bracket and no header. Partial files are valid
NDJSON: any reader simply ignores a truncated final line. The only
thing missing when `stopTrace()` doesn't run is a trailing
`{"type":"meta","endedAt":"…"}` line — readers infer the end time from
the last event's `t` field.

The same is true for screenshots: each PNG is a self-contained file
written as the capture resolves, so the ones taken before the failure
are intact on disk.

You don't need `try/finally` for correctness — only to write the closing
meta marker and close the file handle cleanly. `browser.quit()` will
close the handle for you on its way out.

## What gets recorded

Each line in `trace.ndjson` is one event. All events carry `t` (ms
since `startTrace`) and a `type`:

| `type`         | Fields                                                      |
| -------------- | ----------------------------------------------------------- |
| `meta`         | `startedAt` / `endedAt`, `opts` on the start line           |
| `action`       | `actionIndex`, `name`, `args?`, `selector?`                 |
| `action-end`   | `actionIndex`, `error?`                                     |
| `console`      | `level`, `text`                                             |
| `error`        | `text` (uncaught page errors)                               |
| `request`      | `url`, `method`, `requestId?`                               |
| `response`     | `url`, `status`, `mimeType?`, `fromCache?`, `requestId?`    |
| `navigation`   | `url`, `context?`                                           |
| `screenshot`   | `file` (relative path), `reason` (`'action'` \| `'error'` \| `'final'`), `actionIndex?` |

Actions currently logged: `navigateTo`, `goBack`, `goForward`, `reload`,
`setContent`, `click`, `fill`, `clear`, `acceptDialog`, `dismissDialog`.

## Screenshots: evidence, not video

Screenshots are tied to **meaningful moments**, not a timer:

* Before every logged action — answers *"what did the page look like
  when I clicked?"*
* On every page error — answers *"what was on screen when it broke?"*
* Once when `stopTrace()` runs — preserves the state left by the final action
  or failed assertion.

A 30-second test with 5 clicks produces 5 PNGs, not 300. Turn it off
when you only want the JSON log:

```ts
await browser.startTrace({ outDir: './t', screenshots: 'off' });
```

`screenshots: 'auto'` (default), `true`, and omitting the option all
mean the same thing.

## Selectively disable pillars

Every pillar is on by default. Switch off what you don't need:

```ts
await browser.startTrace({
  outDir: './t',
  actions: true,
  screenshots: 'auto',
  network: false,   // skip request/response events
  console: false,   // skip console + error events
});
```

`actions: false` keeps the timeline but stops adding action events (and
the screenshots that ride along with them).

## Reading a trace

NDJSON is trivial to grep, even mid-run:

```sh
# All errors and the action that preceded them
jq -c 'select(.type=="error" or .type=="action")' trace.ndjson

# Failed network responses
jq -c 'select(.type=="response" and .status>=400)' trace.ndjson

# Find the screenshot for action #7
jq -c 'select(.actionIndex==7)' trace.ndjson
```

```ts
// Programmatic:
import { readFileSync } from 'node:fs';
const events = readFileSync('trace.ndjson', 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
```

## Using with Vitest

Vitest doesn't have Playwright-style fixtures, but a small helper using
its `beforeEach` / `afterEach` hooks gets you **automatic per-test
tracing with keep-on-failure**. One line per `describe()`, no per-test
boilerplate.

Drop this into your test folder (e.g. `tests/auto-trace.ts`):

```ts
import { beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, TraceScreenshotMode } from 'craftdriver';

const ROOT  = process.env.CRAFTDRIVER_TRACE_DIR ?? './traces';
const MODE  = (process.env.CRAFTDRIVER_TRACE ?? 'on-failure') as
  'always' | 'on-failure' | 'off';
const SHOTS = (process.env.CRAFTDRIVER_TRACE_SCREENSHOTS ?? 'auto') as
  TraceScreenshotMode;

export function autoTrace(getBrowser: () => Browser): void {
  if (MODE === 'off') return;
  let currentDir = '';

  beforeEach(async ({ task }) => {
    currentDir = join(ROOT, safeName(task));
    await getBrowser().startTrace({ outDir: currentDir, screenshots: SHOTS });
  });

  afterEach(async ({ task }) => {
    const failed = task.result?.state === 'fail';
    const keep = MODE === 'always' || failed;
    const zipPath = `${currentDir}.zip`;
    try {
      await getBrowser().stopTrace(keep ? { path: zipPath } : undefined);
    } catch { return; }
    if (MODE === 'on-failure' && !failed) {
      rmSync(currentDir, { recursive: true, force: true });
    } else if (failed) {
      console.error(`  📦 Vibium trace: ${zipPath}`);
    }
  });
}

function safeName(t: { name: string; suite?: { name: string } | null }): string {
  const parts: string[] = [];
  let s: typeof t | null | undefined = t;
  while (s && s.name) { parts.unshift(s.name); s = s.suite; }
  return parts.join('/').replace(/[^a-z0-9/]+/gi, '-').toLowerCase();
}
```

Use it inside any `describe()`:

```ts
import { autoTrace } from './auto-trace';

describe('Login', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await Browser.launch(); });
  afterAll(async () => { await browser.quit(); });

  autoTrace(() => browser);   // ← that's it

  it('signs in', async () => {
    await browser.navigateTo('http://127.0.0.1:8080/login.html');
    await browser.fill('#user', 'alice');
    await browser.click('#submit');
    // If this expect throws, ./traces/login/signs-in.zip opens in Vibium Player.
  });
});
```

Knobs are all environment variables — switch behaviour without touching code:

| Env var | Values | Default | Effect |
| --- | --- | --- | --- |
| `CRAFTDRIVER_TRACE` | `off` \| `on-failure` \| `always` | `on-failure` | What to keep. `on-failure` deletes traces for passing tests. |
| `CRAFTDRIVER_TRACE_DIR` | path | `./traces` | Root output directory. |
| `CRAFTDRIVER_TRACE_SCREENSHOTS` | `auto` \| `off` | `auto` | Per the `screenshots` option. `off` skips the BiDi capture per action — much faster when you only need the JSON timeline. |

Typical workflows:

```sh
npm test                                  # green run leaves no clutter; failures keep their trace
CRAFTDRIVER_TRACE_SCREENSHOTS=off npm test    # cheap mode for big suites
CRAFTDRIVER_TRACE=always npm test         # debugging the tracer itself
CRAFTDRIVER_TRACE=off npm test            # tracing disabled
```

Why a helper and not built-in? Vitest owns the test lifecycle, not
craftdriver — and the runner-specific glue (pass/fail detection, hook
order, output paths) belongs on your side. The helper is ~30 lines you
can read, copy, and adjust to your team's conventions.

### One trace for the whole suite

If the desired boundary is exactly `beforeAll()` → `afterAll()`, record the
suite continuously and remember failures in `afterEach()`. A passing suite
does not create a zip; a failing suite does:

```ts
import { afterAll, afterEach, beforeAll, describe } from 'vitest';
import { rmSync } from 'node:fs';
import { Browser } from 'craftdriver';

describe('checkout', () => {
  let browser: Browser;
  let failed = false;
  const rawDir = './traces/checkout-raw';
  const zipPath = './traces/checkout-failure.zip';

  beforeAll(async () => {
    browser = await Browser.launch();
    await browser.startTrace({ outDir: rawDir, title: 'Checkout suite' });
  });

  afterEach(({ task }) => {
    failed ||= task.result?.state === 'fail';
  });

  afterAll(async () => {
    await browser.stopTrace(failed ? { path: zipPath } : undefined);
    if (!failed) rmSync(rawDir, { recursive: true, force: true });
    await browser.quit();
  });

  // ...tests...
});
```

## API

### `browser.startTrace(opts)`

```ts
interface TraceStartOptions {
  outDir: string;                               // required
  actions?: boolean;                            // default true
  network?: boolean;                            // default true
  console?: boolean;                            // default true
  screenshots?: boolean | 'auto' | 'off';       // default 'auto'
  title?: string;                                // viewer title
}
```

Creates `outDir` if missing, opens `outDir/trace.ndjson` for writing,
and emits the start `meta` line. Throws if a trace is already running
or BiDi is not enabled.

### `browser.stopTrace(opts?)`

Captures the final page state, drains in-flight screenshot captures, writes the closing `meta` line,
and closes the file. With `{ path: './trace.zip' }`, it also exports a
Vibium/Playwright-compatible zip. Returns `Promise<void>`. Throws if no
trace is active.

### Cleanup on `browser.quit()`

If a trace is still running when you quit the browser, the file is
closed without a closing `meta` line — same shape as the test-throws
case. No file is deleted.

## What this is *not*

By design, the tracer does not:

* record video / fixed-interval screencast,
* capture a restorable DOM or sourcemaps.

The raw NDJSON stays deliberately small and tail-able; richer portable
features can be added to the zip format without weakening crash resilience.
