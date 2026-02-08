# Mobile Emulation

CraftDriver supports mobile device emulation using Chrome's built-in mobile emulation feature. This allows you to test responsive designs and mobile-specific behavior.

## Quick Start

```typescript
import { Browser } from 'craftdriver';

const browser = await Browser.launch({
  browserName: 'chrome',
  mobileEmulation: 'iPhone 14',
});

await browser.navigateTo('https://example.com');
// Page loads with iPhone 14 viewport, touch events, and mobile user agent
```

## Using Device Presets

CraftDriver includes presets for popular devices:

```typescript
// Use preset by name
const browser = await Browser.launch({
  browserName: 'chrome',
  mobileEmulation: 'iPhone 14',
});
```

### Available Presets

| Device             | Width | Height | Pixel Ratio | Platform |
| ------------------ | ----- | ------ | ----------- | -------- |
| iPhone 14          | 390   | 844    | 3           | iOS      |
| iPhone 14 Pro Max  | 430   | 932    | 3           | iOS      |
| iPhone SE          | 375   | 667    | 2           | iOS      |
| Pixel 7            | 412   | 915    | 2.625       | Android  |
| Pixel 7 Pro        | 412   | 892    | 3.5         | Android  |
| Samsung Galaxy S23 | 360   | 780    | 3           | Android  |
| iPad Pro 11        | 834   | 1194   | 2           | iPadOS   |
| iPad Mini          | 768   | 1024   | 2           | iPadOS   |

You can also access presets programmatically:

```typescript
import { devices } from 'craftdriver';

console.log(devices['iPhone 14']);
// { deviceMetrics: { width: 390, height: 844, pixelRatio: 3, ... }, userAgent: '...' }
```

## Custom Device Configuration

For custom devices or specific testing needs:

```typescript
const browser = await Browser.launch({
  browserName: 'chrome',
  mobileEmulation: {
    deviceMetrics: {
      width: 320,
      height: 568,
      pixelRatio: 2,
      mobile: true, // Enable mobile mode
      touch: true, // Enable touch events
    },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) ...',
  },
});
```

### Device Metrics Options

| Option     | Type    | Default | Description                             |
| ---------- | ------- | ------- | --------------------------------------- |
| width      | number  | -       | Viewport width in pixels                |
| height     | number  | -       | Viewport height in pixels               |
| pixelRatio | number  | -       | Device pixel ratio (e.g., 2 for Retina) |
| mobile     | boolean | true    | Enable mobile mode                      |
| touch      | boolean | true    | Enable touch event emulation            |

## Using Chrome's Built-in Devices

Chrome has its own device database. You can use any device name Chrome recognizes:

```typescript
const browser = await Browser.launch({
  browserName: 'chrome',
  mobileEmulation: {
    deviceName: 'Nexus 5', // Any device Chrome knows
  },
});
```

> **Note:** Chrome's device names are case-sensitive. Check Chrome DevTools for available names.

## What Gets Emulated

When mobile emulation is enabled:

- **Viewport**: Set to device dimensions
- **Device Pixel Ratio**: High DPI rendering
- **Touch Events**: `touchstart`, `touchend`, `touchmove` work
- **User Agent**: Reflects mobile browser
- **CSS Media Queries**: `@media (max-width: ...)` respond correctly
- **`navigator.maxTouchPoints`**: Reports touch capability

## Examples

### Test Responsive Breakpoints

```typescript
import { Browser } from 'craftdriver';

const viewports = [
  { name: 'Mobile', width: 375, height: 667 },
  { name: 'Tablet', width: 768, height: 1024 },
  { name: 'Desktop', width: 1280, height: 800 },
];

for (const vp of viewports) {
  const browser = await Browser.launch({
    browserName: 'chrome',
    mobileEmulation: {
      deviceMetrics: { width: vp.width, height: vp.height, pixelRatio: 2 },
    },
  });

  await browser.navigateTo('https://example.com');
  await browser.saveScreenshot(`screenshot-${vp.name}.png`);
  await browser.quit();
}
```

### Test Mobile Navigation Menu

```typescript
const browser = await Browser.launch({
  browserName: 'chrome',
  mobileEmulation: 'iPhone 14',
});

await browser.navigateTo('https://example.com');

// Mobile hamburger menu should be visible
await browser.expect('#mobile-menu-button').toBeVisible();

// Desktop nav should be hidden
const desktopNav = await browser.find('#desktop-nav').isVisible();
expect(desktopNav).toBe(false);

// Open mobile menu
await browser.click('#mobile-menu-button');
await browser.expect('#mobile-menu').toBeVisible();
```

### Combine with BiDi Features

Mobile emulation works alongside BiDi features:

```typescript
const browser = await Browser.launch({
  browserName: 'chrome',
  enableBiDi: true,
  mobileEmulation: 'Pixel 7',
});

// Mock mobile-specific API
await browser.network.mock('**/api/mobile-config', {
  status: 200,
  body: { mobileOptimized: true },
});

await browser.navigateTo('https://example.com');

// Check for console errors
const errors = browser.logs.getErrors();
expect(errors).toHaveLength(0);
```

## Limitations

- **Chrome/Chromium only**: Mobile emulation uses Chrome-specific capabilities
- **Not real device**: Some mobile behaviors can't be emulated (e.g., actual Safari rendering)
- **Fixed at launch**: Device configuration is set when the browser launches and can't be changed mid-session
- **No orientation change**: To test landscape, specify a wider width than height in deviceMetrics
