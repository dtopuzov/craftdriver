# Test Time-Sensitive UI With The Virtual Clock

Debounced search, trial banners, idle logout, and countdowns all force tests to
either sleep (slow, flaky) or never test the timing at all. Install a virtual
clock and you control time directly: advance it to the exact millisecond a timer
should fire, or freeze it on a fixed date. This recipe drives the live
[clock example](https://dtopuzov.github.io/craftdriver/examples/clock.html),
whose search input debounces for 300 ms.

```ts
await browser.clock.install();
await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/clock.html');

await browser.fill('#search-input', 'lap');

await browser.clock.tick(299); // just before the debounce threshold
await browser.expect('#search-count').toHaveText('0');

await browser.clock.tick(2); // crosses 300ms — the search fires exactly once
await browser.expect('#search-count').toHaveText('1');
```

## Fixed Dates

For date-dependent UI, freeze the wall clock before navigation so the page
renders as if it were that moment:

```ts
await browser.clock.setFixedTime('2026-06-15T23:59:00Z');
await browser.navigateTo('https://dtopuzov.github.io/craftdriver/examples/clock.html');

await browser.expect('#trial-banner').toContainText('Trial expires today');
```

## Notes

- `install()` fakes timers so `tick()` advances them deterministically; `uninstall()` restores the real clock.
- `setFixedTime()` freezes `Date.now()` and `new Date()` without touching timers — ideal for date-keyed UI.
- Install the clock before navigation so the page picks up the fake timers on load.

## Learn More

- [Virtual Clock](../clock.md)
- [Network Mocking And Request Waiting](../network.md)
