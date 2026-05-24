# Virtual Clock

Test idle timeouts, trial expirations, and debounced inputs without `sleep()`.

## Why you need this

Three tests that are impossible — or flaky at best — without clock control:

1. **Auto-logout after 15 minutes idle.** Without clock control you either
   wait 15 real minutes in CI, or stub `Date` inside the app code (the test no
   longer reflects production). With it: jump 15 min, assert the login modal.

2. **Trial banner that flips at midnight.** Assert both "expires today" before
   midnight and "expired" right after, in the same CI run, deterministically.

3. **Debounced search input.** Advance exactly 299 ms (no request), then 2 ms
   more (exactly one request). No `setTimeout(400)` flake.

---

## Quick-start examples

### 1 — Idle logout after 15 minutes

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch();
await browser.clock.install({ time: '2026-01-01T09:00:00Z' });
await browser.navigateTo('http://localhost:3000/dashboard');
await browser.clock.fastForward('15:01');
await browser.expect('#login-modal').toBeVisible();
await browser.quit();
```

### 2 — Trial banner flipping at midnight

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch();

// Before midnight — banner says "expires today"
await browser.clock.setFixedTime('2026-06-15T23:59:00Z');
await browser.navigateTo('http://localhost:3000/billing');
await browser.expect('#trial-banner').toContainText('expires today');

// After midnight — banner says "expired"
await browser.clock.setFixedTime('2026-06-16T00:00:01Z');
await browser.reload();
await browser.expect('#trial-banner').toContainText('expired');

await browser.quit();
```

### 3 — Debounced search input

```ts
import { Browser } from 'craftdriver';

const browser = await Browser.launch();
await browser.clock.install();
await browser.navigateTo('http://localhost:3000/search');
await browser.fill('#q', 'lap');

await browser.clock.tick(299); // debounce hasn't fired yet
// assert: no /search network request

await browser.clock.tick(2);  // total 301 ms — debounce fires
// assert: exactly one /search?q=lap request

await browser.quit();
```

---

## Method reference

| Method | When to use |
|--------|-------------|
| `clock.install(opts?)` | Full fake-timer suite: `Date`, `performance.now`, `setTimeout`, `setInterval`, `rAF`. Use when you need `tick()`. |
| `clock.uninstall()` | Restore real globals and remove the preload script. |
| `clock.tick(ms)` | Advance virtual time by `ms` milliseconds and fire all due timers. |
| `clock.fastForward(duration)` | Like `tick()` but also accepts `"MM:SS"` / `"HH:MM:SS"` strings. |
| `clock.setFixedTime(time)` | Freeze `Date.now()` at a point in time. Does **not** fake timers. |
| `clock.setSystemTime(time)` | Move the virtual clock to `time` without firing timers. Requires `install()`. |
| `clock.runFor(ms)` | Like `tick()` but yields between frames so async/microtask callbacks resolve. |

### `clock.install(options?)`

```ts
await browser.clock.install();
await browser.clock.install({ time: '2026-01-01T09:00:00Z' });
await browser.clock.install({ time: 1_735_689_600_000 });   // ms since epoch
await browser.clock.install({ time: new Date('2026-01-01') });
```

Installs fake implementations of:
- `Date` constructor and `Date.now()`
- `performance.now()`
- `setTimeout` / `clearTimeout`
- `setInterval` / `clearInterval`
- `requestAnimationFrame` / `cancelAnimationFrame`

Timers only fire when you explicitly call `tick()`, `fastForward()`, or
`runFor()`. Also registers a **preload script** so the fake clock is
automatically re-installed on every subsequent navigation for the duration of
the browser session.

**`time`** defaults to the real current time (`Date.now()`) if omitted.

### `clock.uninstall()`

```ts
await browser.clock.uninstall();
```

Restores `Date`, `setTimeout`, `setInterval`, and all other faked globals to
their originals.  Removes the preload script so future navigations use the real
clock again.

### `clock.tick(ms)`

