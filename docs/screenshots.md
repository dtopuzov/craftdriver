# Screenshots

CraftDriver provides methods to capture screenshots of the page or individual elements.

## Page Screenshots

### screenshot()

Capture the visible viewport and return as a Buffer.

```typescript
const buffer = await browser.screenshot();
```

### saveScreenshot(path)

Capture the viewport and save directly to a file.

```typescript
await browser.saveScreenshot('screenshots/homepage.png');
```

## Element Screenshots

### screenshot(selector)

Capture a specific element as a Buffer.

```typescript
const chartBuffer = await browser.screenshot('#sales-chart');
```

### saveScreenshot(path, selector)

Capture a specific element and save to file.

```typescript
await browser.saveScreenshot('screenshots/chart.png', '#sales-chart');
```

### Element Handle Screenshot

Use the `screenshot()` method on an ElementHandle:

```typescript
await browser.find('#product-image').screenshot('product.png');
```

## Use Cases

### Test Failure Documentation

Capture screenshots when tests fail:

```typescript
import { Browser } from 'craftdriver';
import { test, expect, afterEach } from 'vitest';

let browser: Browser;

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') {
    const name = context.task.name.replace(/\s+/g, '-');
    await browser.saveScreenshot(`screenshots/${name}.png`);
  }
  await browser.quit();
});

test('login flow', async () => {
  browser = await Browser.launch({ browserName: 'chrome' });
  // ... test code
});
```

### Visual Comparison Baseline

Capture baseline images for visual regression testing:

```typescript
await browser.navigateTo('https://example.com');
await browser.saveScreenshot('baseline/homepage.png');

// Later, compare with:
await browser.navigateTo('https://example.com');
await browser.saveScreenshot('current/homepage.png');
// Use image comparison library to diff
```

### Component Screenshots

Capture individual components for documentation or review:

```typescript
// Capture each component
await browser.saveScreenshot('components/header.png', 'header');
await browser.saveScreenshot('components/sidebar.png', '.sidebar');
await browser.saveScreenshot('components/footer.png', 'footer');
```

### Screenshot Before Action

Document state before critical actions:

```typescript
// Before submitting
await browser.saveScreenshot('before-submit.png', '#order-form');

await browser.find('#submit-order').click();

// After submission
await browser.waitForVisible('#confirmation');
await browser.saveScreenshot('after-submit.png', '#confirmation');
```

## Tips

### Create Screenshot Directory

Ensure the target directory exists:

```typescript
import { mkdir } from 'fs/promises';

await mkdir('screenshots', { recursive: true });
await browser.saveScreenshot('screenshots/test.png');
```

### Timestamp Screenshots

Include timestamps for unique filenames:

```typescript
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
await browser.saveScreenshot(`screenshots/page-${timestamp}.png`);
```

### Wait for Stability

Wait for animations or loading to complete before capturing:

```typescript
await browser.navigateTo('https://example.com');
await browser.waitForVisible('#main-content');
await browser.pause(500); // Wait for animations
await browser.saveScreenshot('stable-page.png');
```

## Buffer Usage

When you get a screenshot as a Buffer, you can:

```typescript
const buffer = await browser.screenshot();

// Save manually
import { writeFile } from 'fs/promises';
await writeFile('screenshot.png', buffer);

// Upload to a service
await uploadToS3(buffer, 'screenshots/latest.png');

// Base64 encode
const base64 = buffer.toString('base64');
```
