import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('evaluate()', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${EXAMPLES_BASE_URL}/evaluate.html`);
  });

  it('returns document.title via function form', async () => {
    const title = await browser.evaluate(() => document.title);
    expect(title).toBe('Evaluate Playground');
  });

  it('passes arguments to the function', async () => {
    const result = await browser.evaluate((a, b) => (a as number) + (b as number), 2, 3);
    expect(result).toBe(5);
  });

  it('string form evaluates an expression', async () => {
    const title = await browser.evaluate('return document.title');
    expect(title).toBe('Evaluate Playground');
  });

  it('reads window.__state set by page script', async () => {
    const name = await browser.evaluate(() => (window as any).__state.name);
    expect(name).toBe('craftdriver');
  });

  it('mutations are reflected in subsequent calls', async () => {
    await browser.click('#action-btn');
    const count = await browser.evaluate(() => (window as any).__state.count);
    expect(count).toBe(1);
  });

  it('element.evaluate() receives the DOM element as first arg', async () => {
    const tag = await browser
      .find('#action-btn')
      .evaluate((el) => (el as Element).tagName.toLowerCase());
    expect(tag).toBe('button');
  });

  it('element.evaluate() passes extra args', async () => {
    const has = await browser
      .find('#action-btn')
      .evaluate((el, cls) => (el as Element).classList.contains(cls as string), 'active');
    expect(has).toBe(true);
  });

  it('non-serializable result throws a clear error', async () => {
    // Returning a DOM node is not JSON-serializable via BiDi
    // (Classic executeScript silently coerces — skip that check)
    if (!browser.isBiDiEnabled()) return;
    await expect(browser.evaluate(() => document.body)).rejects.toThrow(
      /not JSON-serializable|node reference/i
    );
  });

  // A Classic-first navigate returns at readyState === 'complete', which is not
  // a barrier the BiDi side respects: an immediately following { context } call
  // can race the realm swap and throw "execution contexts cleared". evaluate()
  // retries that pre-execution error (script never ran). See
  // plans/TODO-bidi-first-navigation.md.
  it('retries past a transient "execution contexts cleared" error', async () => {
    if (!browser.isBiDiEnabled()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = (browser as any).bidiSession.getConnection();
    const original = conn.send.bind(conn);
    let injected = 0;
    conn.send = (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'script.callFunction' && injected === 0) {
        injected++;
        return Promise.reject(new Error('BiDi error [unknown error]: execution contexts cleared'));
      }
      return original(method, params);
    };
    try {
      const title = await browser.evaluate(() => document.title);
      expect(injected).toBe(1); // the error was actually injected
      expect(title).toBe('Evaluate Playground'); // and evaluate() recovered
    } finally {
      conn.send = original;
    }
  });

  it('does not retry a genuine in-script exception', async () => {
    await expect(
      browser.evaluate(() => {
        throw new Error('boom');
      })
    ).rejects.toThrow(/boom/);
  });
});
