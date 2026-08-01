# Visual testing

`browser.expectScreenshot()` compares a fresh browser screenshot against a PNG
baseline in your repository, retrying until it matches or a timeout elapses. On
a mismatch it throws a typed error carrying the final screenshot and a generated
diff image so you can see exactly what changed.

Baselines are managed for you, so the first run of a new test just works:

- **No baseline yet** — the screenshot is captured until two consecutive frames
  are identical (so a mid-animation frame isn't enshrined) or `timeout` elapses,
  then written to the path you gave, and the assertion passes. Commit that PNG.
  If the page never settled before the timeout, the write is an arbitrary frame
  and the stderr line says so (`… page did not settle …`) — review it first.
- **Baseline matches** — passes.
- **Baseline differs** — throws `VisualMismatchError`. It is **never** rewritten
  unless you explicitly ask (see [Updating baselines](#updating-baselines)).

Behaviour is identical on your laptop and in CI — there is no "CI mode" that
does something different. One tradeoff comes with the convenience: if a
committed baseline is _deleted_, the next run recreates it and passes. Every
create and update is printed to stderr (`[craftdriver] Created visual
baseline: …`) so it shows up in your logs, but the real guard is committing your
baselines and reviewing the diff whenever one changes.

## The shortest thing that works

```typescript
// First run creates baselines/home.png; commit it. Every run after asserts
// against it — same call, no separate bootstrap step.
await browser.expectScreenshot('baselines/home.png', {
  screenshot: { fullPage: true },
});
```

`expectScreenshot()` returns a result object on success (`baseline`, `matches`,
`diffPixels`, `diffPercentage`, `attempts`, `elapsedMs`, and both images'
dimensions) and throws [`VisualMismatchError`](./error-codes.md) on failure.
`result.baseline` is `'created'`, `'matched'`, or `'updated'` — what happened to
the file on disk this run.

## Capture scope

`screenshot` chooses what to capture and is passed straight through to
`browser.screenshot()`. The three forms mirror that method and are mutually
exclusive:

| `screenshot`             | Captures                     | Notes                                            |
| ------------------------ | ---------------------------- | ------------------------------------------------ |
| omitted                  | the visible viewport         | BiDi viewport capture; Classic fallback.         |
| `{ fullPage: true }`     | the full scrollable document | Requires BiDi (`enableBiDi: true`, the default). |
| `{ selector: '#chart' }` | one element                  | Auto-waits for the element like `find()`.        |

`fullPage` and `selector` together are rejected — by the TypeScript types and,
for JavaScript callers, at runtime with `INVALID_ARGUMENT`. Always baseline and
assert with the same scope; a full-page baseline compared against a viewport
capture is just a dimension mismatch.

When BiDi is connected, viewport capture uses the layout viewport directly, so
its dimensions match `document.documentElement.clientWidth/clientHeight` times
the device pixel ratio. This deliberately excludes the classic scrollbar from
the captured content width. Classic-only sessions fall back to the browser's
WebDriver screenshot command.

## Thresholds

By default the comparison is exact: any differing pixel fails. Loosen it with
three independent policies.

```typescript
await browser.expectScreenshot('baselines/home.png', {
  pixelTolerance: 5, // per-channel RGB slack, 0..255 (default 0)
  maxDiffPixels: 100, // allow up to 100 differing pixels
  maxDiffPercentage: 0.1, // …and no more than 0.1% of all pixels
});
```

- **`pixelTolerance`** — a pixel counts as equal when the absolute difference of
  every visible R, G and B channel is `<= pixelTolerance`. Use it to absorb tiny
  codec/renderer noise.
- **`maxDiffPixels`** / **`maxDiffPercentage`** — budgets for how many pixels may
  still differ after `pixelTolerance` is applied. Each boundary is **inclusive**.
- If you set **neither** budget, the image must have zero differing pixels.
- If you set **both**, **both** must pass.
- Dimensions are never resized to match. Different dimensions always fail,
  regardless of tolerance — resizing would hide the layout regressions you are
  trying to catch.

All values are validated, never clamped: a non-integer `pixelTolerance`, a
percentage above 100, an `interval` below 10 ms, and similar out-of-range inputs
throw `INVALID_ARGUMENT`.

### Ignoring anti-aliasing

Anti-aliasing along text and edges is the most common source of
platform-to-platform noise. `ignoreAntialiasing` classifies edge-smoothing
pixels and excludes them from the difference count (reporting them separately as
`ignoredAntialiasPixels`):

```typescript
await browser.expectScreenshot('baselines/home.png', {
  ignoreAntialiasing: true,
});
```

It is **off by default on purpose**. Silently ignoring pixels is a policy
decision that can hide thin, genuine regressions, so you opt in explicitly. It
ignores edge smoothing but still counts moved edges, missing glyphs, and
one-pixel layout shifts.

## Handling a mismatch

`VisualMismatchError` carries the two things you actually want when a visual
test fails: the final screenshot and a diff image. Persist them as CI artifacts:

```typescript
import { writeFile } from 'node:fs/promises';
import { VisualMismatchError } from 'craftdriver';

try {
  await browser.expectScreenshot('baselines/home.png', { timeout: 3_000 });
} catch (error) {
  if (error instanceof VisualMismatchError) {
    await writeFile('artifacts/home.actual.png', error.actual);
    await writeFile('artifacts/home.diff.png', error.diff);
  }
  throw error;
}
```

In the diff image, unchanged areas appear as a dimmed grayscale copy of the
actual screenshot, counted differences are red, ignored anti-aliased pixels are
yellow, and regions present in only one image (a dimension mismatch) are
magenta. `error.detail` holds the JSON-safe summary (path, dimensions, counts,
percentage, attempts, elapsed time) for logs and agents; the two `Buffer`s live
on `error.actual` / `error.diff`.

Baseline read/decode failures are treated as configuration errors, not visual
mismatches — they are not retried, and their cause is preserved.

## Updating baselines

When a change is intentional, re-run with the update flag set and craftdriver
overwrites the differing baselines with the new screenshots instead of failing:

```bash
CRAFTDRIVER_UPDATE_VISUAL_BASELINES=true npm test
```

There is no separate "save" API and no CLI flag — craftdriver has no test runner
of its own, so the switch is one environment variable you set for a single run.
While it is set:

- A **missing** baseline is still created and passes (that never needed the flag).
- A **matching** baseline passes untouched.
- A **differing** baseline is captured until the deadline, then overwritten with
  the final screenshot; the assertion passes with `result.baseline === 'updated'`.
  A page that settles back into a match passes _without_ rewriting, so you don't
  get spurious baseline churn.

Every rewrite is printed — `[craftdriver] Updated visual baseline: <path> (<n>
px, <p>% changed)`. Review the resulting diff in version control before you
commit it; that review is the safety net this flag deliberately leaves to you.

Rewrites are atomic: the new baseline is written to a temporary file and renamed
into place, so an interrupted run or disk error can never leave a truncated or
half-updated committed baseline — the existing one survives intact.

Parsing is strict, because the flag mutates files on disk: `true` turns it on,
`false` or unset leaves it off, and any other value (`1`, `yes`, …) throws
`INVALID_ARGUMENT` rather than being quietly ignored. A baseline that exists but
can't be decoded stays a hard error even here — it is never overwritten. To
replace a corrupt baseline, delete it and let the next run recreate it.

## Retries and timing

Each assertion reads the baseline once, then screenshots and compares on a loop
until it matches or `timeout` (default: the browser's default timeout, 5000 ms)
expires, waiting `interval` ms (default 50) between attempts. The first
screenshot is always taken immediately, even with `timeout: 0`. This absorbs a
page that is still settling — a chart finishing its layout, a font swapping in.

```typescript
await browser.expectScreenshot('baselines/chart.png', {
  screenshot: { selector: '#chart' },
  timeout: 3_000,
  interval: 100,
});
```

The happy path is cheap: an identical screenshot matches on a byte comparison
without ever decoding a PNG. But **byte equality is only a fast _positive_
path** — two genuinely-equivalent renders can still produce different bytes, so
a mismatch always falls back to a real pixel comparison.

## Making CI deterministic

Most visual-test pain is non-determinism, not craftdriver. The same page renders
differently across machines — **macOS and Linux genuinely rasterize different
pixels**, so a baseline captured on your Mac will not match a Linux CI runner.
Pin the environment:

- Capture baselines in the **same OS image** you run CI on (or keep per-platform
  baselines). This is the big one.
- Fix the **browser and version**, the **viewport size**, and the **device pixel
  ratio** (a HiDPI runner captures twice the pixels of a 1× one).
- Freeze **fonts** (ship them with the app/test image so font substitution can't
  shift text), **locale**, and **timezone**.
- Disable **animations** and honor **reduced motion**; freeze time with the
  [virtual clock](./clock.md) when content is time-dependent.
- Prefer a headless, consistent rendering path over whatever is on a developer
  laptop.

Start strict (`pixelTolerance: 0`) and only add tolerance once you understand
which pixels move and why. A large blanket tolerance turns a visual test into a
test that passes no matter what.

## Comparing buffers directly

If you already have two PNG buffers and just want the comparison — no disk, no
browser, no retries — use `compareScreenshots(actual, expected, options)`. It
applies the same threshold semantics and input limits and returns the result
instead of throwing on a normal mismatch:

```typescript
import { compareScreenshots } from 'craftdriver';

const result = await compareScreenshots(actualPng, expectedPng, {
  pixelTolerance: 3,
  maxDiffPixels: 50,
});
console.log(result.matches, result.diffPixels, result.diffPercentage);
```

The argument order is always `(actual, expected)` — everywhere in the API.

## Input limits and scope

Before decoding, both images are checked against `maxImagePixels` (default 20
million pixels) and `maxInputBytes` (default 50 MiB), with the size validated
from the PNG header before any large allocation. Decoded RGBA is ~4 bytes per
pixel, and an assertion may hold the expected image, the latest actual image, and
a diff at once, so raise `maxImagePixels` deliberately for unusually long
full-page screenshots — and consider lowering it when many test workers run in
parallel.

This feature is built for a developer-controlled baseline and a screenshot
produced by the browser under test. The low-level comparator is **not** a
hardened service for arbitrary user-uploaded images; if that ever becomes a
requirement, decoding needs to move to a terminable worker with a hard CPU
deadline (an in-process timeout cannot interrupt a synchronous parser).

## Under the hood

PNG decoding and encoding go through a single pinned dependency, `pngjs`, behind
an internal codec seam. It is a pure-JavaScript package with no native addon,
WASM, install script, or transitive runtime dependencies — chosen so the
security and packaging story stays simple. The optional anti-alias detector is
adapted from [Pixelmatch](https://github.com/mapbox/pixelmatch) (ISC licensed;
attribution is preserved in the source).
