# Recipes

_Recipes for brewing great tests._ 🍺

Recipes are short, real-world patterns that combine CraftDriver features into
common testing workflows. Use this page as the index; each recipe has its own
page so the list can grow without turning into a wall of code. New here? Start
with [Find Elements On The Page](./recipes/find-elements.md) — every other recipe
builds on knowing how to point at the thing you want.

Every snippet is verified in CI against a live example page you can open
yourself, under
[dtopuzov.github.io/craftdriver/examples](https://dtopuzov.github.io/craftdriver/examples/login.html).
To stay readable, a snippet shows only the code it is teaching and assumes a
launched `browser` — unless it shows a `Browser.launch(...)` call itself. See the
[Vitest Hooks recipe](./recipes/vitest-browser-lifecycle.md) for the surrounding
setup.

The [Electron recipes](#electron) are different: they show the project shape for
driving a packaged desktop app, so they use paths you adapt to your app repo
rather than the hosted browser examples.

For exact signatures, use the linked feature docs and the
[API reference](./api-reference.md).

## Start Here

| Scenario      | Use when                                                          | Recipe                                                  |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| Find elements | You're new and need to point CraftDriver at the element you want. | [Find Elements On The Page](./recipes/find-elements.md) |

## Test Structure

| Scenario                       | Use when                                                                   | Recipe                                                                                |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Vitest browser lifecycle       | You want one browser per test file and a fresh page per test.              | [Use CraftDriver With Vitest Hooks](./recipes/vitest-browser-lifecycle.md)            |
| Login once, reuse session      | Login UI is slow or noisy and most tests start signed in.                  | [Log In Once And Reuse The Session](./recipes/login-once-reuse-session.md)            |
| Multi-user flows               | You need Alice and Bob signed in at the same time without leaking cookies. | [Test Multi-User Workflows](./recipes/multi-user-contexts.md)                         |
| Page objects                   | Selectors and steps are copy-pasted across tests and break together.       | [Organize Flows With Page Objects](./recipes/page-objects.md)                         |

## App Behavior

| Scenario                     | Use when                                                                  | Recipe                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Mock APIs and assert traffic | A UI flow depends on backend responses or request payloads.               | [Mock APIs And Assert Network Traffic](./recipes/mock-api-and-assert-network.md)              |
| Time-sensitive UI            | Debounces, trial banners, idle logout, or scheduled jobs make tests slow. | [Test Time-Sensitive UI With The Virtual Clock](./recipes/virtual-clock-time-sensitive-ui.md) |
| Mobile-specific behavior     | Mobile layout depends on viewport, device headers, API config, or logs.   | [Test A Mobile Flow With API Mocks And Logs](./recipes/mobile-flow-with-network-and-logs.md)  |
| File upload and download     | A flow uploads a file, exports a report, or verifies downloaded content.  | [Test File Uploads And Downloads](./recipes/file-upload-download.md)                          |

## Quality Gates And Debugging

| Scenario                      | Use when                                                                        | Recipe                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Accessibility regression gate | CI should fail on serious page or component accessibility issues.               | [Run Accessibility Gates](./recipes/accessibility-gate.md)               |
| Console and JavaScript errors | Tests should fail if the browser reports unexpected client-side errors.         | [Fail On Console And JavaScript Errors](./recipes/console-error-gate.md) |
| Debug failing tests           | You need the actions, screenshots, logs, and network activity behind a failure. | [Use Traces To Debug Failing Tests](./recipes/debug-failing-tests-with-traces.md) |

## Electron

Driving a packaged Electron desktop app. These use paths you adapt to your app
repo rather than the hosted browser examples, and the mocking/deep-link recipes
need main-process access (`electron: { mainProcess: true }`). See
[Testing Electron Apps](./electron.md) for setup, drivers, and the security
boundary.

| Scenario                       | Use when                                                                   | Recipe                                                                                |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Electron app from another repo | Your packaged Electron app is built in one repo and tested from another.   | [Test An Electron App From Another Repo](./recipes/electron-app-from-another-repo.md) |
| Electron native dialog         | A renderer flow opens an operating-system file, save, or message dialog.   | [Mock A Native Electron File Dialog](./recipes/electron-native-dialog.md)             |
| Electron API mocking           | A flow calls `shell.openExternal`, `clipboard.writeText`, or similar.      | [Mock Electron APIs](./recipes/electron-mock-apis.md)                                 |
| Electron deep link             | Your app registers a `myapp://` scheme and must handle links from the OS.  | [Test An Electron Deep Link](./recipes/electron-deep-link.md)                         |
