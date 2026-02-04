# Copilot usage guidelines for this repo

These conventions help keep tests and API consistent. Please follow them when generating code in this repository.

## Test Conventions

- Vitest timeouts: do not set per-test timeouts in `it()` or hooks. The global defaults are configured in `vitest.config.ts` (testTimeout, hookTimeout, teardownTimeout).
- Test names: do not prefix test names with numbers. Use descriptive, human-readable names.
- Cleanup: do not wrap `await browser.quit()` in try/catch in tests. Let failures surface.
- Base URL constant: use `EXAMPLES_BASE_URL` and `BROWSER_NAME` from `tests/utils.ts` instead of reading `process.env` in each test file.

## Browser API - Complete Reference

IMPORTANT: Only use the APIs listed below. Do NOT invent or assume APIs exist.

### Browser Launch and Lifecycle

```typescript
const browser = await Browser.launch({ browserName: BROWSER_NAME });
const browser = await Browser.launch({ browserName: BROWSER_NAME, enableBiDi: true });
const browser = await Browser.launch({ browserName: BROWSER_NAME, storageState: './auth.json' });
await browser.quit();
```

### Navigation

```typescript
await browser.navigateTo(url);
const currentUrl = await browser.url();
const pageTitle = await browser.title();
```

### Element Interaction (Direct Browser Methods)

```typescript
await browser.click('#selector');
await browser.fill('#selector', 'text');
await browser.clear('#selector');
const value = await browser.getValue('#selector');
const attr = await browser.getAttribute('#selector', 'attributeName');
```

### Element Handle (via browser.find())

```typescript
const element = browser.find('#selector');
await element.click();
await element.fill('text');
await element.clear();
await element.press('Enter'); // Key names: 'Enter', 'Tab', 'Escape', 'Backspace', etc.
await element.hover(); // Move mouse to element center
await element.select('value'); // Select option by value (only for <select> elements)
const text = await element.text();
const value = await element.value();
const attr = await element.getAttribute('name');
const visible = await element.isVisible();
const enabled = await element.isEnabled();
const checked = await element.isChecked();
const box = await element.boundingBox();
await element.screenshot('element.png');
element.expect().toHaveText('...'); // Element-scoped assertion
```

⚠️ ElementHandle methods:

- `hover()` - Moves mouse to element center (works on any element)
- `select(value)` - Only for `<select>` elements. Throws error if used on other elements.
- No `findParent()` or `findChild()` - use direct CSS selectors instead

### Playwright-style Locators

```typescript
browser.getByRole('button', { name: 'Submit' });
browser.getByText('Hello World');
browser.getByText('partial', { exact: false });
browser.getByLabel('Username');
browser.getByPlaceholder('Enter email');
browser.getByTestId('submit-btn');
```

### Assertions (via browser.expect())

```typescript
await browser.expect('#selector').toHaveText('exact text');
await browser.expect('#selector').toContainText('partial');
await browser.expect('#selector').toHaveValue('input value');
await browser.expect('#selector').toBeVisible();
await browser.expect('#selector').not.toBeVisible();
await browser.expect('#selector').toHaveAttribute('href', '/path');
```

### Waiting

```typescript
await browser.waitForVisible('#selector');
await browser.waitForHidden('#selector');
await browser.waitForAttached('#selector');
await browser.waitForDetached('#selector');
await browser.pause(1000); // pause for 1 second
await browser.waitFor(async () => someCondition);
```

### Keyboard

```typescript
await browser.keyboard.press('Enter');
await browser.keyboard.type('text to type');
await browser.keyboard.down('Shift');
await browser.keyboard.up('Shift');
```

### Mouse

```typescript
await browser.mouse.click(100, 200);
await browser.mouse.move(100, 200);
await browser.mouse.down();
await browser.mouse.up();
await browser.mouse.wheel(0, 100); // scroll
await browser.mouse.dragAndDrop({ x: 0, y: 0 }, { x: 100, y: 100 });
```

### Screenshots

```typescript
const buffer = await browser.screenshot();
const elementBuffer = await browser.screenshot('#selector');
await browser.saveScreenshot('page.png');
await browser.saveScreenshot('element.png', '#selector');
```

### Session State (Playwright-style)

```typescript
await browser.saveState('./session.json');
await browser.saveState('./session.json', { includeLocalStorage: false });
await browser.saveState('./session.json', { includeCookies: false });
await browser.loadState('./session.json');
```

### BiDi Features (when enableBiDi: true)

```typescript
// Network mocking
await browser.network.mock('**/api/users', { status: 200, body: { users: [] } });
await browser.network.intercept('**/api/**', async (request) => modifiedRequest);
browser.network.removeIntercept('**/api/users');

// Console/Error logs
const messages = browser.logs.getMessages(); // Returns: { level, text, timestamp }[]
const errors = browser.logs.getErrors(); // Returns: { message, type, stack, timestamp }[]
browser.logs.clearMessages();
browser.logs.clearErrors();
```

## Best Practices

1. **Prefer exact CSS selectors over chaining**: Use `browser.click('#specific-button-id')` instead of chaining methods.

2. **Add IDs to test HTML elements**: When creating example HTML pages, add unique IDs to buttons and interactive elements for easy test targeting.

3. **Use browser methods for simple interactions**: Prefer `browser.click()`, `browser.fill()` over `browser.find().click()` for single operations.

4. **Use ElementHandle for multi-step element operations**: When you need to perform multiple actions on the same element:

   ```typescript
   await browser.find('#input').fill('text').press('Enter');
   ```

5. **For native `<select>` dropdowns**: Use the `select()` method:

   ```typescript
   await browser.find('#language').select('es');
   ```

6. **For hover interactions**: Use the `hover()` method on elements:

   ```typescript
   await browser.find('#menu-item').hover();
   ```

7. **No legacy Selenium-style APIs**: Don't use `driver.findElement()`, `element.sendKeys()`, etc. Use the simplified Browser API.

## Common Mistakes to Avoid

❌ `browser.find('#el').findParent('.card')` - findParent doesn't exist
❌ `browser.find('#button').select('option')` - select only works on `<select>` elements
❌ `browser.wait(5000)` - use browser.pause(5000) instead
❌ Setting per-test timeouts in it() calls
❌ `await browser.click('#dropdown option[value="es"]')` when you have a native `<select>`

✅ Use direct CSS selectors: `browser.click('.card button.danger')`
✅ Use browser.pause() for delays
✅ Use `element.hover()` for hover interactions
✅ Use `element.select(value)` for `<select>` elements