```ts
await browser.clock.tick(500);   // advance 500 ms
await browser.clock.tick(0);     // flush zero-delay timers
```

Advances the virtual clock by `ms` milliseconds. Every timer whose deadline
falls within the window is fired in order.  `setInterval` timers reschedule
themselves automatically.

Requires `install()`.

### `clock.fastForward(duration)`

```ts
await browser.clock.fastForward(60_000);    // 60 seconds
await browser.clock.fastForward('15:00');   // 15 minutes
await browser.clock.fastForward('01:30:00'); // 1 hour 30 minutes
```

Same as `tick()` but accepts a human-readable duration string.

- **`"MM:SS"`** — minutes and seconds (numbers can exceed 59: `"90:00"` = 90 min)
- **`"HH:MM:SS"`** — hours, minutes, seconds

Requires `install()`.

### `clock.setFixedTime(time)`

```ts
await browser.clock.setFixedTime('2026-06-15T23:59:00Z');
await browser.clock.setFixedTime(1_750_032_540_000);
await browser.clock.setFixedTime(new Date('2026-06-15T23:59:00Z'));
```

Freezes `Date.now()` and `new Date()` at the given instant.  Does **not**
install fake `setTimeout` or `setInterval` — real timers continue to fire.

Use this for simple date-dependent rendering where you don't need to control
timer execution.

Also registers a preload script so the fixed date persists across navigations.

### `clock.setSystemTime(time)`

```ts
await browser.clock.install({ time: 0 });
await browser.clock.setSystemTime(Date.UTC(2026, 5, 16)); // jump to 2026-06-16
await browser.clock.tick(1000); // continue from here
```

Moves the virtual clock to `time` without advancing the timer queue or firing
any callbacks.  Subsequent `tick()` calls continue from the new position.

Requires `install()`.

### `clock.runFor(ms)`

```ts
await browser.clock.runFor(1000);
```

Like `tick()` but yields between each ~16 ms frame so that microtask callbacks
(e.g. `Promise.then()` chained to a timer) resolve in the correct order before
the next frame is processed.

Requires `install()`.

---

## Accepted time formats

All methods that take a `time` argument accept:

| Type | Example | Notes |
|------|---------|-------|
| `number` | `1_750_032_540_000` | Milliseconds since Unix epoch |
| `string` | `'2026-06-15T23:59:00Z'` | Anything `new Date(string)` accepts |
| `Date` | `new Date('2026-01-01')` | Used as-is |

`fastForward` additionally accepts a **duration** string (`"MM:SS"` or
`"HH:MM:SS"`), not an absolute point in time.

---

## Gotchas

### What is and isn't faked

After `install()`:

| Faked ✓ | Not faked ✗ |
|---------|------------|
| `Date.now()` | `Date.prototype.toLocaleString` formatting |
| `new Date()` with no args | `Intl.DateTimeFormat` time zone offsets |
| `performance.now()` | Real network request timing |
| `setTimeout` / `clearTimeout` | `Worker` timers |
| `setInterval` / `clearInterval` | `SharedWorker` / `ServiceWorker` timers |
| `requestAnimationFrame` | CSS animation timing |

After `setFixedTime()` only `Date.now()`, `new Date()`, and `performance.now()`
are affected. All timers use real wall time.

### Navigation

Both `install()` and `setFixedTime()` register a BiDi preload script that
re-applies the fake clock automatically on every navigation.  You don't need to
call them again after `navigateTo()` or `reload()`.

`uninstall()` removes the preload script.  After uninstalling, future
navigations use the real clock.

### Interaction with real network requests

Clock control affects only in-page JavaScript.  Real HTTP requests still run at
wall-clock speed.  If your test asserts on a network response, make sure the
request is made (i.e. a timer fires and calls `fetch()`) before asserting on the
response.

### install() is idempotent

Calling `install()` a second time resets the virtual time and the timer queue.
Any timers registered before the second `install()` are discarded.
