# craftdriver — patterns

Worked recipes. Each is ≤ ~200 tokens; load on demand from
[SKILL.md](SKILL.md).

## 1. Login, save storage state for reuse

```ts
const browser = await Browser.launch();
await browser.navigateTo('https://app.example.com/login');
await browser.locator(By.labelText('Email')).fill('jane@example.com');
await browser.locator(By.labelText('Password')).fill(process.env.PW!);
await browser.locator(By.role('button', { name: 'Sign in' })).click();
await browser.locator(By.testId('dashboard')).expect().toBeVisible();

// Persist for fast subsequent runs.
const state = await browser.defaultContext.storageState();
await fs.writeFile('.auth/state.json', JSON.stringify(state));
await browser.quit();
```

## 2. Re-use saved login

```ts
const state = JSON.parse(await fs.readFile('.auth/state.json', 'utf8'));
const browser = await Browser.launch({ storageState: state });
await browser.navigateTo('https://app.example.com/dashboard');
await browser.locator(By.testId('dashboard')).expect().toBeVisible();
```

## 3. Wait for a network response after a click

```ts
const [response] = await Promise.all([
  browser.waitForResponse((r) => r.url.includes('/api/checkout') && r.status === 200),
  browser.locator(By.role('button', { name: 'Pay' })).click(),
]);
const body = await response.text();
```

## 4. Upload a file

```ts
const input = await browser.find(By.css('input[type=file]'));
await input.setInputFiles('./fixtures/contract.pdf');
await browser.locator(By.role('button', { name: 'Upload' })).click();
await browser.locator(By.text('Upload complete')).expect().toBeVisible();
```

## 5. Scoped text reads (one row of a table)

```ts
const row = browser.locator('tr').filter({ hasText: 'Acme Inc.' }).first();
const status = await row.locator('[data-col=status]').text();
const due = await row.locator('[data-col=due]').text();
```

## 6. Capture a failure trace for an agent or bug report

```ts
await browser.startTrace({
  outDir: './artefacts/checkout-fail',
  title: 'Checkout failure',
  screenshots: 'auto',
  network: true,
  console: true,
});
try {
  await runFlow(browser);
} catch (e) {
  // Trace lands on disk regardless — thrown expects never lose data.
  throw e;
} finally {
  await browser.stopTrace({ path: './artefacts/checkout-fail.zip' });
}
```

## 7. Mock an API for deterministic tests

```ts
await browser.network.intercept({
  url: '**/api/users',
  response: { status: 200, body: JSON.stringify([{ id: 1, name: 'Jane' }]) },
});
await browser.navigateTo('/users');
await browser.locator(By.text('Jane')).expect().toBeVisible();
```

## 8. Recovery loop on a flaky element

Don't write retry loops by hand — `expect()` already retries. Only
catch a `CraftdriverError` when you have a meaningful fallback:

```ts
import { CraftdriverError, ErrorCode } from 'craftdriver';

try {
  await browser.locator(By.testId('cookie-banner-accept')).click({ timeout: 2000 });
} catch (e) {
  if (!CraftdriverError.is(e, ErrorCode.NO_MATCH)) throw e;
  // Banner not shown this session — proceed.
}
```

## 9. Multi-page (popup or new tab)

```ts
const popup = await browser.waitForPage(() =>
  browser.locator(By.text('Open in new tab')).click()
);
await popup.locator(By.role('heading', { name: 'Details' })).expect().toBeVisible();
```

## 10. iframe scoping

```ts
const frame = await browser.frame('iframe#checkout');
await frame.locator(By.labelText('Card number')).fill('4242 4242 4242 4242');
```

## 11. Accessibility gate in CI

```ts
await browser.navigateTo('/checkout');
const result = await browser.a11y.audit({ minImpact: 'serious' });
expect(result.violations).toEqual([]);
```

## 12. Virtual clock — exercise a debounce

```ts
await browser.clock.install({ time: '2026-01-01T00:00:00Z' });
await browser.locator(By.css('#search')).fill('jane');
await browser.clock.tick(300);  // skip the 300 ms debounce
await browser.locator(By.testId('results')).expect().toBeVisible();
await browser.clock.uninstall();
```
