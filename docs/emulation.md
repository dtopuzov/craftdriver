# Emulation

`browser.emulate(options)` overrides what a page sees from `matchMedia`,
`navigator.language`, `Intl.*`, and the network stack. One ergonomic method,
six independent knobs.

```typescript
import { Browser } from 'craftdriver';

const browser = await Browser.launch({ browserName: 'chrome' });

await browser.emulate({
  colorScheme: 'dark',
  locale: 'de-DE',
  timezoneId: 'Europe/Berlin',
});
```

> **BiDi required.** All emulation overrides use BiDi commands
> (`enableBiDi: true`, the default). Calling `emulate()` with BiDi
> disabled throws. CSS media features and `offline` additionally require
> Chromium (see the cross-browser column below).

## Options

| Option | What the page sees | Transport | Cross-browser |
|---|---|---|---|
| `colorScheme` | `prefers-color-scheme` media query | CDP `Emulation.setEmulatedMedia` (over the BiDi+CDP bridge) | Chromium only |
| `reducedMotion` | `prefers-reduced-motion` media query | CDP `Emulation.setEmulatedMedia` (over the BiDi+CDP bridge) | Chromium only |
| `forcedColors` | `forced-colors` media query | CDP `Emulation.setEmulatedMedia` (over the BiDi+CDP bridge) | Chromium only |
| `locale` | `navigator.language`, `Intl.*` formatting | BiDi `emulation.setLocaleOverride` | yes |
| `timezoneId` | `Intl.DateTimeFormat`, `Date` offsets | BiDi `emulation.setTimezoneOverride` | yes |
| `offline` | `navigator.onLine`, network stack | CDP `Network.emulateNetworkConditions` (over the BiDi+CDP bridge) | Chromium only |

All options still require an active BiDi session (`enableBiDi: true`, the
default) — the four CDP-backed options ride over a CDP bridge that BiDi
opens, they don't work with BiDi disabled.

- Pass `null` for any field to clear that override.
- Calling `emulate({})` is a no-op.
- Settings persist across navigations in the same session.

### Type

```typescript
interface EmulateOptions {
  colorScheme?: 'light' | 'dark' | 'no-preference' | null;
  reducedMotion?: 'reduce' | 'no-preference' | null;
  forcedColors?: 'active' | 'none' | null;
  locale?: string | null;        // BCP-47, e.g. 'de-DE'
  timezoneId?: string | null;    // IANA, e.g. 'Europe/Berlin'
  offline?: boolean;
}
```

## Use cases

### Dark mode rendering

Verify your theme renders correctly without flipping the OS preference.
Real CSS `@media (prefers-color-scheme: dark)` rules apply — this is not a
JavaScript-only patch.

```typescript
await browser.emulate({ colorScheme: 'dark' });
await browser.navigateTo('https://app.example.com');

const bg = await browser.find('body').getCssValue('background-color');
expect(bg).toBe('rgb(17, 17, 17)');
```

### Offline PWA / service-worker fallback

Confirm your offline banner appears and cached pages still load when the
network drops.

```typescript
await browser.navigateTo('https://pwa.example.com');
await browser.emulate({ offline: true });

await browser.click('#refresh');
await browser.expect('#offline-banner').toBeVisible();

await browser.emulate({ offline: false });
```

### Locale + timezone formatting bugs

Catch number/date/currency rendering issues without spinning up a fresh
browser for each locale.

```typescript
await browser.emulate({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
await browser.navigateTo('https://shop.example.com/cart');

// "12,50 €" instead of "$12.50"
await browser.expect('#total').toHaveText('12,50 €');

// "Liefertermin" in German, Berlin-local cutoff time
await browser.expect('#delivery-cutoff').toContainText('18:00');
```

### Reduced motion (a11y regression)

Confirm animations are actually suppressed for users who request it.

```typescript
await browser.emulate({ reducedMotion: 'reduce' });
await browser.navigateTo('https://app.example.com');

const anim = await browser.find('.hero').getCssValue('animation-name');
expect(anim).toBe('none');
```

### Forced colors (Windows high-contrast)

Catch buttons that lose their outline or icons that disappear when the OS
forces a high-contrast palette.

```typescript
await browser.emulate({ forcedColors: 'active' });
await browser.navigateTo('https://app.example.com');

await browser.expect('button.primary').toBeVisible();
```

## Clearing overrides

Pass `null` (or `false` for `offline`) to revert a single field. Other
fields stay as-is.

```typescript
await browser.emulate({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

// Clear the timezone, keep the locale
await browser.emulate({ timezoneId: null });

// Clear everything you may have set
await browser.emulate({
  colorScheme: null,
  reducedMotion: null,
  forcedColors: null,
  locale: null,
  timezoneId: null,
  offline: false,
});
```

## Errors

- **`emulate() requires BiDi`** — you launched with `enableBiDi: false`.
  Re-enable BiDi.
- **`emulate({ colorScheme }) is not supported on Firefox yet`** — the
  CSS-media-feature and `offline` paths currently use the BiDi+CDP
  bridge, which only Chromium exposes. Use `locale` / `timezoneId` on
  Firefox, or run the test on Chrome/Chromium.
- **`CDP command \`...\` failed`** — usually means the browser is not a
  Chromium build with the BiDi+CDP bridge enabled. Confirm
  `browserName: 'chrome'` or `'chromium'`.
