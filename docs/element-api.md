# Element API

The `ElementHandle` provides methods for interacting with individual DOM elements.

## Getting an ElementHandle

```typescript
// Via browser.find()
const element = browser.find('#my-element');
const button = browser.find(By.text('Submit'));

// Chained operations
await browser.find('#input').fill('text').press('Enter');
```

## Methods

### click()

Click on the element.

```typescript
await browser.find('#button').click();
```

### fill(text, options?)

Fill a text input with the given value.

```typescript
await browser.find('#username').fill('testuser');

// With options
await browser.find('#email').fill('test@example.com', { timeout: 5000 });
```

### clear(options?)

Clear the input value.

```typescript
await browser.find('#search').clear();
```

### press(key)

Press a keyboard key while focused on the element.

```typescript
await browser.find('#input').press('Enter');
await browser.find('#textarea').press('Tab');
await browser.find('#field').press('Backspace');
```

Available keys: `'Enter'`, `'Tab'`, `'Escape'`, `'Backspace'`, `'ArrowUp'`, `'ArrowDown'`, `'ArrowLeft'`, `'ArrowRight'`, etc.

### hover(options?)

Move the mouse to hover over the element.

```typescript
// Reveal a tooltip
await browser.find('#info-icon').hover();

// Open a dropdown menu on hover
await browser.find('.menu-trigger').hover();
await browser.find('.menu-item').click();
```

### select(value, options?)

Select an option from a `<select>` dropdown by value.

```typescript
await browser.find('#country').select('us');
await browser.find('#language').select('en');
```

> ⚠️ **Note:** This method only works on `<select>` elements. It will throw an error if used on other element types.

### text()

Get the visible text content of the element.

```typescript
const message = await browser.find('#result').text();
console.log(message); // "Success!"
```

### value()

Get the current value of an input element.

```typescript
const inputValue = await browser.find('#email').value();
```

### getAttribute(name)

Get an attribute value from the element.

```typescript
const href = await browser.find('a.link').getAttribute('href');
const disabled = await browser.find('#btn').getAttribute('disabled');
```

### isVisible()

Check if the element is visible on the page.

```typescript
const visible = await browser.find('#modal').isVisible();
if (visible) {
  await browser.find('#modal .close').click();
}
```

### isEnabled()

Check if the element is enabled (not disabled).

```typescript
const enabled = await browser.find('#submit').isEnabled();
```

### isChecked()

Check if a checkbox or radio button is checked.

```typescript
const checked = await browser.find('#agree-terms').isChecked();
```

### boundingBox()

Get the element's position and size.

```typescript
const box = await browser.find('#target').boundingBox();
// { x: 100, y: 200, width: 300, height: 50 }
```

### screenshot(path?)

Take a screenshot of just this element.

```typescript
// Get as buffer
const buffer = await browser.find('#chart').screenshot();

// Save to file
await browser.find('#logo').screenshot('logo.png');
```

### expect()

Get an ExpectApi scoped to this element for assertions.

```typescript
await browser.find('#message').expect().toHaveText('Success');
await browser.find('#input').expect().toHaveValue('test@example.com');
```

## Method Chaining

ElementHandle methods that don't return values can be chained:

```typescript
await browser.find('#username').fill('testuser').press('Tab');

await browser.find('#password').fill('secret123').press('Enter');
```

## Examples

### Form Filling

```typescript
await browser.find('#first-name').fill('John');
await browser.find('#last-name').fill('Doe');
await browser.find('#email').fill('john@example.com');
await browser.find('#country').select('us');
await browser.find('#agree-terms').click();
await browser.find('#submit').click();
```

### Hover Interactions

```typescript
// Reveal dropdown menu
await browser.find('#user-menu').hover();
await browser.find('#logout-link').click();
```

### Conditional Actions

```typescript
const modal = browser.find('#cookie-banner');
if (await modal.isVisible()) {
  await browser.find('#accept-cookies').click();
}
```

### Getting Element State

```typescript
const button = browser.find('#submit');

const text = await button.text();
const enabled = await button.isEnabled();
const visible = await button.isVisible();

console.log({ text, enabled, visible });
```
