# Craftdriver Documentation

This document covers the public API and common patterns. The library is TypeScript-first and ships types.

## Prerequisites

Ensure appropriate driver for your browser is in your PATH.
It is easy, if you are using macOS or linux just run `npm i -g chromedriver`, otherwise ask ChatGPT how to setup browser drivers.

## API Reference

### Browser

```ts
launch(options?: { browserName?: 'chrome' | 'chromium'; chromeService?: ChromeService }): Promise<Browser>
navigateTo(url: string): Promise<void>
url(): Promise<string>
title(): Promise<string>
quit(): Promise<void>
click(selector: string | By): Promise<void>
type(selector: string | By, text: string, opts?: { mask?: boolean; timeout?: number }): Promise<void>
expect(selector: string | By): ExpectApi
find(selector: string | By): ElementHandle
screenshot(pathOrSelector: string, maybePath?: string): Promise<Buffer>
keyboard: KeyboardController
mouse: MouseController
actions(): ActionsBuilder
waitFor(check: Function, options?: { timeout?: number; interval?: number; message?: string }): Promise<any>
```

Example:

```ts
const browser = await Browser.launch({ browserName: 'chrome' });
await browser.navigateTo('http://127.0.0.1:8080/public/login.html');
await browser.type('#username', 'user');
await browser.type('#password', 'secret');
await browser.click('#submit');
await browser.expect('#result').toHaveText('Welcome user');
await browser.quit();
```

### ElementHandle

Created via `browser.find(selectorOrBy)`.

```ts
click(): Promise<void>
type(text: string, options?: { timeout?: number }): Promise<void>
press(key: KeyValue): Promise<void>
screenshot(path?: string): Promise<Buffer>
text(): Promise<string>
expect(): ExpectApi
```

### Expect API

```ts
toHaveText(expected: string | RegExp, opts?: { timeout?: number }): Promise<void>
toBeVisible(opts?: { timeout?: number }): Promise<void>
not.toBeVisible(opts?: { timeout?: number }): Promise<void>
```

### Keyboard

```ts
await browser.keyboard.type('hello');
await browser.keyboard.press(Key.Enter);
await browser.keyboard.down(Key.Control);
await browser.keyboard.up(Key.Control);
await browser.keyboard.chord(Key.Control, 'a');
```

### Mouse

```ts
await browser.mouse.click('#btn');
await browser.mouse.move('#box');
await browser.mouse.down();
await browser.mouse.up();
await browser.mouse.dblclick('#box');
await browser.mouse.dragAndDrop('#drag-source', '#drag-target');
await browser.mouse.dragAndDrop('#drag-source', { x: 10, y: 10 }); // viewport point
```

### Screenshots

Browser API:

```ts
screenshot(selector?: string | By): Promise<Buffer>
saveScreenshot(path: string, selector?: string | By): Promise<Buffer>
```

Element API:

```ts
elementHandle.screenshot(path?: string): Promise<Buffer>
```

Examples:

```ts
// Full page bytes
const buf = await browser.screenshot();
// Element bytes
const elBuf = await browser.screenshot('#logo');
// Save full page
await browser.saveScreenshot('screens/full.png');
// Save element
await browser.saveScreenshot('screens/logo.png', '#logo');
```

### By locators

Available helpers (resolved to CSS or XPath):

```ts
By.css(selector: string)
By.xpath(xpath: string)
By.id(id: string)
By.nameAttr(name: string)
By.className(cls: string)
By.tag(tag: string)
By.attr(name: string, value: string)
By.dataAttr(name: string, value: string)
By.testId(value: string)
By.aria(name: string, value: string)
By.title(text: string, opts?: { exact?: boolean })
By.altText(text: string, opts?: { exact?: boolean })
By.placeholder(text: string, opts?: { exact?: boolean })
By.labelText(text: string, opts?: { exact?: boolean })
By.text(text: string, opts?: { caseSensitive?: boolean; trim?: boolean; within?: string })
By.partialText(text: string, opts?: { caseSensitive?: boolean; trim?: boolean; within?: string })
```

Notes:

- Text helpers use XPath and prefer normalized text. Case-insensitive matches use translate().
- Role helpers approximate accessible name via aria-label or element text.
