# Selectors & Locators

CraftDriver provides multiple ways to locate elements on the page.

## CSS Selectors

The most common way to find elements is using CSS selectors as strings:

> String selectors are always parsed as CSS selectors. Craftdriver does not
> support Playwright-style selector strings such as `text=Save` or `role=button`.
> For semantic queries, use `By.*` or `browser.getBy*()`.

```typescript
// By ID
await browser.click('#submit-button');

// By class
await browser.click('.btn-primary');

// By tag and attribute
await browser.click('input[type="email"]');

// Complex selectors
await browser.click('form.login #username');
await browser.click('ul.nav > li:first-child a');
```

## By Locators

The `By` helper provides semantic locator strategies:

```typescript
import { By } from 'craftdriver';
```

### By.css(selector)

Locate by CSS selector (equivalent to passing a string).

```typescript
browser.find(By.css('#my-button'));
```

### By.id(id)

Locate by element ID.

```typescript
browser.find(By.id('username'));
// Equivalent to: browser.find('#username')
```

### By.className(name)

Locate by CSS class name.

```typescript
browser.find(By.className('btn-primary'));
// Equivalent to: browser.find('.btn-primary')
```

### By.name(name)

Locate by the `name` attribute (matches the canonical Selenium
`By.name` locator).

```typescript
browser.find(By.name('email'));
// Finds: <input name="email">
```

### By.tagName(tag)

Locate by HTML tag name.

```typescript
browser.find(By.tagName('h1'));
// Finds the first <h1> element
```

### By.attr(name, value)

Locate by an arbitrary attribute and value.

```typescript
browser.find(By.attr('role', 'dialog'));
// Equivalent to: browser.find('[role="dialog"]')
```

### By.dataAttr(name, value)

Locate by a `data-*` attribute. Pass the suffix only — `data-` is added
for you.

```typescript
browser.find(By.dataAttr('state', 'open'));
// Equivalent to: browser.find('[data-state="open"]')
```

### By.aria(name, value)

Locate by an `aria-*` attribute. Pass the suffix only — `aria-` is added
for you. Use `By.role()` / `getByRole()` for role + accessible-name
matching; use this helper when you need a specific ARIA state or
property.

```typescript
browser.find(By.aria('expanded', 'true'));
// Equivalent to: browser.find('[aria-expanded="true"]')
```

### By.testId(value)

Locate by `data-testid` attribute.

```typescript
browser.find(By.testId('submit-button'));
// Equivalent to: browser.find('[data-testid="submit-button"]')
```

### By.text(text, options?)

Locate by visible text content. Defaults: `exact: true`,
`caseSensitive: true`, `trim: true`.

```typescript
// Exact match (whitespace-normalised)
browser.find(By.text('Submit Order'));

// Substring match — equivalent to By.partialText('Submit')
browser.find(By.text('Submit', { exact: false }));

// Case-insensitive
browser.find(By.text('submit order', { caseSensitive: false }));
```

> **`By.text` and `getByText` are the same vocabulary.**
> `getByText(text, opts)` is just `By.text(text, opts)`. Pass
> `{ exact: false }` on either to get substring matching;
> `By.partialText` remains as the lower-level entry point if you prefer
> to be explicit.

### By.partialText(substring, options?)

Locate the innermost element whose visible text contains `substring`.
Equivalent to `By.text(substring, { exact: false })`. Defaults:
`caseSensitive: true`, `trim: true`.

```typescript
browser.find(By.partialText('Submit'));
browser.find(By.partialText('error', { caseSensitive: false }));
```

### By.altText(text, options?)

Locate `<img>`, `<area>`, or `<input type="image">` by `alt` text.
Defaults: `exact: true`.

```typescript
browser.find(By.altText('Company logo'));
browser.find(By.altText('logo', { exact: false }));
```

### By.title(text, options?)

Locate by the `title` attribute (browser tooltip text). Defaults:
`exact: true`.

```typescript
browser.find(By.title('Open in new tab'));
browser.find(By.title('Open', { exact: false }));
```

### By.xpath(expression)

Locate using XPath expression.

```typescript
browser.find(By.xpath('//button[@data-testid="submit"]'));
browser.find(By.xpath('//div[contains(@class, "error")]'));
```

## Playwright-Style Locators

CraftDriver also supports Playwright-style semantic locators directly on the browser:

### getByRole(role, options?)

Locate by ARIA role.

```typescript
browser.getByRole('button', { name: 'Submit' });
browser.getByRole('textbox', { name: 'Email' });
browser.getByRole('checkbox', { name: 'Remember me' });
browser.getByRole('link', { name: 'Learn more' });
```

Options:

| Option          | Type      | Default | Description                                           |
| --------------- | --------- | ------- | ----------------------------------------------------- |
| `name`          | `string`  | —       | Accessible name (`aria-label` or visible text).       |
| `exact`         | `boolean` | `true`  | If `false`, substring-match the accessible name.      |
| `includeHidden` | `boolean` | `false` | Match elements with `hidden` or `aria-hidden="true"`. |

```typescript
// Default: skip elements marked hidden / aria-hidden
browser.getByRole('button', { name: 'Close' });

// Include hidden elements (e.g., off-canvas menus, collapsed sections)
browser.getByRole('button', { name: 'Close', includeHidden: true });
```

