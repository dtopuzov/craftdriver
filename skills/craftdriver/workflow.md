# Explore an application and write a CraftDriver test

This workflow turns live browser evidence into an ordinary, reviewable test.

## 1. Learn the project

Before editing, inspect `package.json`, existing test files, fixtures, and the
commands the repository already uses. Reuse its test runner, naming, setup, URL,
and browser lifecycle. Do not create a second test framework or edit repository
assistant instructions.

## 2. Start the application and browser

Run the project's existing app command in its own process. Then:

```bash
npx craftdriver go http://127.0.0.1:3000 --browser chrome --headless
npx craftdriver snapshot --pretty
```

Use the actual project URL and wait for a clear page condition when necessary.
On Windows the daemon is unavailable; use the configured MCP server, or put
the complete exploration flow into one `--ephemeral` script.

## 3. Inspect before acting

Read role/name, labels, test IDs, visible text, and nearby DOM structure from the
snapshot. Prefer the selector that is at once the most **stable** and the most
**meaningful** — a semantic role/name/label locator while the name is a stable
label, a stable id/attribute the moment the name is dynamic or the app is
translated. Prove it:

```bash
npx craftdriver exists 'role=button[name=Sign in]'
npx craftdriver find 'label=Email' --all
```

Refs from the snapshot are safe to act on: a ref binds to one element, and if
that element is gone or the page navigated, the command fails with `STALE_REF`
instead of hitting something else. Use its bounded `recoverySnapshot` when
present; take a fresh snapshot only when recovery context is unavailable.

Never copy `ref=eN` into test code. When you have the right element, ask for a
durable selector and let CraftDriver validate it against the live page:

```bash
npx craftdriver locators ref=e7
```

Use the candidate it reports as `best`. When the accessible name looks dynamic
(a counter, a price, a date) the ranker demotes the role/name candidate below a
stable anchor and attaches a `note` — follow it, and if you saw the name change
during exploration, don't lock a test to it. If nothing resolves uniquely, add a
`data-testid` to the application rather than committing a positional selector.

## 4. Exercise the user flow

```bash
npx craftdriver fill 'label=Email' alice@example.test
npx craftdriver fill 'label=Password' secret
npx craftdriver click 'role=button[name=Sign in]' --observe=page
npx craftdriver text 'testid=welcome'
```

Use the snapshot refs while exploring. For a searchbox or single-field form,
prefer `fill TARGET VALUE --submit` over filling and then clicking a sibling
submit ref. A reactive fill can replace neighbouring controls; when a separate
sibling action is genuinely needed, use `fill TARGET VALUE --observe=delta`
and act on the fresh ref.

After a predictable navigation, use `--observe=page` plus targeted `text`,
`attr`, or `value` reads when the required evidence is already known. Use
`--observe=delta` when the next action depends on discovering what changed. If
a selector is ambiguous, refine it from observed structure and validate again.

**The DOM is not the whole story.** An application can fail while showing a
generic message, or succeed while logging an error you should not ship. Check
what the page actually did:

```bash
npx craftdriver logs --kind error                    # exceptions + console.error
npx craftdriver logs --kind request,response --contains /api/
```

Capture is already running before your first command, so this works after the
fact — you never re-run a flow to observe it. Assert on what you find, not on
what the page happens to render.

## 5. Write the smallest durable test

Follow the repository's style. A direct test may look like:

```ts
import { Browser, By } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });
try {
  await browser.navigateTo('http://127.0.0.1:3000');
  await browser.locator(By.labelText('Email')).fill('alice@example.test');
  await browser.locator(By.labelText('Password')).fill('secret');
  await browser.locator(By.role('button', { name: 'Sign in' })).click();
  await browser
    .locator(By.testId('welcome'))
    .expect()
    .toHaveText(/welcome/i);
} finally {
  await browser.quit();
}
```

Assertions hang off the locator — `locator.expect().to…()`, or
`browser.expect(selector).to…()`. There is no top-level `expect` export.

Use the exact public API patterns already present in the repository when they
differ from this standalone example.

## 6. Run and debug

Run the narrowest existing test command. On failure:

1. read the stable CraftDriver error code;
2. reproduce against the current app;
3. take a fresh snapshot and re-check the locator with `locators`;
4. inspect only the relevant page value/text/attribute;
5. **read the evidence before theorising** — see below;
6. change application or test source through an explicit diff;
7. rerun the focused test, then the repository's required checks.

### Read the evidence

Most failures that look mysterious in the DOM are explicit in the console or
the network journal:

```bash
npx craftdriver logs --kind error                 # exceptions and console.error
npx craftdriver logs --kind response --contains /api/   # status codes
```

A page that renders "Something went wrong" tells you nothing; a 4xx on
`/api/checkout` and a matching `console.error` tell you exactly where to look.
`--kind error` covers both uncaught exceptions and `console.error`, since a
caller asking for errors means both.
Quote that evidence when you explain the failure, rather than guessing from the
rendered text.

For a failure that a snapshot cannot explain — a race, or something that only
happens mid-flow — record the whole run and inspect it afterwards:

```bash
npx craftdriver trace start bug
# …reproduce…
npx craftdriver trace stop --zip
```

To confirm a diagnosis, drive the branch directly instead of waiting for the
real backend to misbehave:

```bash
npx craftdriver mock add '**/api/checkout*' --status 500
npx craftdriver mock clear     # always clean up; mocks outlive the command
```

### Never heal a test at runtime

Do not make a failing test green through sleeps, broad catch blocks, weaker
assertions, or silent runtime selector substitution. If the application
changed, change the test in an explicit source diff and say what changed and
why. A test that hides a real application change is worse than a failing one,
because it removes the signal without fixing the cause.

## On-demand references

Only when the workflow above and the consuming repository do not cover a
needed API, read the [CLI reference](cli.md), [TypeScript API
cheatsheet](cheatsheet.md), or [worked patterns](patterns.md). Do not load them
speculatively.
