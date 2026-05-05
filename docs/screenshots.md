# Screenshots

craftdriver exposes a single options-bag `screenshot()` method on both
`Browser` and `ElementHandle`. PNG bytes are always returned as a
`Buffer`; pass `path` to also write the file in one step.

## Page screenshots

### `browser.screenshot(opts?)`

| Option     | Type                | Default      | Notes                                            |
| ---------- | ------------------- | ------------ | ------------------------------------------------ |
| `path`     | `string`            | —            | Write the PNG to this file path.                 |
| `selector` | `string \| By`      | full viewport| If set, capture only the matching element.       |
| `fullPage` | `boolean`           | `false`      | Capture the entire scrollable document. Requires BiDi. |
| `timeout`  | `number` (ms)       | default      | Wait timeout when locating `selector`.           |

`fullPage` and `selector` are mutually exclusive.

```typescript
// Viewport only (default), buffer
const buffer = await browser.screenshot();

// Viewport, written to disk
await browser.screenshot({ path: 'screenshots/homepage.png' });

// Whole scrollable document (BiDi `browsingContext.captureScreenshot`
// with `origin: "document"`).
await browser.screenshot({ fullPage: true, path: 'screenshots/full.png' });

// One element by CSS selector
const chart = await browser.screenshot({ selector: '#sales-chart' });

// One element, written to disk
await browser.screenshot({
  selector: '#sales-chart',
  path: 'screenshots/chart.png',
});
```

#### Full-page vs viewport

Viewport capture (`fullPage: false`, the default) uses the W3C Classic
`Take Screenshot` endpoint and is bounded by the visible viewport.
Full-page capture uses BiDi `browsingContext.captureScreenshot` with
`origin: "document"` and produces a PNG sized to the full scrollable
content — useful for visual diffs of long pages and for archiving the
complete rendered output. Full-page capture requires `enableBiDi: true`
(the default); on Classic-only sessions it throws.

## Element screenshots

### `element.screenshot(opts?)`

| Option    | Type        | Default | Notes                              |
| --------- | ----------- | ------- | ---------------------------------- |
| `path`    | `string`    | —       | Write the PNG to this file path.   |
| `timeout` | `number`    | default | Element resolution timeout.        |

```typescript
const buffer = await browser.find('#product-image').screenshot();
await browser.find('#logo').screenshot({ path: 'logo.png' });
```

## Use cases

### Test failure documentation

```typescript
afterEach(async (context) => {
  if (context.task.result?.state === 'fail') {
    const name = context.task.name.replace(/\s+/g, '-');
    await browser.screenshot({ path: `screenshots/${name}.png` });
  }
  await browser.quit();
});
```

### Visual comparison baseline

```typescript
await browser.navigateTo('https://example.com');
await browser.screenshot({ path: 'baseline/homepage.png' });

// Later, capture the candidate and diff with an image library:
await browser.navigateTo('https://example.com');
await browser.screenshot({ path: 'current/homepage.png' });
```

### Component screenshots

```typescript
await browser.screenshot({ selector: 'header',   path: 'components/header.png' });
await browser.screenshot({ selector: '.sidebar', path: 'components/sidebar.png' });
await browser.screenshot({ selector: 'footer',   path: 'components/footer.png' });
```

### Before / after an action

```typescript
await browser.screenshot({ selector: '#order-form', path: 'before-submit.png' });
await browser.find('#submit-order').click();
await browser.expect('#confirmation').toBeVisible();
await browser.screenshot({ selector: '#confirmation', path: 'after-submit.png' });
```

## Tips

### Create the screenshot directory

`screenshot({ path })` writes through `fs.writeFile`; the parent
directory must already exist:

```typescript
import { mkdir } from 'fs/promises';
await mkdir('screenshots', { recursive: true });
await browser.screenshot({ path: 'screenshots/test.png' });
```

### Timestamped filenames

```typescript
const ts = new Date().toISOString().replace(/[:.]/g, '-');
await browser.screenshot({ path: `screenshots/page-${ts}.png` });
```

### Wait for stability

```typescript
await browser.navigateTo('https://example.com');
await browser.expect('#main-content').toBeVisible();
await browser.screenshot({ path: 'stable-page.png' });
```

## Buffer usage

When you only need bytes (uploading, image diffing), omit `path`:

```typescript
const buffer = await browser.screenshot();

import { writeFile } from 'fs/promises';
await writeFile('screenshot.png', buffer);

await uploadToS3(buffer, 'screenshots/latest.png');
```
