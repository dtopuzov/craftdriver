# Copilot usage guidelines for this repo

These conventions help keep tests and API consistent. Please follow them when generating code in this repository.

- Vitest timeouts: do not set per-test timeouts in `it()` or hooks. The global defaults are configured in `vitest.config.ts` (testTimeout, hookTimeout, teardownTimeout).
- Test names: do not prefix test names with numbers. Use descriptive, human-readable names.
- Cleanup: do not wrap `await browser.quit()` in try/catch in tests. Let failures surface.
- Base URL constant: use `EXAMPLES_BASE_URL` from `tests/helpers.ts` instead of reading `process.env` in each test file.
- Public API: prefer the simplified `Browser` API.
  - Example: `await browser.navigateTo(url)`, `await browser.click('#selector')`, `await browser.type('#username', 'admin')`.
  - Assertions: use `await browser.expect('#selector').toHaveText('...')` and `await browser.expect('#selector').toBeVisible()` or `.not.toBeVisible()`.
  - Element chains: prefer `browser.find('#selector').type('...').press('Enter')` when interacting with a specific element, and `browser.find('#selector').expect().toHaveText('...')` for element-scoped assertions.
- No legacy Selenium-style APIs in new code; keep the surface minimal and focused on the patterns above.
