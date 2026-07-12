# Recipe snippet tests

Each file here is the **runnable, verified** version of one page in
[`docs/recipes/`](../../docs/recipes/). They run as a dedicated CI gate:

```bash
npm run serve &        # serve examples/ on http://127.0.0.1:8080
npm run test:recipes   # Chrome, headless
```

They are **excluded from the default `npm test` run** (see
`vitest.config.ts`) so they aren't double-run and Chrome-only recipes (mobile
emulation) don't fail under the Firefox suite.

## The mirror rule

The recipes use a two-file approach on purpose: the Markdown shows a short,
readable snippet with a **literal, clickable** deployed URL
(`https://dtopuzov.github.io/craftdriver/examples/…`), while the test proves the
same flow against the local server.

To keep them honest, **the test's core is line-for-line identical to the MD
snippet.** The only differences are:

- the base URL — the test uses `EXAMPLES_BASE_URL` from `../utils`, the MD uses
  the literal deployed URL;
- the launch/quit wrapper — the test adds `beforeAll`/`afterAll` (and cleanup);
  the MD shows only what the recipe is teaching.

When you edit a recipe, edit both files and keep the cores in sync.

## Exception: Electron recipes

The Electron recipes in [`docs/recipes/`](../../docs/recipes/)
(`electron-native-dialog`, `electron-mock-apis`, `electron-deep-link`,
`electron-app-from-another-repo`) have **no counterpart here** on purpose. This
harness is browser-only — it drives `examples/` pages over HTTP in Chrome — while
those recipes need a packaged Electron app and its chromedriver.

Their flows are verified in [`tests/electron/`](../electron/) instead, against the
real packaged example app (downloaded by `tests/electron/global-setup.ts`, run via
`npm run test:electron`): native-dialog mocking and the general `mock()` in
`electron-main-process.test.ts`, deep links in `electron-deeplink.test.ts`. So the
mirror rule holds — just against a different fixture and CI gate.
