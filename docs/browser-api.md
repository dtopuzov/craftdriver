# Browser API

The `Browser` class is the main entry point for browser automation.

## Launching

```typescript
import { Browser } from 'craftdriver';

// Basic launch
const browser = await Browser.launch({ browserName: 'chrome' });

// With BiDi enabled (for session management, network mocking)
const browser = await Browser.launch({
  browserName: 'chrome',
  enableBiDi: true,
});

// With pre-loaded session state
const browser = await Browser.launch({
  browserName: 'chrome',
  enableBiDi: true,
  storageState: './auth.json',
});
```

## Navigation

```typescript
// Navigate to URL
await browser.navigateTo('https://example.com');

// Get current URL
const url = await browser.url();

// Get page title
const title = await browser.title();
```

## Element Interaction

```typescript
// Click an element
await browser.click('#submit-btn');
await browser.click(By.text('Submit'));

// Fill text input
await browser.fill('#username', 'testuser');

// Clear input
await browser.clear('#search');

// Get element value
const value = await browser.getValue('#input');

// Get element attribute
const href = await browser.getAttribute('a.link', 'href');
```

## Finding Elements

```typescript
// Returns an ElementHandle for chained operations
const element = browser.find('#my-element');

// With By locators
const button = browser.find(By.text('Click me'));
const input = browser.find(By.placeholder('Enter email'));
```

## Playwright-style Locators

```typescript
// By role
browser.getByRole('button', { name: 'Submit' });

// By visible text
browser.getByText('Hello World');
browser.getByText('partial', { exact: false });

// By label
browser.getByLabel('Username');

// By placeholder
browser.getByPlaceholder('Enter email');

// By test ID
browser.getByTestId('submit-btn');
```

## Waiting

```typescript
// Wait for element to be visible
await browser.waitForVisible('#modal');

// Wait for element to be hidden
await browser.waitForHidden('#loading');

// Wait for element to be attached to DOM
await browser.waitForAttached('#dynamic-content');

// Wait for element to be detached
await browser.waitForDetached('#removed-element');

// Pause for fixed time
await browser.pause(1000); // 1 second

// Wait for custom condition
await browser.waitFor(async () => {
  const count = await browser.find('#items').text();
  return parseInt(count) > 5;
});
```

## Assertions

```typescript
// Assert text content
await browser.expect('#message').toHaveText('Success');
await browser.expect('#message').toContainText('Success');

// Assert visibility
await browser.expect('#modal').toBeVisible();
await browser.expect('#modal').not.toBeVisible();

// Assert attribute
await browser.expect('a').toHaveAttribute('href', '/home');

// Assert value
await browser.expect('#input').toHaveValue('test');
```

## Screenshots

```typescript
// Capture full page
const buffer = await browser.screenshot();

// Capture specific element
const elementBuffer = await browser.screenshot('#header');

// Save to file
await browser.saveScreenshot('page.png');
await browser.saveScreenshot('element.png', '#header');
```

## Session Management

See [Session Management](./session-management.md) for full details.

```typescript
// Access storage manager
const storage = browser.storage;

// Save current session to file
await browser.saveState('./session.json');

// Load session from file
await browser.loadState('./session.json');
```

## Cleanup

```typescript
// Always quit the browser when done
await browser.quit();
```

## Properties

| Property   | Type                  | Description                    |
| ---------- | --------------------- | ------------------------------ |
| `keyboard` | `KeyboardController`  | Low-level keyboard control     |
| `mouse`    | `MouseController`     | Low-level mouse control        |
| `storage`  | `SessionStateManager` | Cookie and storage management  |
| `network`  | `NetworkManager`      | Network mocking (BiDi only)    |
| `logs`     | `LogManager`          | Console/error logs (BiDi only) |
