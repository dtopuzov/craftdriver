# Selectors & Locators

CraftDriver provides multiple ways to locate elements on the page.

## CSS Selectors

The most common way to find elements is using CSS selectors as strings:

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

Locate by the `name` attribute.

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

### By.text(text, options?)

Locate by visible text content.

```typescript
// Exact match
browser.find(By.text('Submit Order'));

// Partial match
browser.find(By.text('Submit', { exact: false }));
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

### getByText(text, options?)

Locate by visible text.

```typescript
// Exact match (default)
browser.getByText('Welcome to our site');

// Partial match
browser.getByText('Welcome', { exact: false });
```

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
await browser.find('button:contains("Save")').click();
```
