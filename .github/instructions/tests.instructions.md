---
applyTo: "tests/**"
---

# Writing tests in craftdriver

## Philosophy

Simple, minimal tests that prove **distinct behaviors**. Aim for ~80–90 %
coverage of a feature with the smallest test count that still catches
regressions. Test bloat slows CI, hides intent, makes refactors painful.

Four rules:

1. **One test = one distinct behavior.** If two tests would fail because
   the same line of source broke, you only need one.
2. **Don't re-test wiring through every entry point.** When a default
   flows through one shared getter into `Browser`, `ElementHandle`, and
   `expect()`, write **one** test for the mechanism plus **one** for
   `expect()` (it's a separate code path). Skip the rest.
3. **Always include a happy path.** A suite of only failure assertions
   passes against an implementation that always rejects.
4. **Smoke-test honestly.** If full behavior ships in a later task, a
   `does-not-throw` test is fine — say so in a comment.

Don't write tests for: TypeScript-enforced things, getter-returns-setter,
the same code path with different inputs, internal implementation details.

## Setup pattern — copy this

The house style is **one browser per file** (shared via `beforeAll`).
Per-test isolation comes from `beforeEach` navigation, not from relaunching.

```typescript
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('feature name', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit(); // NO try/catch — let failures surface
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/feature.html`);
  });

  it('does the expected thing', async () => {
    // ... test body
  });
});
```

For BiDi-only features, add `enableBiDi: true` and clear state between tests:

```typescript
beforeAll(async () => {
  browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: true });
});

afterEach(async () => {
  await browser.network?.removeAllIntercepts(); // or logs.clearMessages(), etc.
});
```

## Hard rules

- Import from `'../src'` — **not** `'../src/index.js'`, **not** `'../src/lib/...'`.
- One browser per file via `beforeAll`/`afterAll`. Don't relaunch per test
  unless the test genuinely needs a fresh session (rare — document why).
- **Never** set per-test timeouts in `it()` or hooks. Globals live in
  `vitest.config.ts` (30 s).
- **Never** wrap `await browser.quit()` in `try/catch`.
- **Always** use `EXAMPLES_BASE_URL` and `BROWSER_NAME` from `./utils`.
  No hardcoded `http://127.0.0.1:8080` or `'chrome'`.
- Test names describe **behavior**, not implementation. No numeric
  prefixes (`'logs in'`, not `'1. calls until.elementIsVisible'`).
- **Reuse existing example pages** (`login.html`, `dynamic.html`,
  `selectors.html`, `hover-select.html`, `network.html`, `keyboard.html`)
  before adding a new one.

## Worked example — what "minimal but enough" looks like

Task 3 (configurable timeouts) drafted 11 tests, landed with 7. The cuts:

```text
KEPT
─────────────────────────────────────────────────────────────────
factory default is ~5000 ms              ← no hardcoded number leaked
setDefaultTimeout() shortens waits        ← setter is wired
per-call { timeout } overrides default    ← precedence order
expect() reads the same default           ← separate code path
default change is live for old handles    ← live-getter design choice
does not bite when element is present     ← happy path
setDefaultNavigationTimeout() accepted    ← honest smoke (used by task 2)

CUT (all same wiring as one of the kept tests)
─────────────────────────────────────────────────────────────────
setDefaultTimeout affects browser.click   ✗ same as #2
setDefaultTimeout affects ElementHandle   ✗ same as #2
per-call timeout on browser.click         ✗ same as #3
per-call timeout on ElementHandle         ✗ same as #3
```

Rule of thumb: if the same source line breaks both tests, drop one.

## Timing tests

Use `Date.now()`. Never sleep. Generous tolerances — CI is slow.

```typescript
it('rejects within the configured timeout', async () => {
  browser.setDefaultTimeout(500);
  const start = Date.now();
  await expect(browser.waitForVisible('#missing')).rejects.toThrow();
  expect(Date.now() - start).toBeLessThan(2500); // 5× the configured timeout
});
```

- For "no longer than X" assertions, use `< 3–5×` the configured timeout.
- Only assert a lower bound when proving the timeout is at least the
  factory default (e.g. `> 3500` for 5 s).

## Examples server prerequisite

Tests fetch pages from `EXAMPLES_BASE_URL` (default `http://127.0.0.1:8080`).
**Start the server before running tests:**

```bash
npm run examples:start   # terminal 1 — keep running
npm test                 # terminal 2
```

`ECONNREFUSED` means the server isn't running — start it, don't change the test.

## File naming

- One file per feature: `tests/<feature>.test.ts`.
- Match the example HTML: `tests/feature.test.ts` ↔ `examples/feature.html`.
- BiDi-specific tests: `tests/bidi-<feature>.test.ts`.

## Self-review before committing

1. Could I delete a test and still catch the same regression? → delete it.
2. Is there a happy-path test? → if no, add one.
3. Do all test names describe behavior, not code? → rename if not.
4. Did I add an HTML fixture I didn't need? → reuse an existing one.


