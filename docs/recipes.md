# Recipes

Recipes are short, real-world patterns that combine CraftDriver features into
common testing workflows. Use this page as the index; each recipe has its own
page so the list can grow without turning into a wall of code.

For exact signatures, use the linked feature docs and the
[API reference](./api-reference.md).

## Test Structure

| Scenario                  | Use when                                                                   | Recipe                                                                     |
| ------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Vitest browser lifecycle  | You want one browser per test file and a fresh page per test.              | [Use CraftDriver With Vitest Hooks](./recipes/vitest-browser-lifecycle.md) |
| Login once, reuse session | Login UI is slow or noisy and most tests start signed in.                  | [Log In Once And Reuse The Session](./recipes/login-once-reuse-session.md) |
| Multi-user flows          | You need Alice and Bob signed in at the same time without leaking cookies. | [Test Multi-User Workflows](./recipes/multi-user-contexts.md)              |

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
| Evidence on failure           | You want a replayable trail of actions, network, logs, errors, and screenshots. | [Capture Failure Evidence With Tracing](./recipes/trace-failing-test.md) |
