import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { Browser } from '../src';
import { EXAMPLES_BASE_URL, BROWSER_NAME } from './utils';

describe('Iframes', () => {
  let browser: Browser;
  const baseUrl = EXAMPLES_BASE_URL;

  beforeAll(async () => {
    browser = await Browser.launch({ browserName: BROWSER_NAME });
  });

  afterAll(async () => {
    await browser.quit();
  });

  beforeEach(async () => {
    await browser.navigateTo(`${baseUrl}/iframes.html`);
  });

  it('can click a button inside an iframe', async () => {
    const frame = await browser.frame('#my-frame');
    await frame.click('#child-btn');
    await frame.expect('#child-result').toHaveText('clicked');
  });

  it('can fill an input inside an iframe', async () => {
    const frame = await browser.frame('#my-frame');
    await frame.fill('#child-input', 'hello from test');
    await frame.expect('#child-value').toHaveText('hello from test');
  });

  it('can read text from an element inside an iframe', async () => {
    const frame = await browser.frame('#my-frame');
    const handle = frame.find('h2');
    const text = await handle.text();
    expect(text).toBe('Child Frame');
  });

  it('returns all iframes via browser.frames()', async () => {
    const frames = await browser.frames();
    expect(frames.length).toBeGreaterThanOrEqual(1);
  });

  it('can evaluate JavaScript inside a frame', async () => {
    const frame = await browser.frame('#my-frame');
    const result = await frame.evaluate(() => document.title);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('retries a transient realm swap while evaluating inside a frame', async () => {
    if (!browser.isBiDiEnabled()) return;
    const frame = await browser.frame('#my-frame');
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
      expect(await frame.evaluate(() => document.title)).toBe('Iframe Child Page');
      expect(injected).toBe(1);
    } finally {
      conn.send = original;
    }
  });

  it('can use frame.locator() to interact with elements', async () => {
    const frame = await browser.frame('#my-frame');
    await frame.locator('#child-btn').click();
    await frame.locator('#child-result').expect().toHaveText('clicked');
  });

  it('frame.findAll() handles stay bound to the frame after the call returns', async () => {
    // Regression: findAll() used to return snapshot handles with no context
    // switcher, so a later .text()/.click() on them ran against whatever
    // context happened to be active by then instead of switching back into
    // the iframe.
    const frame = await browser.frame('#my-frame');
    const handles = await frame.findAll('h2');
    expect(handles.length).toBe(1);
    expect(await handles[0].text()).toBe('Child Frame');
  });

  it('nested frame.locator(...).locator(...) resolves inside the frame', async () => {
    // Regression: a child Locator created via .locator() didn't inherit its
    // parent's context switcher, so the nested lookup ran outside the frame
    // and never found the element.
    const frame = await browser.frame('#my-frame');
    await frame.locator('body').locator('#child-btn').click();
    await frame.locator('#child-result').expect().toHaveText('clicked');
  });

  it('keeps frame context active across a shadow-root query and action', async () => {
    const frame = await browser.frame('#my-frame');
    const root = frame.locator('#frame-widget').shadowRoot();

    await root.getByRole('button', { name: 'Shadow frame action' }).click();
    await frame.expect('#child-result').toHaveText('shadow-clicked');
  });
});
