# Dialogs

JavaScript dialogs (`alert`, `confirm`, `prompt`, `beforeunload`)
appear as native browser modals — they block the page until the user
or the automation handles them.

> **craftdriver's stance: dialogs block until handled.**
> If a dialog opens and nothing handles it, the action that triggered
> it will time out. This is intentional. Playwright silently
> auto-dismisses unhandled dialogs; craftdriver promotes them to loud
> failures so unexpected dialogs surface as broken tests rather than
> passing tests against a stuck browser.

> **`waitForDialog()` and `onDialog()` require BiDi.** Both are built on
> BiDi's dialog-open event; under Classic WebDriver (`enableBiDi: false`)
> `onDialog()` silently registers a no-op and `waitForDialog()` will simply
> time out rather than error, since Classic has no push notification for
> "a dialog opened." Use the imperative `acceptDialog()` / `dismissDialog()`
> / `getDialogMessage()` API instead if you're running Classic-only.

You handle a dialog one of three ways, depending on the shape of the
test:

| API                       | When to use                                              |
| ------------------------- | -------------------------------------------------------- |
| `browser.waitForDialog()` | One-shot — you know exactly which action triggers it.    |
| `browser.onDialog(...)`   | Persistent — multiple dialogs in a workflow, or "accept all". |
| `browser.acceptDialog()` / `browser.dismissDialog()` | You already raced past the dialog and want to handle whatever is open. |

## `waitForDialog(opts?)` — one-shot wait

Returns a `Promise<Dialog>` that resolves the next time a dialog opens.
Pair it with the triggering action in `Promise.all` so both run
concurrently:

```typescript
// confirm()
const [, dialog] = await Promise.all([
  browser.click('#confirm-btn'),
  browser.waitForDialog(),
]);

console.log(dialog.type());    // 'confirm'
console.log(dialog.message()); // 'Are you sure?'
await dialog.accept();         // continue

// prompt() — pass text to fill the input first
const [, prompt] = await Promise.all([
  browser.click('#prompt-btn'),
  browser.waitForDialog(),
]);
console.log(prompt.defaultValue()); // pre-filled default
await prompt.accept('my answer');

// alert()
const [, alert] = await Promise.all([
  browser.click('#alert-btn'),
  browser.waitForDialog(),
]);
await alert.dismiss();
```

`waitForDialog` rejects with a timeout error if no dialog appears
within `opts.timeout` (default: the browser's default timeout).

## `onDialog(handler)` — persistent handler

Register a handler that fires for **every** dialog until you call the
returned `off()` function. Use it when a workflow triggers multiple
dialogs, or when you want a blanket "accept everything" during a noisy
sequence:

```typescript
const off = browser.onDialog(async (dialog) => {
  await dialog.accept();
});

await runNoisyWorkflow();
off(); // stop listening — subsequent dialogs are loud again
```

`onDialog` does not retroactively handle dialogs that opened before
registration; pair it with `acceptDialog` / `dismissDialog` for those.

## Imperative `acceptDialog` / `dismissDialog`

When you cannot wrap the triggering action in `Promise.all` (e.g.
multiple actions race the dialog, or you handle a dialog inside a
catch block), use the imperative API to act on whichever dialog is
currently open:

```typescript
await browser.acceptDialog();        // click OK
await browser.acceptDialog('value'); // fill a prompt, then accept
await browser.dismissDialog();       // click Cancel / close
const text = await browser.getDialogMessage();
```

`acceptDialog` / `dismissDialog` use BiDi's `handleUserPrompt` when the
browser was launched with BiDi (the default), falling back to the W3C
Classic alert endpoints (`/alert/accept`, `/alert/dismiss`) only when
`enableBiDi: false`. `getDialogMessage` always uses the Classic
`/alert/text` endpoint — BiDi only surfaces the dialog message via the
`userPromptOpened` event, not a query, so there's nothing to query outside
`onDialog`/`waitForDialog`. All four throw if no dialog is currently open.

## `Dialog` interface

| Member                       | Description                                                                |
| ---------------------------- | -------------------------------------------------------------------------- |
| `dialog.type()`              | `'alert'` \| `'confirm'` \| `'prompt'` \| `'beforeunload'`                 |
| `dialog.message()`           | Text shown in the dialog.                                                  |
| `dialog.defaultValue()`      | Pre-filled value for prompts; empty string for other types.                |
| `await dialog.accept(text?)` | Click OK. For prompts, optionally provide the input text first.            |
| `await dialog.dismiss()`     | Click Cancel / close.                                                      |

## Recipes

### Accept everything during a flow

```typescript
const off = browser.onDialog((d) => d.accept());
try {
  await runFlow();
} finally {
  off();
}
```

### Assert on a dialog and dismiss

```typescript
const [, dialog] = await Promise.all([
  browser.click('#delete'),
  browser.waitForDialog(),
]);
expect(dialog.type()).toBe('confirm');
expect(dialog.message()).toContain('cannot be undone');
await dialog.dismiss();
```

### `beforeunload` confirmation

`beforeunload` arrives like any other dialog. Accept it to allow the
navigation, dismiss it to keep the page:

```typescript
const [, dialog] = await Promise.all([
  browser.navigateTo('/somewhere-else'),
  browser.waitForDialog(),
]);
expect(dialog.type()).toBe('beforeunload');
await dialog.accept();
```
