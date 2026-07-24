# Assertions

CraftDriver provides auto-waiting assertions for the current page and for elements.

> For accessibility assertions, see [docs/accessibility.md](./accessibility.md) — `browser.a11y.check()` is the assertion form of the axe-core wrapper.

## Basic Usage

```typescript
// Assert on element state
await browser.expect('#message').toHaveText('Success!');
await browser.expect('#email').toHaveValue('test@example.com');
await browser.expect('#modal').toBeVisible();

// Assert on the active page (no selector argument)
await browser.expect().toHaveURL('https://example.test/dashboard');
await browser.expect().toHaveTitle('Dashboard');
```

Except for collection matchers such as `toHaveCount()`, locator assertions
inspect the first matching element. Select a particular element explicitly when
more than one match is possible:

```typescript
await browser.locator('.result').first().expect().toHaveText('First result');
await browser.locator('.result').nth(2).expect().toHaveText('Third result');
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

### toHaveCount(expected)

Assert the exact number of elements currently matched by a locator. The expected
count must be a non-negative integer. Unlike element-state assertions, a count of
zero is valid and means that no elements match.

```typescript
await browser.expect('.cart-item').toHaveCount(3);
await browser.locator('.cart-item').expect().toHaveCount(3);
await browser.expect('.validation-error').toHaveCount(0);
```

### toBeFocused()

Assert that the element is the focused element in its document or shadow root.
This is useful for keyboard navigation, autofocus, and focus-management tests.

```typescript
await browser.find('#search').click();
await browser.locator('#search').expect().toBeFocused();
await browser.locator('#submit').expect().not.toBeFocused();
```

The element must exist for both the positive and negated forms. A missing element
does not satisfy `not.toBeFocused()`.

### toBeInViewport()

Assert that a positive-area portion of the element intersects the current
viewport. It checks geometry, not whether another element covers the target.
It intentionally has no intersection-ratio option.

```typescript
const checkout = browser.locator('#checkout');
await checkout.expect().not.toBeInViewport();
await browser.evaluate(`document.querySelector('#checkout').scrollIntoView()`);
await checkout.expect().toBeInViewport();
```

`toBeVisible()` and `toBeInViewport()` answer different questions: a rendered
element below the fold can be visible but not in the viewport. The element must
exist for both viewport assertions; removal is instead expressed explicitly as
`await locator.waitFor({ state: 'detached' })`.

### toHaveCSS(property, value)

Assert the browser's **computed** value for a CSS property. Use CSS property
names such as `background-color`, not JavaScript names such as
`backgroundColor`.

Given this page:

```html
<style>
  .toolbar { display: flex; }
  .hidden { display: none; }
</style>

<nav id="primary" class="toolbar">Primary navigation</nav>
<nav id="secondary" class="toolbar hidden">Secondary navigation</nav>
```

the selector `.toolbar` locates **both** `<nav>` elements. `toHaveCSS()` does
not filter or change what the locator finds; like other element assertions, it
asserts the first matched element:

```typescript
await browser.expect('#primary').toHaveCSS('display', 'flex'); // passes
await browser.expect('#secondary').toHaveCSS('display', 'none'); // passes
await browser.expect('#secondary').toHaveCSS('display', 'flex'); // fails

await browser.expect('.toolbar').toHaveCount(2); // selector matched both
await browser.expect('.toolbar').toHaveCSS('display', 'flex'); // first match is #primary
```

Computed values include styles from stylesheets, inheritance, and the cascade;
they are not limited to the element's inline `style` attribute. Browsers can
normalize computed values—for example, colors may be returned as `rgb(...)`.
Use the form produced by `getComputedStyle()` when asserting such properties.

The negated form is also available:

```typescript
await browser.expect('#secondary').not.toHaveCSS('display', 'flex');
```

As with focus and viewport assertions, the element must exist for both forms.

## Page Assertions

Call `expect()` without a selector to assert the URL or title of the active
page. Strings match exactly; use a regular expression for partial matching.

```typescript
await browser.expect().toHaveURL('https://example.test/dashboard');
await browser.expect().toHaveURL(/\/dashboard(?:\?|$)/);
await browser.expect().toHaveTitle('Dashboard');
await browser.expect().not.toHaveURL(/\/login/);
```

An explicit `Page` supports the same API:

```typescript
const page = await browser.activePage();
await page.expect().toHaveTitle(/Dashboard/);
```

## Negation

Use `.not` to wait for the inverse of an assertion:

```typescript
await browser.expect('#error').not.toBeVisible();
await browser.expect('#input').not.toHaveValue('');
await browser.expect('#button').not.toHaveAttribute('disabled', 'true');
await browser.expect('.spinner').not.toHaveCount(1);
```

Negation does not apply one universal missing-element rule. Assertions about an
element's state or geometry—focus, CSS, checked/enabled state, and viewport
intersection—require an element for both their positive and negated forms. A
missing element therefore does not satisfy `not.toBeFocused()`,
`not.toHaveCSS()`, or `not.toBeInViewport()`.

`not.toBeVisible()` and the existing negative text/value/attribute/class
matchers do allow a missing element. Count assertions instead inspect the whole
collection, so zero is an ordinary count. Use `toHaveCount(0)` or
`waitFor({ state: 'detached' })` when removal is the intended outcome.

Prefer a positive assertion when the exact result is known. It produces a more
specific test and failure:

```typescript
// Prefer this when "none" is the intended final value.
await browser.expect('#menu').toHaveCSS('display', 'none');

// Use this only when any value other than "flex" is acceptable.
await browser.expect('#menu').not.toHaveCSS('display', 'flex');
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
await browser.expect().toHaveTitle('Dashboard');
await browser.expect().toHaveURL(/\/dashboard/);
```
