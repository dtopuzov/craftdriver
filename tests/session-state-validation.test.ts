/**
 * Unit tests for the shared session-state validator. Pure logic — no browser.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseSessionState,
  hasNonEmptySessionStorage,
  isSessionStateEmpty,
  nonEmptyOrigins,
  normalizeCookieForRestore,
  isHttpOrigin,
} from '../src/lib/sessionStateValidation';
import { CraftdriverError, ErrorCode } from '../src';

async function expectCode(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(CraftdriverError.is(err, code)).toBe(true);
}

describe('parseSessionState', () => {
  it('accepts a valid state object', async () => {
    const state = await parseSessionState({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cookies: [{ name: 'sid', value: 'x', domain: 'example.com', path: '/' } as any],
      localStorage: { 'https://example.com': { token: 'abc' } },
    });
    expect(state.localStorage!['https://example.com'].token).toBe('abc');
  });

  it('rejects a non-object state (INVALID_ARGUMENT)', async () => {
    await expectCode(parseSessionState(42 as never), ErrorCode.INVALID_ARGUMENT);
    await expectCode(parseSessionState([] as never), ErrorCode.INVALID_ARGUMENT);
    await expectCode(parseSessionState(new Date() as never), ErrorCode.INVALID_ARGUMENT);
  });

  it('rejects an unknown top-level section (UNSUPPORTED)', async () => {
    await expectCode(
      parseSessionState({ localStorage: {}, bogus: 1 } as never),
      ErrorCode.UNSUPPORTED
    );
  });

  it('rejects the legacy origins section (UNSUPPORTED)', async () => {
    await expectCode(parseSessionState({ origins: [] } as never), ErrorCode.UNSUPPORTED);
  });

  it('rejects a non-http(s) origin (INVALID_ARGUMENT)', async () => {
    await expectCode(
      parseSessionState({ localStorage: { 'about:blank': { k: 'v' } } } as never),
      ErrorCode.INVALID_ARGUMENT
    );
    await expectCode(
      parseSessionState({ sessionStorage: { 'https://x/': { k: 'v' } } } as never),
      ErrorCode.INVALID_ARGUMENT
    );
  });

  it('rejects a non-string storage value (INVALID_ARGUMENT)', async () => {
    await expectCode(
      parseSessionState({ localStorage: { 'https://x.com': { k: 1 } } } as never),
      ErrorCode.INVALID_ARGUMENT
    );
  });

  it('rejects a malformed cookie (INVALID_ARGUMENT)', async () => {
    await expectCode(parseSessionState({ cookies: [{ value: 'v' }] } as never), ErrorCode.INVALID_ARGUMENT);
    await expectCode(
      parseSessionState({ cookies: [{ name: 'n', value: 5 }] } as never),
      ErrorCode.INVALID_ARGUMENT
    );
    await expectCode(parseSessionState({ cookies: 'nope' } as never), ErrorCode.INVALID_ARGUMENT);
    await expectCode(
      parseSessionState({ cookies: [{ name: 'n', value: 'v' }] } as never),
      ErrorCode.INVALID_ARGUMENT
    );
    await expectCode(
      parseSessionState({ cookies: [{ name: 'n', value: 'v', domain: 'x.test', path: 1 }] } as never),
      ErrorCode.INVALID_ARGUMENT
    );
    await expectCode(
      parseSessionState({ cookies: [{ name: 'n', value: 'v', domain: 'x.test', secure: 'yes' }] } as never),
      ErrorCode.INVALID_ARGUMENT
    );
    await expectCode(
      parseSessionState({ cookies: [{ name: 'n', value: 'v', domain: 'x.test', sameSite: 'invalid' }] } as never),
      ErrorCode.INVALID_ARGUMENT
    );
    await expectCode(
      parseSessionState({ cookies: [{ name: 'bad name', value: 'v', domain: 'x.test' }] } as never),
      ErrorCode.INVALID_ARGUMENT
    );
    await expectCode(
      parseSessionState({ cookies: [{ name: 'n', value: 'v', domain: 'https://x.test' }] } as never),
      ErrorCode.INVALID_ARGUMENT
    );
  });

  it('adds storage-state metadata without exposing values', async () => {
    let err: unknown;
    try {
      await parseSessionState(
        { localStorage: { 'https://x.test': { password: 42 } } } as never,
        { operation: 'test.restore', browserName: 'chrome', protocol: 'bidi' }
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CraftdriverError);
    expect((err as CraftdriverError).detail).toMatchObject({
      feature: 'storageState',
      operation: 'test.restore',
      browserName: 'chrome',
      protocol: 'bidi',
      phase: 'validation',
    });
    expect(JSON.stringify(err)).not.toContain('password');
  });

  it('normalizes reloadable cookie edge cases consistently', () => {
    expect(normalizeCookieForRestore({
      name: 'sid', value: 'x', domain: 'x.test', sameSite: 'none', secure: false,
    })).toEqual({ name: 'sid', value: 'x', domain: 'x.test', secure: false });
    expect(normalizeCookieForRestore({
      name: 'sid', value: 'x', domain: 'x.test', sameSite: 'default', secure: true,
    })).toEqual({ name: 'sid', value: 'x', domain: 'x.test', secure: true });
  });

  it('reads and validates a state file, rejecting bad JSON and missing files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cd-val-'));
    try {
      const good = path.join(dir, 'good.json');
      await fs.writeFile(good, JSON.stringify({ localStorage: { 'https://x.com': { a: 'b' } } }));
      const state = await parseSessionState(good);
      expect(state.localStorage!['https://x.com'].a).toBe('b');

      const bad = path.join(dir, 'bad.json');
      await fs.writeFile(bad, '{not json');
      await expectCode(parseSessionState(bad), ErrorCode.INVALID_ARGUMENT);

      await expectCode(parseSessionState(path.join(dir, 'missing.json')), ErrorCode.INVALID_ARGUMENT);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('helpers detect non-empty sessionStorage and origins', () => {
    expect(hasNonEmptySessionStorage({ sessionStorage: { 'https://x.com': { k: 'v' } } })).toBe(true);
    expect(hasNonEmptySessionStorage({ sessionStorage: { 'https://x.com': {} } })).toBe(false);
    expect(hasNonEmptySessionStorage({})).toBe(false);
    expect(nonEmptyOrigins({ 'https://a.com': { k: 'v' }, 'https://b.com': {} })).toEqual([
      'https://a.com',
    ]);
    expect(isHttpOrigin('https://x.com')).toBe(true);
    expect(isHttpOrigin('http://127.0.0.1:8080')).toBe(true);
    expect(isHttpOrigin('about:blank')).toBe(false);
    expect(isHttpOrigin('https://x.com/')).toBe(false);
    expect(isSessionStateEmpty({})).toBe(true);
    expect(isSessionStateEmpty({ cookies: [], localStorage: {}, sessionStorage: {} })).toBe(true);
    expect(isSessionStateEmpty({ localStorage: { 'https://x.com': { k: 'v' } } })).toBe(false);
  });
});
