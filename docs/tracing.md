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
| `action`       | `name`, `args?`, `selector?`                                |
| `console`      | `level`, `text`                                             |
| `error`        | `text` (uncaught page errors)                               |
| `request`      | `url`, `method`, `requestId?`                               |
| `response`     | `url`, `status`, `mimeType?`, `fromCache?`, `requestId?`    |
| `navigation`   | `url`, `context?`                                           |
| `screenshot`   | `file` (relative path), `reason` (`'action'` \| `'error'`), `actionIndex?` |

Actions currently logged: `navigateTo`, `goBack`, `goForward`, `reload`,
`setContent`, `click`, `fill`, `clear`, `acceptDialog`, `dismissDialog`.

## Screenshots: evidence, not video

Screenshots are tied to **meaningful moments**, not a timer:

* Before every logged action — answers *"what did the page look like
  when I clicked?"*
* On every page error — answers *"what was on screen when it broke?"*

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
import { rmSync, writeFileSync } from 'node:fs';
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
    // Snap the page as it looked at the failed assertion (not just
    // before the last click).
    if (failed) {
      try {
        const buf = await getBrowser().screenshot();
        writeFileSync(join(currentDir, 'final.png'), buf);
      } catch { /* browser may already be dead */ }
    }
    try { await getBrowser().stopTrace(); } catch { return; }
    if (MODE === 'on-failure' && !failed) {
      rmSync(currentDir, { recursive: true, force: true });
    } else if (failed) {
      console.error(`  📁 trace: ${currentDir}`);
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
    // If this expect throws, ./traces/login/signs-in/trace.ndjson is on disk.
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

## API

### `browser.startTrace(opts)`

```ts
interface TraceStartOptions {
  outDir: string;                               // required
  actions?: boolean;                            // default true
  network?: boolean;                            // default true
  console?: boolean;                            // default true
  screenshots?: boolean | 'auto' | 'off';       // default 'auto'
}
```

Creates `outDir` if missing, opens `outDir/trace.ndjson` for writing,
and emits the start `meta` line. Throws if a trace is already running
or BiDi is not enabled.

### `browser.stopTrace()`

Drains in-flight screenshot captures, writes the closing `meta` line,
and closes the file. Returns `Promise<void>`. Throws if no trace is
running.

### Cleanup on `browser.quit()`

If a trace is still running when you quit the browser, the file is
closed without a closing `meta` line — same shape as the test-throws
case. No file is deleted.

## What this is *not*

By design, the tracer does not:

* produce a self-contained `.zip` or hosted viewer,
* record video / fixed-interval screencast,
* emit HAR (the NDJSON already holds request/response events),
* capture DOM snapshots or sourcemaps.

Those features make sense at much larger scale (Playwright Trace
Viewer). For a single failing test, a tail-able NDJSON log plus a
handful of PNGs beats a zip you can't open.
