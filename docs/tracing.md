# Tracing

Tracing captures a chronological log of what happened during a session —
console output, page errors, network requests/responses, and navigations
— and writes it to a JSON file you can replay or attach to a CI failure.
Optionally, periodic screenshots are written to a sibling folder so you
can see the page at each step.

> **BiDi-only.** Tracing relies on WebDriver BiDi events. Launch with
> the default `enableBiDi: true`.

## Quick start

```ts
import { Browser } from 'craftdriver';
import { By } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });

await browser.startTrace();
await browser.navigateTo('https://example.com');
await browser.click(By.text('More information'));
await browser.stopTrace('./traces/example.json');

await browser.quit();
```

`./traces/example.json` now contains a bundle like:

```json
{
  "startedAt": "2026-05-03T10:42:16.533Z",
  "endedAt":   "2026-05-03T10:42:18.901Z",
  "events": [
    { "t": 21,  "type": "navigation", "url": "https://example.com/", "context": "1A2B…" },
    { "t": 54,  "type": "request",    "url": "https://example.com/", "method": "GET" },
    { "t": 112, "type": "response",   "url": "https://example.com/", "status": 200 },
    { "t": 350, "type": "console",    "level": "info", "text": "ready" },
    { "t": 1430, "type": "navigation", "url": "https://www.iana.org/help/example-domains" }
  ]
}
```

`t` is milliseconds since `startTrace()` was called.

## Recording screenshots

Pass `{ screenshots: true }` to capture a PNG of the page at a fixed
interval (default 1 s). Screenshots land in a `screenshots/` directory
next to the JSON file, and a corresponding `screenshot` event is added
to the bundle.

```ts
await browser.startTrace({ screenshots: true, screenshotInterval: 500 });
await browser.navigateTo('/checkout');
await browser.click('#pay');
await browser.stopTrace('./traces/checkout.json');
// ./traces/checkout.json
// ./traces/screenshots/0001.png
// ./traces/screenshots/0002.png  ...
```

The minimum interval is 100 ms.

## Event types

| `type`       | Fields                                          | Source                            |
| ------------ | ----------------------------------------------- | --------------------------------- |
| `console`    | `level`, `text`                                 | `log.entryAdded` (console)        |
| `error`      | `text`                                          | `log.entryAdded` (page errors)    |
| `request`    | `url`, `method`, `requestId?`                   | `network.beforeRequestSent`       |
| `response`   | `url`, `status`, `requestId?`                   | `network.responseCompleted`       |
| `navigation` | `url`, `context?`                               | `browsingContext.navigationStarted` |
| `screenshot` | `file` (relative to the JSON's directory)       | the periodic timer                |

All events also carry `t: number` (ms since start).

## API

```ts
browser.startTrace(opts?: {
  screenshots?: boolean;       // default false
  screenshotInterval?: number; // default 1000ms, min 100ms
}): Promise<void>;

browser.stopTrace(path: string): Promise<TraceBundle>;
```

- `startTrace()` throws if a trace is already running, or if BiDi is
  disabled.
- `stopTrace(path)` writes the JSON file (creating parent dirs) and
  returns the in-memory bundle. Throws if no trace is running.
- `browser.quit()` silently aborts any in-flight trace so the timer is
  cleaned up; you still need to call `stopTrace()` if you want a file.

## Tips

- Wrap a flaky test in `startTrace`/`stopTrace` to capture exactly what
  happened the moment it failed — and attach the JSON as a CI artifact.
- The trace bundle is a plain JS object — `for (const e of bundle.events)`
  works in your test runner's `afterEach` to assert "no console errors
  were logged" or "exactly 1 POST to /api/login was made".
- Screenshots are full-viewport PNGs; keep the interval modest (≥ 250 ms)
  to avoid IO churn on long traces.
