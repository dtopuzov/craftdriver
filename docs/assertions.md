# Assertions

CraftDriver provides a fluent assertion API via `browser.expect()` for testing element states.

> For accessibility assertions, see [docs/accessibility.md](./accessibility.md) — `browser.a11y.check()` is the assertion form of the axe-core wrapper.

## Basic Usage

```typescript
// Assert on element state
await browser.expect('#message').toHaveText('Success!');
await browser.expect('#email').toHaveValue('test@example.com');
await browser.expect('#modal').toBeVisible();
```

## Assertion Methods

### toHaveText(expected)

Assert that the element's text content matches exactly.

```typescript
await browser.expect('#heading').toHaveText('Welcome');
await browser.expect('.alert').toHaveText('Form submitted successfully');
```

### toContainText(expected)

Assert that the element's text content contains the expected substring.

```typescript
await browser.expect('#paragraph').toContainText('important');
await browser.expect('.notification').toContainText('saved');
```

### toHaveValue(expected)

Assert that an input element has the expected value.

```typescript
await browser.expect('#username').toHaveValue('testuser');
await browser.expect('#quantity').toHaveValue('5');
```

### toBeVisible()

Assert that the element is visible on the page.

```typescript
await browser.expect('#success-modal').toBeVisible();
await browser.expect('.tooltip').toBeVisible();
```

### toHaveAttribute(name, value)

Assert that the element has an attribute with the expected value.

```typescript
await browser.expect('#link').toHaveAttribute('href', '/dashboard');
await browser.expect('#input').toHaveAttribute('disabled', 'true');
await browser.expect('#image').toHaveAttribute('alt', 'Product photo');
```

## Negation

Use `.not` to negate any assertion:

```typescript
await browser.expect('#error').not.toBeVisible();
await browser.expect('#input').not.toHaveValue('');
await browser.expect('#button').not.toHaveAttribute('disabled', 'true');
```

## Element-Scoped Assertions

You can also get an assertion API scoped to an ElementHandle:

```typescript
const message = browser.find('#message');
await message.expect().toHaveText('Success');
await message.expect().toBeVisible();
```

This is useful when you're already working with an element reference:

```typescript
const form = browser.find('#login-form');

// Fill the form
await browser.find('#username').fill('testuser');
await browser.find('#password').fill('secret');
await browser.find('#submit').click();

// Assert on result
await browser.find('#result').expect().toHaveText('Login successful');
```

## Waiting Behavior

All assertions automatically wait for the condition to be true, up to a configurable timeout.

```typescript
// Uses the browser-level default (5000 ms unless changed)
await browser.expect('#loading').not.toBeVisible();

// Per-call timeout override
await browser.expect('#data').toHaveText('Loaded', { timeout: 10000 });
await browser.expect('#modal').toBeVisible({ timeout: 2000 });
await browser.expect('#result').toContainText('success', { timeout: 8000 });
```

### Changing the default timeout

Use `browser.setDefaultTimeout()` to raise or lower the default for **all**
subsequent assertions (and actions) on that browser instance:

```typescript
browser.setDefaultTimeout(10000); // all assertions now wait up to 10 s by default

await browser.expect('#slow-widget').toBeVisible(); // uses 10 s
await browser.expect('#fast-check').toHaveText('ok', { timeout: 500 }); // per-call wins
```

See [Browser API — Configuring timeouts](./browser-api.md#configuring-timeouts) for full details.

## Examples

### Form Validation

```typescript
await browser.find('#email').fill('invalid-email');
await browser.find('#submit').click();

await browser.expect('#email-error').toBeVisible();
await browser.expect('#email-error').toHaveText('Please enter a valid email');
```

### Navigation Confirmation

```typescript
await browser.find('#logout').click();

await browser.expect('#login-form').toBeVisible();
await browser.expect('.welcome-message').not.toBeVisible();
```

### Successful Form Submission

```typescript
await browser.find('#name').fill('John Doe');
await browser.find('#email').fill('john@example.com');
await browser.find('#submit').click();

await browser.expect('#success-message').toBeVisible();
await browser.expect('#success-message').toContainText('Thank you');
await browser.expect('#form').not.toBeVisible();
```

### Attribute Verification

```typescript
// Check link destination
await browser.expect('#dashboard-link').toHaveAttribute('href', '/dashboard');

// Check disabled state
await browser.expect('#submit').not.toHaveAttribute('disabled', 'true');

// After disabling
await browser.find('#submit').click();
await browser.expect('#submit').toHaveAttribute('disabled', 'true');
```

### Page Title and URL

```typescript
// Use browser methods directly for page-level checks
const title = await browser.title();
expect(title).toBe('Dashboard'); // Using Vitest/Jest expect

const url = await browser.url();
expect(url).toContain('/dashboard');
```
