/**
 * Virtual clock control — freeze, advance, or override the wall clock the
 * page sees: Date.now, new Date(), performance.now, setTimeout, setInterval,
 * requestAnimationFrame.
 */

/** Accepted forms for a point in time. */
export type ClockTime = number | string | Date;

/** Options for {@link Clock.install}. */
export interface ClockInstallOptions {
  /** Initial wall-clock time. Defaults to the real current time. */
  time?: ClockTime;
}

/**
 * Minimal slice of Browser that Clock needs.
 * Browser satisfies this interface structurally; no import of Browser needed.
 */
interface ClockAdapter {
  evaluate<T = unknown>(
    fn: (((...args: unknown[]) => T) | string),
    ...args: unknown[]
  ): Promise<T>;
  addInitScript(
    src: string
  ): Promise<{ remove(): Promise<void> }>;
}

// ---------------------------------------------------------------------------
// Fake-timer shim — injected into the page via addInitScript
// ---------------------------------------------------------------------------
//
// The shim:
//   • Captures real globals once (at controller-creation time).
//   • Exposes window.__craftdriverClock__ with install / uninstall / tick /
//     setFixedTime / setSystemTime / runFor.
//   • The controller-creation block is guarded by an existence check so that
//     re-evaluating the script on the same document doesn't re-capture
//     already-faked globals.
//   • Uses only ES5-compatible syntax so it works in every modern browser
//     without transpilation.
// ---------------------------------------------------------------------------
const SHIM_SETUP = `(function() {
  if (window.__craftdriverClock__) return;

  var originals = {
    Date: window.Date,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    performanceNow: (window.performance && typeof window.performance.now === 'function')
      ? window.performance.now.bind(window.performance)
      : null,
    requestAnimationFrame: typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame.bind(window)
      : null,
    cancelAnimationFrame: typeof window.cancelAnimationFrame === 'function'
      ? window.cancelAnimationFrame.bind(window)
      : null,
  };

  var state = {
    installed: false,
    fixedMode: false,
    fixedTime: 0,
    virtualNow: 0,
    performanceOrigin: 0,
    timers: [],
    nextId: 1,
  };

  function fakeNow() {
    if (state.fixedMode) return state.fixedTime;
    return state.virtualNow;
  }

  function patchDate() {
    var OrigDate = originals.Date;
    function FakeDate() {
      var t;
      if (arguments.length === 0) {
        t = new OrigDate(fakeNow());
      } else if (arguments.length === 1) {
        t = new OrigDate(arguments[0]);
      } else if (arguments.length === 2) {
        t = new OrigDate(arguments[0], arguments[1]);
      } else if (arguments.length === 3) {
        t = new OrigDate(arguments[0], arguments[1], arguments[2]);
      } else if (arguments.length === 4) {
        t = new OrigDate(arguments[0], arguments[1], arguments[2], arguments[3]);
      } else if (arguments.length === 5) {
        t = new OrigDate(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4]);
      } else if (arguments.length === 6) {
        t = new OrigDate(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5]);
      } else {
        t = new OrigDate(arguments[0], arguments[1], arguments[2], arguments[3], arguments[4], arguments[5], arguments[6]);
      }
      if (!(this instanceof FakeDate)) return t.toString();
      return t;
    }
    FakeDate.now = function() { return fakeNow(); };
    FakeDate.parse = OrigDate.parse.bind(OrigDate);
    FakeDate.UTC = OrigDate.UTC.bind(OrigDate);
    Object.setPrototypeOf(FakeDate, OrigDate);
    FakeDate.prototype = OrigDate.prototype;
    window.Date = FakeDate;
  }

  function runTimers(targetTime) {
    while (true) {
      var earliest = null;
      for (var i = 0; i < state.timers.length; i++) {
        var t = state.timers[i];
        if (!t.cancelled && t.deadline <= targetTime) {
          if (!earliest || t.deadline < earliest.deadline ||
              (t.deadline === earliest.deadline && t.id < earliest.id)) {
            earliest = t;
          }
        }
      }
      if (!earliest) break;

      state.virtualNow = earliest.deadline;

      if (earliest.interval !== null) {
        earliest.deadline += earliest.interval;
      } else {
        var idx = state.timers.indexOf(earliest);
        if (idx !== -1) state.timers.splice(idx, 1);
      }

      try {
        if (typeof earliest.fn === 'function') {
          earliest.fn.apply(null, earliest.args || []);
        } else if (typeof earliest.fn === 'string') {
          // setTimeout(codeString, ...) form
          // eslint-disable-next-line no-new-func
          new Function(earliest.fn)();
        }
      } catch (_e) { /* swallow timer errors */ }
    }
    state.virtualNow = targetTime;
  }

  var controller = {
    install: function(opts) {
      opts = opts || {};
      var startTime = (opts.time != null) ? opts.time : originals.Date.now();
      state.installed = true;
      state.fixedMode = false;
      state.virtualNow = startTime;
      state.performanceOrigin = startTime;
      state.timers = [];
      state.nextId = 1;

      patchDate();

      if (window.performance && typeof window.performance.now === 'function') {
        window.performance.now = function() {
          return state.virtualNow - state.performanceOrigin;
        };
      }

      window.setTimeout = function(fn, delay) {
        var args = [];
        for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
        var id = state.nextId++;
        var d = (delay == null || isNaN(+delay) || +delay < 0) ? 0 : +delay;
        state.timers.push({ id: id, deadline: state.virtualNow + d, fn: fn, args: args, interval: null, cancelled: false });
        return id;
      };

      window.clearTimeout = function(id) {
        for (var i = 0; i < state.timers.length; i++) {
          if (state.timers[i].id === id) { state.timers[i].cancelled = true; return; }
        }
      };

      window.setInterval = function(fn, delay) {
        var args = [];
        for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
        var id = state.nextId++;
        var d = (delay == null || isNaN(+delay) || +delay < 0) ? 0 : +delay;
        state.timers.push({ id: id, deadline: state.virtualNow + d, fn: fn, args: args, interval: d, cancelled: false });
        return id;
      };

      window.clearInterval = function(id) {
        for (var i = 0; i < state.timers.length; i++) {
          if (state.timers[i].id === id) { state.timers[i].cancelled = true; return; }
        }
      };

      if (originals.requestAnimationFrame) {
        window.requestAnimationFrame = function(fn) { return window.setTimeout(fn, 16); };
        window.cancelAnimationFrame = function(id) { window.clearTimeout(id); };
      }
    },

    uninstall: function() {
      if (!state.installed && !state.fixedMode) return;
      window.Date = originals.Date;
      if (window.performance && originals.performanceNow) {
        window.performance.now = originals.performanceNow;
      }
      window.setTimeout = originals.setTimeout;
      window.clearTimeout = originals.clearTimeout;
      window.setInterval = originals.setInterval;
      window.clearInterval = originals.clearInterval;
      if (originals.requestAnimationFrame) {
        window.requestAnimationFrame = originals.requestAnimationFrame;
        window.cancelAnimationFrame = originals.cancelAnimationFrame;
      }
      state.installed = false;
      state.fixedMode = false;
      state.timers = [];
    },

    tick: function(ms) {
      if (!state.installed) throw new Error('[craftdriver clock] tick() requires install() first');
      runTimers(state.virtualNow + ms);
    },

    setFixedTime: function(time) {
      state.fixedMode = true;
      state.fixedTime = time;
      patchDate();
      if (window.performance && typeof window.performance.now === 'function') {
        window.performance.now = function() { return 0; };
      }
    },

    setSystemTime: function(time) {
      if (!state.installed) throw new Error('[craftdriver clock] setSystemTime() requires install() first');
      var delta = time - state.virtualNow;
      state.virtualNow = time;
      // Shift all pending timer deadlines by the same amount so they remain
      // at the same relative distance from the new "now".
      for (var i = 0; i < state.timers.length; i++) {
        if (!state.timers[i].cancelled) {
          state.timers[i].deadline += delta;
        }
      }
    },

    runFor: function(ms) {
      if (!state.installed) throw new Error('[craftdriver clock] runFor() requires install() first');
      var target = state.virtualNow + ms;
      while (state.virtualNow < target) {
        var next = Math.min(state.virtualNow + 16, target);
        runTimers(next);
      }
    },
  };

  window.__craftdriverClock__ = controller;
})();`;