### getByText(text, options?)

Locate by visible text.

```typescript
// Exact match (default)
browser.getByText('Welcome to our site');

// Partial match
browser.getByText('Welcome', { exact: false });
```

> **Heads-up for Playwright users.** Craftdriver's `getByText` defaults
> to **exact** matching, while Playwright's defaults to substring. Pass
> `{ exact: false }` for substring behaviour.

### getByLabel(text, options?)

Locate form controls by their associated label.

```typescript
browser.getByLabel('Email address');
browser.getByLabel('Password');
```

### getByPlaceholder(text, options?)

Locate inputs by placeholder text.

```typescript
browser.getByPlaceholder('Enter your email');
browser.getByPlaceholder('Search...');
```

### getByTestId(testId)

Locate by `data-testid` attribute.

```typescript
browser.getByTestId('submit-button');
browser.getByTestId('user-profile');
```

## Selector Best Practices

### Prefer Stable Selectors

```typescript
// ✅ Good - specific and stable
browser.find('#login-button');
browser.find('[data-testid="submit"]');
browser.getByRole('button', { name: 'Login' });

// ❌ Avoid - fragile, depends on structure
browser.find('div > div > button:nth-child(3)');
browser.find('.btn.mt-4.px-6'); // CSS utility classes change
```

### Use Test IDs for Complex UIs

Add `data-testid` attributes to elements that are hard to select:

```html
<button class="btn btn-primary mx-2" data-testid="checkout-button">Proceed to Checkout</button>
```

```typescript
await browser.find('[data-testid="checkout-button"]').click();
// or
await browser.getByTestId('checkout-button').click();
```

### Semantic Locators for Accessibility

Using role-based locators ensures your UI is accessible:

```typescript
// This only works if the button is properly labeled
browser.getByRole('button', { name: 'Add to cart' });
```

## Examples

### Finding Multiple Elements

```typescript
// Click the first matching element
await browser.find('.product-card .add-to-cart').click();

// For multiple elements, use specific selectors
await browser.find('.product-card:nth-child(1) .add-to-cart').click();
await browser.find('.product-card:nth-child(2) .add-to-cart').click();
```

## Locators (lazy & chainable)

`browser.locator(selector)` returns a `Locator` — a lazy, re-resolving handle that
supports composition, filtering, and indexed access.

Use `find()` for a single one-shot element, `findAll()` for the simple array case,
and `locator()` when you need composition or want to pick from a list.

```typescript
import { Browser } from 'craftdriver';

// Count matching elements
const n = await browser.locator('.product').count();

// Pick by index (0-based)
await browser.locator('.buy-btn').first().click();
await browser.locator('.buy-btn').last().click();
await browser.locator('.buy-btn').nth(2).click();

// Filter by text content
await browser.locator('.product').filter({ hasText: 'Pro' }).locator('.buy-btn').click();

// Filter by presence of a child locator
const hasPromo = browser.locator('.badge');
const promoCards = browser.locator('.card').filter({ has: hasPromo });
await promoCards.first().click();

// Chain into a child element
await browser.locator('.card').nth(0).locator('button').click();

// Get all matching elements as snapshot handles
const handles = await browser.locator('.product').all();
const texts = await Promise.all(handles.map(h => h.text()));

// Simple array shortcut (no filtering)
const allButtons = await browser.findAll('.buy-btn');
```

### Locator actions and state

| Method | Description |
| ------ | ----------- |
| `click(options?)` | Click the first matching visible element |
| `fill(text, options?)` | Fill the first matching visible element |
| `text(options?)` | Get visible text |
| `textContent(options?)` | Alias for `text()` |
| `isVisible(options?)` | Return `true` if a matching element is visible |
| `count()` | Count current matches without auto-wait |
| `all()` | Return snapshot `ElementHandle`s for current matches |
| `waitFor({ state, timeout? })` | Wait for `attached`, `detached`, `visible`, or `hidden` |
| `expect()` | Element assertions scoped to this locator |
| `a11y` | Accessibility audit scoped to this locator |

```typescript
await browser.locator('.toast').waitFor({ state: 'visible' });
const shown = await browser.locator('.toast').isVisible();
const text = await browser.locator('.toast').textContent();
const audit = await browser.locator('#checkout').a11y.audit();
```

### Assertions on locators

```typescript
await browser.locator('#result').expect().toHaveText('Done');
await browser.locator('.error').expect().not.toBeVisible();
```


### Form Controls

```typescript
// By label
await browser.getByLabel('Email').fill('test@example.com');
await browser.getByLabel('Password').fill('secret');

// By placeholder
await browser.getByPlaceholder('Search products...').fill('laptop');

// By role
await browser.getByRole('button', { name: 'Search' }).click();
```

### Navigation Links

```typescript
await browser.getByRole('link', { name: 'Products' }).click();
await browser.getByText('Contact Us').click();
await browser.find('nav a[href="/about"]').click();
```

### Buttons by Text

```typescript
await browser.getByRole('button', { name: 'Submit' }).click();
await browser.getByText('Cancel').click();
```
