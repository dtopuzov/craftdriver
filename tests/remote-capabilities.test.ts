/**
 * Pure tests for `buildRemoteCapabilities()` — no browser, no network. Mirrors
 * the intent of `buildLaunchCapabilities()`'s local coverage: remote must
 * never inject anything local-only (download prefs, --headless, binary
 * paths) and must never mutate the caller's capabilities object.
 */
import { describe, it, expect } from 'vitest';
import { buildRemoteCapabilities } from '../src/lib/remote.js';

describe('buildRemoteCapabilities', () => {
  it('passes user capabilities through unchanged and does not mutate the input object', () => {
    const userCapabilities = { 'bstack:options': { os: 'Windows', osVersion: '11' } };
    const frozenCopy = JSON.parse(JSON.stringify(userCapabilities));
    const caps = buildRemoteCapabilities({
      browserName: 'chrome',
      bidiRequested: false,
      userCapabilities,
    });
    expect(userCapabilities).toEqual(frozenCopy);
    expect(caps['bstack:options']).toEqual(frozenCopy['bstack:options']);
  });

  it('sets browserName only when not already present in user capabilities', () => {
    const caps = buildRemoteCapabilities({ browserName: 'firefox', bidiRequested: false });
    expect(caps.browserName).toBe('firefox');

    const capsWithOverride = buildRemoteCapabilities({
      browserName: 'firefox',
      bidiRequested: false,
      userCapabilities: { browserName: 'MicrosoftEdge' },
    });
    expect(capsWithOverride.browserName).toBe('MicrosoftEdge');
  });

  it('requests webSocketUrl and unhandledPromptBehavior only when BiDi is requested', () => {
    const withBidi = buildRemoteCapabilities({ browserName: 'chrome', bidiRequested: true });
    expect(withBidi.webSocketUrl).toBe(true);
    // W3C Classic string form, not the BiDi user-prompt-handler map — a strict
    // remote hub (BrowserStack) rejects the map form on session creation.
    expect(withBidi.unhandledPromptBehavior).toBe('ignore');

    const withoutBidi = buildRemoteCapabilities({ browserName: 'chrome', bidiRequested: false });
    expect(withoutBidi.webSocketUrl).toBeUndefined();
    expect(withoutBidi.unhandledPromptBehavior).toBeUndefined();
  });

  it('keeps an explicit unhandledPromptBehavior and still defaults webSocketUrl on', () => {
    // A caller may override prompt handling with BiDi on; the builder must not
    // clobber it. (webSocketUrl: false with BiDi on is rejected earlier, in
    // resolveLaunchTarget, so the builder never has to preserve that combo.)
    const caps = buildRemoteCapabilities({
      browserName: 'chrome',
      bidiRequested: true,
      userCapabilities: { unhandledPromptBehavior: 'accept' },
    });
    expect(caps.unhandledPromptBehavior).toBe('accept');
    expect(caps.webSocketUrl).toBe(true);
  });

  it('never injects local-only capabilities (goog:chromeOptions, download prefs, --headless)', () => {
    const caps = buildRemoteCapabilities({ browserName: 'chrome', bidiRequested: true });
    expect(caps['goog:chromeOptions']).toBeUndefined();
    expect(caps['moz:firefoxOptions']).toBeUndefined();
  });

  it('round-trips a BrowserStack-shaped bstack:options object byte-for-byte', () => {
    const bstackOptions = {
      os: 'Windows',
      osVersion: '11',
      projectName: 'CraftDriver',
      buildName: 'Remote smoke',
      sessionName: 'Chrome login flow',
      seleniumBidi: true,
    };
    const caps = buildRemoteCapabilities({
      browserName: 'chrome',
      bidiRequested: true,
      userCapabilities: { browserVersion: 'latest', 'bstack:options': bstackOptions },
    });
    expect(caps['bstack:options']).toEqual(bstackOptions);
    expect(caps.browserVersion).toBe('latest');
  });

  it('round-trips BrowserStack real-device capabilities', () => {
    const bstackOptions = {
      deviceName: 'Samsung Galaxy S23',
      osVersion: '13.0',
      realMobile: true,
      projectName: 'Craftdriver',
    };
    const caps = buildRemoteCapabilities({
      browserName: 'chrome',
      bidiRequested: false,
      userCapabilities: { 'bstack:options': bstackOptions },
    });
    expect(caps['bstack:options']).toEqual(bstackOptions);
  });
});