// ---------------------------------------------------------------------------
// Node-side Clock class
// ---------------------------------------------------------------------------

/** Controls the virtual clock inside the browser page. */
export class Clock {
  private _preloadHandle: { remove(): Promise<void> } | null = null;

  constructor(private readonly adapter: ClockAdapter) { }

  // ── Time helpers ──────────────────────────────────────────────────────────

  private parseTime(time: ClockTime): number {
    if (typeof time === 'number') return time;
    if (time instanceof Date) return time.getTime();
    const ms = new Date(time).getTime();
    if (isNaN(ms)) {
      throw new Error(
        `clock: cannot parse time "${String(time)}". ` +
        'Pass a number (ms since epoch), a Date object, or an ISO date string ' +
        'like "2026-01-01T00:00:00Z".'
      );
    }
    return ms;
  }

  /**
   * Parse a duration string "MM:SS" or "HH:MM:SS" (numbers can exceed
   * 59, e.g. "90:00" = 90 minutes).  A plain number is returned as-is.
   */
  private parseDuration(d: number | string): number {
    if (typeof d === 'number') return d;
    const parts = d.split(':').map(Number);
    if (parts.some(isNaN)) {
      throw new Error(
        `clock.fastForward: cannot parse duration "${d}". ` +
        'Pass a number (ms), "MM:SS", or "HH:MM:SS".'
      );
    }
    if (parts.length === 2) {
      const [mm, ss] = parts;
      return (mm * 60 + ss) * 1000;
    }
    if (parts.length === 3) {
      const [hh, mm, ss] = parts;
      return (hh * 3600 + mm * 60 + ss) * 1000;
    }
    throw new Error(
      `clock.fastForward: cannot parse duration "${d}". ` +
      'Pass a number (ms), "MM:SS", or "HH:MM:SS".'
    );
  }

