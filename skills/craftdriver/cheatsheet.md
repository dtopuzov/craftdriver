# craftdriver — cheatsheet

Compact reference for writing tests. The full installed API reference is
`node_modules/craftdriver/docs/api-reference.md`.

## Launch & teardown

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch({
  browserName: 'chrome',   // 'chrome' | 'chromium' | 'firefox' | 'safari'
  headless: true,
  // enableBiDi defaults to true — network / logs / tracing / init scripts
  // all need it, so only set enableBiDi: false if you must disable it.
});
// 'safari' is macOS-only, headed only (no `headless`),
// one session at a time, WebDriver Classic only (enableBiDi is rejected).
// See docs/safari.md.
try {
  await browser.navigateTo('https://example.com');
  // ...
} finally {
  await browser.quit();    // never wrap in try/catch in tests
}
```

## Navigation

```ts
await browser.navigateTo(url, { waitUntil: 'load' | 'domcontentloaded' | 'networkidle' });
await browser.goBack();
await browser.goForward();
await browser.reload();
await browser.waitForLoadState('load');
```

## Selectors

```ts
import { By } from 'craftdriver';

By.testId('submit')                  // [data-testid="submit"]  ← preferred
By.role('button', { name: /save/i }) // ARIA role + accessible name
By.labelText('Email')                // form label
By.text('Sign in', { exact: true })  // visible text
By.css('button.primary')             // last resort
By.xpath('//button')                 // never if anything else works
```

## Locators (Playwright-style)

```ts
const submit = browser.locator(By.role('button', { name: 'Submit' }));

await submit.click();                     // auto-waits visible
await submit.fill('hello');               // click + clear + type
await submit.hover();
await submit.expect().toBeVisible();
await submit.expect().toHaveText('Submit');
await submit.expect().toBeEnabled();

// composition
const row = browser.locator('.row').filter({ hasText: 'Acme' }).first();
const cells = await row.locator('td').all();
const count = await row.locator('td').count();   // 0-wait probe
```

## Element handles

```ts
const el = await browser.find(By.css('#submit'));
await el.click();
await el.sendKeys('hello');
await el.clear();
const text = await el.getText();
const value = await el.getValue();
const tag = await el.tagName();
const isVisible = await el.isDisplayed();
```

## Assertions (`expect`)

```ts
await browser.locator('h1').expect().toHaveText(/welcome/i);
await browser.locator('input').expect().toHaveValue('jane@example.com');
await browser.locator('button').expect().toBeEnabled();
await browser.locator('.spinner').expect().not.toBeVisible();
```

Every `expect(...).to…()` auto-waits up to the default timeout. Bump
per-call with `{ timeout: 10_000 }`.

## Errors

```ts
import { CraftdriverError, ErrorCode } from 'craftdriver';

try {
  await browser.locator('#missing').click();
} catch (err) {
  if (CraftdriverError.is(err, ErrorCode.NO_MATCH)) {
    // selector is wrong — see err.detail.selector / err.hint
  }
}
```

Codes: `NO_MATCH`, `TIMEOUT_WAITING_VISIBLE`, `TIMEOUT_WAITING_STATE`,
`TIMEOUT_WAITING_LOAD`, `TIMEOUT_WAITING_NETWORK`,
`TIMEOUT_WAITING_DIALOG`, `TIMEOUT`, `EXPECT_MISMATCH`,
`A11Y_VIOLATIONS`, `EVAL_THREW`, `EVAL_BAD_ARG`, `INVALID_ARGUMENT`,
`UNSUPPORTED`, `STATE_INVALID`, `DRIVER_ERROR`. Full table:
`node_modules/craftdriver/docs/error-codes.md`.

## Pages and contexts

```ts
const ctx = await browser.newContext();    // isolated profile (BiDi)
const page = await ctx.newPage();
await page.navigateTo(url);

const pages = browser.pages();
const fresh = await browser.waitForPage(() => browser.click('a[target=_blank]'));
```

## Reusable login state

```ts
// Save after login (atomic file, mode 0600 where supported).
await browser.saveState('.auth/alice.json');

// BiDi: cookies + multi-origin localStorage are ready before navigation.
const reused = await Browser.launch({ storageState: '.auth/alice.json' });
await reused.navigateTo('https://app.example.com/dashboard');
```

Classic launch rejects non-empty state. Use `Browser.launch()`, navigate to the
sole captured HTTP(S) origin, then `browser.loadState(...)`. State containing
sessionStorage always uses that active-origin flow.

## Network (BiDi)

```ts
await browser.network.intercept({ url: '**/api/users', response: { status: 200, body: '[]' } });
const req = await browser.waitForRequest((r) => r.url.includes('/api/login'));
const res = await browser.waitForResponse((r) => r.url.includes('/api/me'));
await browser.network.waitForNetworkIdle();
```

## Logs (BiDi)

```ts
const logs = browser.logs.consoleMessages();
const errors = browser.logs.javaScriptErrors();
```

## Input

```ts
await browser.keyboard.press('Enter');
await browser.keyboard.type('hello');
await browser.mouse.move({ x: 100, y: 100 });
await browser.mouse.click({ x: 100, y: 100 });
await browser.actions().keyDown('Shift').click(el).keyUp('Shift').perform();
```

## Files

```ts
await element.setInputFiles('./fixtures/sample.txt');
const download = await browser.waitForDownload(() => browser.click('#download'));
```

## Screenshots & tracing

```ts
await browser.screenshot({ path: 'out.png', fullPage: true });

await browser.startTrace({ outDir: './artefacts/run', title: 'Smoke flow' });
try { /* ... */ } finally {
  await browser.stopTrace({ path: './artefacts/run.zip' }); // player.vibium.dev
}
```

## Accessibility

```ts
const result = await browser.a11y.audit();       // returns violations
await browser.a11y.check();                       // throws A11yError if any
```

## Virtual clock

```ts
await browser.clock.install({ time: '2026-01-01T00:00:00Z' });
await browser.clock.tick(1000);
await browser.clock.fastForward('05:00');         // 5 minutes
await browser.clock.uninstall();
```

## Emulation

```ts
await browser.emulate({
  colorScheme: 'dark',
  reducedMotion: 'reduce',
  locale: 'fr-FR',
  timezoneId: 'Europe/Paris',
  offline: true,
});
await browser.setViewportSize({ width: 1280, height: 720 });
await browser.setGeolocation({ latitude: 48.85, longitude: 2.35 });
await browser.grantPermissions(['geolocation']);
```
