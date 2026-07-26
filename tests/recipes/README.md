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

## Exception: the AI agent recipe

[`ask-an-agent-to-write-a-test`](../../docs/recipes/ask-an-agent-to-write-a-test.md)
is **prompt-first**: its main artifact is a prompt you give Claude Code, Codex,
or Copilot. Prompts and model behavior are not deterministically testable, and
[`ask-an-agent.test.ts`](./ask-an-agent.test.ts) does not pretend otherwise —
**the mirror rule does not apply to it.**

What it does verify is every product capability behind the recipe, because
those are what make an agent's output better than a guess:

- `snapshot` returns role + accessible name per element — the block the shell
  recipe prints verbatim;
- `locators` returns candidates re-checked against the live page, ranked, never
  a ref;
- the console and network journal explain a failure the DOM does not;
- `a11y.audit()` reports violations with the elements they point at, and
  `a11y.check()` gates.

Prompt quality itself stays a manual review concern. Green CI here means the
tool does what the recipes say it does — not that the prompts are good.

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

## Exception: the BrowserStack recipe

[`docs/recipes/run-on-browserstack.md`](../../docs/recipes/run-on-browserstack.md)
also has no counterpart here. Its flows need a real BrowserStack account, so
they're verified by
[`tests/recipes/browserstack-remote.test.ts`](./browserstack-remote.test.ts)
instead, under its own dedicated command:

```bash
BROWSERSTACK_USERNAME=... BROWSERSTACK_ACCESS_KEY=... npm run test:browserstack
```

That command **fails fast with a clear message if the credentials are
missing** — it never silently skips and reports green — and it is never part
of `npm test` or `npm run test:recipes`. The `browserstack-smoke` CI job runs
only the **desktop** flows (Chrome + Safari smoke, `se/file` upload) on every
push, every same-repository pull request, and manual dispatch. Fork pull
requests are skipped because GitHub does not expose repository secrets to them.
The real-device gesture group (`BROWSERSTACK_TEST_MOBILE=1`) and the
BrowserStack Local group (`BROWSERSTACK_TEST_LOCAL=1` + `BROWSERSTACK_LOCAL_BINARY`)
stay **opt-in and out of CI** — both need live iteration a push cannot give
them — and are run manually via the environment variables documented in the
test file's validation errors.

## Exception: the self-hosted Selenium Grid smoke

[`tests/recipes/selenium-grid-remote.test.ts`](./selenium-grid-remote.test.ts)
is the executable counterpart to the **generic** remote path in
[`docs/remote-webdriver.md`](../../docs/remote-webdriver.md), verified against a
real Selenium Grid instead of the in-process fake grid. Same discipline as the
BrowserStack smoke — its own command, never in `npm test` / `npm run
test:recipes`, fails fast without an endpoint, zero retries:

```bash
SELENIUM_GRID_URL=http://<host>:4444 npm run test:grid
```

`SELENIUM_GRID_URL` is the Grid's **WebDriver endpoint** (its root, or
`/wd/hub`), NOT the `/ui/` console. `SELENIUM_GRID_BROWSER` (default `chrome`)
picks the node. `HEADLESS=true` (or `1`) asks the node to launch the browser
headless via its vendor options — no display / Xvfb needed on a CI runner
(craftdriver's remote path never injects `--headless` itself, so the smoke
supplies it through `remote.capabilities`). Set
`SELENIUM_GRID_EXAMPLES_URL` when the node cannot reach the hosted examples.
The suite covers the full flow, connection-pool isolation, `se/file` upload,
and BiDi relay behavior.

The `selenium-grid-smoke` CI job runs on every configured event. It verifies
the pinned Selenium Server 4.46.0 jar, serves the repository examples locally,
starts a standalone Chrome node, and runs all four smokes including the BiDi
relay check.