  // ── Preload script management ──────────────────────────────────────────────

  private async registerPreload(methodCall: string): Promise<void> {
    if (this._preloadHandle) {
      await this._preloadHandle.remove();
      this._preloadHandle = null;
    }
    const script = `${SHIM_SETUP}\nwindow.__craftdriverClock__.${methodCall};`;
    this._preloadHandle = await this.adapter.addInitScript(script);
  }

  /**
   * Evaluate the shim + method call in the current document, ignoring errors
   * that occur when no page is loaded yet (about:blank / no context).
   */
  private async applyNow(methodCall: string): Promise<void> {
    const script = `${SHIM_SETUP}\nwindow.__craftdriverClock__.${methodCall}`;
    try {
      await this.adapter.evaluate(script);
    } catch {
      // No document loaded yet — the preload script will handle it on next navigate.
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Install fake timers in the browser page.
   *
   * Patches `Date`, `performance.now`, `setTimeout`, `setInterval`,
   * `clearTimeout`, `clearInterval`, `requestAnimationFrame`, and
   * `cancelAnimationFrame`.  Timers only fire when you call `tick()`,
   * `fastForward()`, or `runFor()`.
   *
   * Also registers a preload script so the fake clock is re-installed
   * automatically on every subsequent navigation.
   *
   * @example
   * await browser.clock.install({ time: '2026-01-01T09:00:00Z' });
   * await browser.navigateTo('/dashboard');
   * await browser.clock.fastForward('15:01');
   */
  async install(options?: ClockInstallOptions): Promise<void> {
    const timeMs = options?.time !== undefined ? this.parseTime(options.time) : Date.now();
    const methodCall = `install({time: ${timeMs}})`;
    await this.registerPreload(methodCall);
    await this.applyNow(methodCall);
  }

  /**
   * Uninstall fake timers and restore the real `Date`, `setTimeout`, etc.
   * Also removes the preload script so navigations use the real clock again.
   */
  async uninstall(): Promise<void> {
    if (this._preloadHandle) {
      await this._preloadHandle.remove();
      this._preloadHandle = null;
    }
    await this.applyNow('uninstall()');
  }

  /**
   * Advance the fake clock by `ms` milliseconds and fire all timers that
   * come due within that window.
   *
   * Requires `install()` to have been called first.
   */
  async tick(ms: number): Promise<void> {
    await this.adapter.evaluate(`window.__craftdriverClock__.tick(${ms})`);
  }

  /**
   * Advance the fake clock and fire due timers.
   * Accepts a number of milliseconds **or** a duration string:
   * `"MM:SS"` (e.g. `"15:01"` = 15 min 1 s) or `"HH:MM:SS"`.
   *
   * Requires `install()` to have been called first.
   *
   * @example
   * await browser.clock.fastForward('15:01'); // advance 15 minutes 1 second
   * await browser.clock.fastForward(60_000);  // advance 60 seconds
   */
  async fastForward(duration: number | string): Promise<void> {
    const ms = this.parseDuration(duration);
    await this.tick(ms);
  }

  /**
   * Freeze `Date.now()` / `new Date()` at the given instant.
   *
   * Unlike `install()`, this does **not** fake `setTimeout` or `setInterval`;
   * real timers continue to fire.  Use this when you only need to control
   * what "now" is for date-based rendering.
   *
   * Also registers a preload script so the fixed date persists across
   * navigations.
   *
   * @example
   * await browser.clock.setFixedTime('2026-06-15T23:59:00Z');
   * await browser.navigateTo('/billing');
   * await browser.expect('#trial-banner').toContainText('expires today');
   */
  async setFixedTime(time: ClockTime): Promise<void> {
    const ms = this.parseTime(time);
    const methodCall = `setFixedTime(${ms})`;
    await this.registerPreload(methodCall);
    await this.applyNow(methodCall);
  }

  /**
   * Move the fake clock to `time` without advancing the timer queue.
   * Timers that were scheduled continue to fire at their original
   * relative offsets from the new base time when you call `tick()`.
   *
   * Requires `install()` to have been called first.
   */
  async setSystemTime(time: ClockTime): Promise<void> {
    const ms = this.parseTime(time);
    await this.adapter.evaluate(`window.__craftdriverClock__.setSystemTime(${ms})`);
  }

  /**
   * Advance the fake clock by `ms` milliseconds, yielding between each
   * ~16 ms frame so that microtasks and promise callbacks resolve in the
   * correct order.
   *
   * Requires `install()` to have been called first.
   */
  async runFor(ms: number): Promise<void> {
    await this.adapter.evaluate(`window.__craftdriverClock__.runFor(${ms})`);
  }
}
