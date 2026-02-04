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

Access the mouse API via `browser.mouse`.

### click(x, y)

Click at specific coordinates.

```typescript
await browser.mouse.click(100, 200);
```

### move(x, y)

Move the mouse to coordinates.

```typescript
await browser.mouse.move(150, 300);
```

### down()

Press the mouse button.

```typescript
await browser.mouse.down();
```

### up()

Release the mouse button.

```typescript
await browser.mouse.up();
```

### wheel(deltaX, deltaY)

Scroll the page.

```typescript
// Scroll down
await browser.mouse.wheel(0, 100);

// Scroll up
await browser.mouse.wheel(0, -100);

// Scroll right
await browser.mouse.wheel(100, 0);
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
await browser.mouse.move(100, 100);
await browser.mouse.down();

// Draw a line
await browser.mouse.move(200, 100);
await browser.mouse.move(200, 200);
await browser.mouse.move(100, 200);
await browser.mouse.move(100, 100);

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
await browser.find('#search').fill('query').press('Enter');

// Tab out of a field
await browser.find('#username').fill('user').press('Tab');
```

This is often more convenient than using the global keyboard API.
