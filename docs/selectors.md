# Selectors & Locators

Every interaction — a click, a fill, an assertion — starts by pointing at an
element. This page is the complete guide to **naming** the element you want.
What you do with it afterwards lives in the [Element API](./element-api.md) and
[Assertions](./assertions.md).

## Three ways to name an element

CraftDriver accepts three kinds of "where is it?", and they all resolve to the
same kind of element handle:

```typescript
import { Browser, By } from 'craftdriver';

// 1. A CSS string — quickest for structural matching
await browser.click('#submit');

// 2. A By.* locator — a strategy object for one specific way of matching
await browser.find(By.role('button', { name: 'Save' })).click();

// 3. A getBy* shortcut — the common semantic strategies, straight on the browser
await browser.getByRole('button', { name: 'Save' }).click();
```

A few rules tie these together:

- **A bare string is always a CSS selector.** There is no `text=` or `role=`
  string shorthand — to match by text or role, use a `By.*` locator or a
  `getBy*` method.
- **`getByRole(...)` is exactly `find(By.role(...))`.** The `getBy*` methods are
  ergonomic shortcuts for the most common semantic `By.*` strategies. Use
  whichever reads better; they resolve identically.
- **`find()` vs `locator()`.** `find()` returns a one-shot handle. `locator()`
  returns a lazy, re-resolving handle you can filter, index (`.nth()`), and
  scope — see [Locators (lazy & chainable)](#locators-lazy--chainable). Both
  accept a string or a `By`.

> **Which one should I reach for?** Prefer locators that describe an element the
> way a person perceives it — its role, label, or visible text — plus test IDs
> for anything ambiguous. They keep working when the surrounding markup changes.
> Drop to CSS for structural matching, and to XPath only when nothing else fits.

## Quick reference

| To find an element by…    | Use                                      | It matches, e.g.                  |
| ------------------------- | ---------------------------------------- | --------------------------------- |
| Role + its label          | `getByRole('button', { name: 'Save' })`  | `<button>Save</button>`           |
| Visible text              | `getByText('Save')`                      | `<span>Save</span>`               |
| A form field's label      | `getByLabel('Email')`                    | `<label>Email</label><input>`     |
| Placeholder text          | `getByPlaceholder('Search')`             | `<input placeholder="Search">`    |
| Image `alt` text          | `getByAltText('Logo')`                   | `<img alt="Logo">`                |
| Tooltip (`title`)         | `getByTitle('Delete')`                   | `<button title="Delete">`         |
| Test id                   | `getByTestId('checkout')`                | `<button data-testid="checkout">` |
| Id                        | `By.id('email')` · `'#email'`            | `<input id="email">`              |
| Class                     | `By.className('primary')` · `'.primary'` | `<button class="primary">`        |
| `name` attribute          | `By.name('email')`                       | `<input name="email">`            |
| Tag                       | `By.tagName('h1')`                       | `<h1>…</h1>`                       |
| Any attribute             | `By.attr('role', 'dialog')`              | `<div role="dialog">`             |
| `data-*` attribute        | `By.dataAttr('state', 'open')`           | `<div data-state="open">`         |
| `aria-*` attribute        | `By.aria('expanded', 'true')`            | `<button aria-expanded="true">`   |
| Link text                 | `By.linkText('Docs')`                    | `<a href="/docs">Docs</a>`        |
| A CSS selector            | `By.css(…)` · any string                 | anything CSS can express          |
| An XPath expression       | `By.xpath(…)`                            | anything XPath can express        |

## Semantic locators

These describe an element by what it *is* to the user — its role, label, or
text — not by where it sits in the markup. They're the most readable and the
most resilient, so reach for them first. Each is a `getBy*` method on the
browser (and on any [locator](#locators-lazy--chainable)); the `By.*` form named
in each heading is the same strategy as an object you can pass to `find()`,
`locator()`, `click()`, or a filter.

> **Exact by default.** `getByRole`'s `name`, `getByText`, `getByLabel`,
> `getByPlaceholder`, `getByAltText`, and `getByTitle` all match the **whole**
> (whitespace-normalised) string by default. Pass `{ exact: false }` to match a
> substring instead.

### getByRole(role, options?)

Find an element by its **ARIA role** and, optionally, CraftDriver's practical
accessible-name approximation.

```html
<button>Sign in</button>
```

```typescript
browser.getByRole('button', { name: 'Sign in' });
```

- A **role** is the kind of control an element represents — `button`, `link`,
  `checkbox`, `textbox`, `heading`, and so on. Native elements carry an
  *implicit* role, so `getByRole('button')` matches a plain `<button>` and
  `<input type="submit">`, not only elements with an explicit `role="button"`.
- The **name** is the short label a user would recognize. CraftDriver matches
  the common sources: `aria-label`, simple `aria-labelledby`, visible text,
  associated `<label>` text for form controls, `value`, `alt`, and `title`.
  Pass it as `name` to pick one element out of several with the same role.

```html
<!-- the role is textbox; the name comes from the associated label -->
<label for="email">Email</label>
<input id="email" type="email" />
```

```typescript
browser.getByRole('textbox', { name: 'Email' });
browser.getByRole('checkbox', { name: 'Remember me' });
browser.getByRole('link', { name: 'Learn more' });
browser.getByRole('heading', { name: 'Welcome' });
```

> `getByRole` is an approximation of browser accessible-name computation, not a
> full ARIA engine. If the label itself is the thing you want to select by, use
> [`getByLabel()`](#getbylabel-text-options). To match
> `<input name="email">` by the HTML `name` attribute, use
> [`By.name()`](#by-name-name).

Options:

| Option          | Type      | Default | Description                                                          |
| --------------- | --------- | ------- | ------------------------------------------------------------------- |
| `name`          | `string`  | —       | Name to match (`aria-label`, simple `aria-labelledby`, text, label, `value`, `alt`, `title`). |
| `exact`         | `boolean` | `true`  | When `false`, match the name as a substring.                        |
| `includeHidden` | `boolean` | `false` | Also match elements hidden from assistive tech (see below).         |

By default an element is skipped when it — or any ancestor — carries `hidden` or
`aria-hidden="true"`, mirroring how those attributes remove a whole subtree from
the accessibility tree. Set `includeHidden: true` to match them anyway
(off-canvas menus, collapsed panels). CSS hiding such as `display:none` is
handled separately by the locator's visibility wait, not by this check.

```typescript
// Default: skip elements hidden from assistive tech (self or ancestor)
browser.getByRole('button', { name: 'Close' });

// Include hidden elements
browser.getByRole('button', { name: 'Close', includeHidden: true });
```

### getByText(text, options?)

Find the innermost element whose visible text matches.

```html
<p>Welcome back, Alice!</p>
```

```typescript
browser.getByText('Welcome back, Alice!');          // exact (default)
browser.getByText('Welcome back', { exact: false }); // substring
```

Text is whitespace-normalised — runs of spaces and line breaks collapse to a
single space — before matching. For case-insensitive or non-normalised matching,
use the `By.text` form, which also accepts `caseSensitive` and `trim`:

```typescript
browser.find(By.text('submit', { caseSensitive: false }));
browser.find(By.partialText('Submit')); // lower-level alias for { exact: false }
```

### getByLabel(text, options?)

Find a form control by its associated `<label>` — whether the label wraps the
control or points to it with `for`.

```html
<label for="pw">Password</label>
<input id="pw" type="password" />
```

```typescript
browser.getByLabel('Password');
browser.getByLabel('Pass', { exact: false });
```

### getByPlaceholder(text, options?)

Find an `<input>` or `<textarea>` by its placeholder.

```html
<input placeholder="Search products…" />
```

```typescript
browser.getByPlaceholder('Search products…');
```

### getByAltText(text, options?)

Find an `<img>`, `<area>`, or `<input type="image">` by its `alt` text.

```html
<img src="/logo.svg" alt="Company logo" />
```

```typescript
browser.getByAltText('Company logo');
```

### getByTitle(text, options?)

Find an element by its `title` attribute (the native browser tooltip).

```html
<button title="Delete row">🗑</button>
```

```typescript
browser.getByTitle('Delete row');
```

### getByTestId(testId)

Find an element by its `data-testid`. Test ids are invisible to users and
untouched by design changes, so they're the most stable choice for elements with
no meaningful role or text.

```html
<button data-testid="checkout">Proceed to checkout</button>
```

```typescript
browser.getByTestId('checkout');
```

> Each `getBy*` method has a `By.*` twin — `By.role`, `By.text`, `By.labelText`,
> `By.placeholder`, `By.altText`, `By.title`, `By.testId` — for when you're
> passing a locator into `find()`, `locator()`, `click()`, or a filter.

## Attribute and structural locators

When an element has no meaningful role or text, match it by id, class,
attribute, or position. These come as `By.*` locators (a plain string already
covers the CSS cases).

### By.id(id)

```html
<input id="email" />
```

```typescript
browser.find(By.id('email')); // same as browser.find('#email')
```

### By.css(selector)

Locate by any CSS selector — identical to passing the selector as a string.

```typescript
browser.find(By.css('input[type="email"]'));
browser.find(By.css('form.login #username'));
```

### By.className(name)

```html
<button class="primary">Save</button>
```

```typescript
browser.find(By.className('primary')); // same as browser.find('.primary')
```

### By.name(name)

Locate by the HTML `name` attribute.

```html
<input name="email" />
```

```typescript
browser.find(By.name('email'));
```

This is the `name` **attribute** — not the `name` option of
[`getByRole()`](#getbyrole-role-options), which matches the accessible name.

### By.tagName(tag)

```html
<h1>Page title</h1>
```

```typescript
browser.find(By.tagName('h1')); // the first <h1>
```

### By.attr(name, value)

Locate by any attribute and value.

```html
<div role="dialog">…</div>
```

```typescript
browser.find(By.attr('role', 'dialog')); // same as '[role="dialog"]'
```

### By.dataAttr(name, value)

Locate by a `data-*` attribute — pass the suffix only, `data-` is added for you.

```html
<div data-state="open">…</div>
```

```typescript
browser.find(By.dataAttr('state', 'open')); // same as '[data-state="open"]'
```

### By.aria(name, value)

Locate by an `aria-*` attribute — pass the suffix only, `aria-` is added for
you. Use this for a specific ARIA **state or property**; for role + name
matching use [`getByRole()`](#getbyrole-role-options).

```html
<button aria-expanded="true">Menu</button>
```

```typescript
browser.find(By.aria('expanded', 'true')); // same as '[aria-expanded="true"]'
```

### By.linkText(text) · By.partialLinkText(text)

Locate an `<a>` by its rendered text — exact for `linkText`, substring for
`partialLinkText`. These match only anchors, and compare the browser-rendered
text (so CSS `text-transform` is respected). For non-links or richer text
options, use [`getByText`](#getbytext-text-options) / `By.text`.

```html
<a href="/docs">Documentation</a>
```

```typescript
browser.find(By.linkText('Documentation'));   // exact anchor text
browser.find(By.partialLinkText('Read the')); // substring of anchor text
```

### By.xpath(expression)

The escape hatch for queries the other strategies can't express.

```typescript
browser.find(By.xpath('//button[@data-testid="submit"]'));
browser.find(By.xpath('//div[contains(@class, "error")]'));
```

## Choosing a locator

Prefer locators that describe intent; avoid ones that pin to incidental
structure.

```typescript
// ✅ Resilient — tracks what the element is
browser.getByRole('button', { name: 'Log in' });
browser.getByLabel('Email');
browser.getByTestId('checkout');
browser.find('#login-button');

// ❌ Fragile — breaks when markup or styling shifts
browser.find('div > div > button:nth-child(3)');
browser.find('.btn.mt-4.px-6'); // utility classes churn
```

A rough order of preference:

```
getByTestId  >  getByRole({ name })  >  getByLabel  >
getByText  >  By.id / By.css  >  By.xpath
```

The first few say *what the element is*; the last two pin to *how the page is
built* and break more easily. When an element is genuinely hard to select, add a
`data-testid` to it rather than reaching for a brittle CSS or XPath path.

## Locators (lazy & chainable)

`browser.locator(selector)` returns a `Locator` — a lazy, re-resolving handle
that supports composition, filtering, and indexed access.

Use `find()` for a single one-shot element, `findAll()` for the simple array
case, and `locator()` when you need composition or want to pick from a list.

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
const texts = await Promise.all(handles.map((h) => h.text()));

// Simple array shortcut (no filtering)
const allButtons = await browser.findAll('.buy-btn');
```

### Scoped semantic locators

`Locator` also exposes `getByRole` / `getByText` / `getByLabel` /
`getByPlaceholder` / `getByAltText` / `getByTitle` / `getByTestId`, each scoped
to that locator's match — the composable equivalent of the `browser.getBy*()`
methods above, for when you need to find something *within* a specific row,
card, or dialog rather than anywhere on the page.

```typescript
// Scope a role/text query to one product card, not the whole page
const card = browser.locator('.product-card').nth(2);
await card.getByRole('button', { name: 'Buy' }).click();
await card.getByText('In stock').expect().toBeVisible();
```

## Open Shadow DOM

CraftDriver crosses Shadow DOM with an explicit, lazy `shadowRoot()` boundary.
Call it on the locator or element handle for the shadow host, then locate within
the returned `ShadowRootLocator`:

```typescript
const card = browser.locator('user-card#account').shadowRoot();

await card.getByRole('button', { name: 'Edit' }).click();
await card.getByLabel('Display name').fill('Alice');
await card.locator('.status').expect().toHaveText('Saved');
```

The boundary is explicit: `browser.locator('user-card .status')` does not pierce
the root and ordinary CSS keeps its normal tree scope. Both API styles work:

```typescript
// Lazy Locator host — re-resolves the host and root for every operation.
const lazyRoot = browser.locator('#account').shadowRoot();

// ElementHandle style — browser.find() is locator-backed and auto-waits too.
const handleRoot = browser.find('#account').shadowRoot();
await handleRoot.find(By.testId('save')).click();
```

Nested open roots compose by crossing each boundary in order:

```typescript
const address = browser
  .locator('checkout-shell')
  .shadowRoot()
  .locator('address-form')
  .shadowRoot();

await address.getByPlaceholder('City').fill('Sofia');
await address.getByRole('button', { name: 'Save address' }).click();
```

`ShadowRootLocator` is a search context, not an element. It provides
`locator()`, `find()`, `findAll()`, and all `getBy*()` helpers; actions and
assertions live on the descendant `Locator`/`ElementHandle`. Filters, indexing,
auto-waiting, assertions, locator-scoped accessibility audits, `Page`, and
`Frame` contexts retain the complete root-aware query chain.

The host follows normal locator cardinality: when it matches more than one
element, use `first()`, `last()`, or `nth()` before `shadowRoot()` to select the
intended host. Descendant `count()` returns `0` for no current matches, while
actions and positive assertions auto-wait using the configured timeout.

Only roots exposed by the page's public `host.shadowRoot` getter are supported.
A missing or closed root throws `NO_OPEN_SHADOW_ROOT`; CraftDriver does not use
WebDriver as a closed-root backdoor. Detached roots restart the complete lazy
query and end with `DETACHED_SHADOW_ROOT` only when a stable root cannot be
established. Raw XPath inside a shadow root is transport-dependent; CSS and the
semantic `getBy*`/`By.*` helpers are the portable choices.

The same API is covered on Chrome, Firefox, and Safari. CraftDriver uses
WebDriver BiDi shadow primitives when the session supports them and falls back
to the standard WebDriver Classic shadow-root endpoints otherwise.

### Locator actions and state

| Method                          | Description                                            |
| ------------------------------- | ----------------------------------------------------- |
| `click(options?)`               | Click the first matching visible element              |
| `fill(text, options?)`          | Fill the first matching visible element               |
| `text(options?)`                | Get visible text                                      |
| `textContent(options?)`         | Alias for `text()`                                    |
| `isVisible(options?)`           | Return `true` if a matching element is visible        |
| `count()`                       | Count current matches without auto-wait               |
| `all()`                         | Return snapshot `ElementHandle`s for current matches  |
| `waitFor({ state, timeout? })`  | Wait for `attached`, `detached`, `visible`, `hidden`  |
| `expect()`                      | Element assertions scoped to this locator             |
| `a11y`                          | Accessibility audit scoped to this locator            |

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
