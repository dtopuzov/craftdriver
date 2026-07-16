# Keyboard & Mouse

CraftDriver provides low-level keyboard and mouse APIs for complex interaction scenarios.

## Keyboard

Access the keyboard API via `browser.keyboard`.

### press(key)

Press and release a key.

```typescript
await browser.keyboard.press('Enter');
await browser.keyboard.press('Tab');
await browser.keyboard.press('Escape');
```

Common key names:

- Navigation: `'Tab'`, `'Enter'`, `'Escape'`, `'Backspace'`, `'Delete'`
- Arrows: `'ArrowUp'`, `'ArrowDown'`, `'ArrowLeft'`, `'ArrowRight'`
- Modifiers: `'Shift'`, `'Control'`, `'Alt'`, `'Meta'`
- Function: `'F1'` through `'F12'`
- Special: `'Home'`, `'End'`, `'PageUp'`, `'PageDown'`, `'Insert'`

### type(text)

Type a string of text character by character.

```typescript
await browser.keyboard.type('Hello, World!');
```

### down(key)

Press and hold a key.

```typescript
await browser.keyboard.down('Shift');
```

### up(key)

Release a held key.

```typescript
await browser.keyboard.up('Shift');
```

### chord(...keys)

Press a key combination.

```typescript
await browser.keyboard.chord('Control', 'a');
await browser.keyboard.chord('Shift', 'Tab');
```

### Key Combinations

Combine `down()` and `up()` for modifier key combinations:

```typescript
// Ctrl+A (select all)
await browser.keyboard.down('Control');
await browser.keyboard.press('a');
await browser.keyboard.up('Control');

// Shift+Tab (reverse tab)
await browser.keyboard.down('Shift');
await browser.keyboard.press('Tab');
await browser.keyboard.up('Shift');
```

### Examples

#### Search and Submit

```typescript
await browser.find('#search').click();
await browser.keyboard.type('craftdriver');
await browser.keyboard.press('Enter');
```

#### Form Navigation with Tab

```typescript
await browser.find('#first-name').fill('John');
await browser.keyboard.press('Tab');
await browser.keyboard.type('Doe'); // Now in last-name field
await browser.keyboard.press('Tab');
await browser.keyboard.type('john@example.com');
```

#### Select All and Delete

```typescript
await browser.find('#input').click();
await browser.keyboard.down('Control');
await browser.keyboard.press('a');
await browser.keyboard.up('Control');
await browser.keyboard.press('Backspace');
```

---

## Mouse

Access the mouse API via `browser.mouse`. `click()`, `move()`, and
`dragAndDrop()` all accept a `Target`: a CSS selector string, a `By`
locator, or `{ x, y }` coordinates.

### click(target, options?)

Click at coordinates or on an element.

```typescript
await browser.mouse.click({ x: 100, y: 200 });
await browser.mouse.click('#submit');
await browser.mouse.click('#submit', { button: 'right', clickCount: 2 });
```

### dblclick(target, options?)

Double-click at coordinates or on an element (shorthand for `click(target, { clickCount: 2 })`).

```typescript
await browser.mouse.dblclick('#item');
```

### move(target, options?)

Move the mouse to coordinates or over an element.

```typescript
await browser.mouse.move({ x: 150, y: 300 });
await browser.mouse.move('#target');
```

### down(button?)

Press the mouse button.

```typescript
await browser.mouse.down();
await browser.mouse.down('right');
```

### up(button?)

Release the mouse button.

```typescript
await browser.mouse.up();
await browser.mouse.up('right');
```

### wheel(deltaX, deltaY, target?)

Scroll the page.

```typescript
// Scroll down
await browser.mouse.wheel(0, 100);

// Scroll up
await browser.mouse.wheel(0, -100);

// Scroll right
await browser.mouse.wheel(100, 0);

// Scroll while targeting an element
await browser.mouse.wheel(0, 300, '#scroll-panel');
```

### dragAndDrop(from, to)

Drag from one position to another.

```typescript
await browser.mouse.dragAndDrop(
  { x: 100, y: 100 }, // Start position
  { x: 300, y: 300 } // End position
);
```

### Examples

#### Custom Drag Operation

```typescript
// Get element positions
const source = await browser.find('#draggable').boundingBox();
const target = await browser.find('#drop-zone').boundingBox();

// Calculate centers
const startX = source.x + source.width / 2;
const startY = source.y + source.height / 2;
const endX = target.x + target.width / 2;
const endY = target.y + target.height / 2;

// Perform drag
await browser.mouse.dragAndDrop({ x: startX, y: startY }, { x: endX, y: endY });
```

#### Canvas Drawing

```typescript
// Move to start position
await browser.mouse.move({ x: 100, y: 100 });
await browser.mouse.down();

// Draw a line
await browser.mouse.move({ x: 200, y: 100 });
await browser.mouse.move({ x: 200, y: 200 });
await browser.mouse.move({ x: 100, y: 200 });
await browser.mouse.move({ x: 100, y: 100 });

await browser.mouse.up();
```

#### Scroll Through Content

```typescript
// Navigate to page
await browser.navigateTo('https://example.com/long-page');

// Scroll down gradually
for (let i = 0; i < 5; i++) {
  await browser.mouse.wheel(0, 200);
  await browser.pause(500);
}
```

---

## Element-Level Keyboard Shortcuts

For element-scoped key presses, use the `press()` method on ElementHandle:

```typescript
// Press Enter in a specific input
const search = browser.find('#search');
await search.fill('query');
await search.press('Enter');

// Tab out of a field
const username = browser.find('#username');
await username.fill('user');
await username.press('Tab');
```

This is often more convenient than using the global keyboard API.

---

## Touch gestures

When running Chrome/Chromium with `mobileEmulation`, or a remote real-device
session whose provider supports W3C touch-pointer actions, two convenience
gestures are exposed under `browser.gesture`:

```typescript
// Swipe from one point to another (px coordinates).
await browser.gesture.swipe({
  from: [200, 600],
  to:   [200, 200],
  durationMs: 300,
});

// Pinch / zoom centered on a point.
await browser.gesture.pinch({
  center: [200, 400],
  scale: 0.5,      // < 1 zooms out, > 1 zooms in
  distance: 100,   // initial finger separation, px
  durationMs: 250,
});
```

These use W3C Pointer Actions and do not require BiDi. Remote support depends
on the selected device, browser, and provider. Local desktop Safari rejects
touch gestures because it has no documented touch-pointer automation surface.
